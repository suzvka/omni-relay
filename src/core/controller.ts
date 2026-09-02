import { GlueError, RegistrationError } from './errors';
import { parseManifest, readManifest } from './manifest';
import type { Manifest, ManifestInput } from './manifest';
import { Relay } from './relay';
import type { PipelineDeps, RegisteredCard, SourceCardEntry } from './pipeline';
import { SourceRegistry } from '../source/registry';
import type {
  CardSummary,
  ControlEvent,
  ControllerHooks,
  InspectSource,
  InspectSourceCardView,
  InspectView,
  Logger,
  PolicyInput,
  RegisterOptions,
  RelayCard,
  RelayControllerOptions,
  ResolvedPolicy,
  SourceCard,
} from './types';

export const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

interface CatalogEntry extends RegisteredCard {
  manifest: Manifest;
}

/**
 * 控制面:卡片注册与卸载、源站卡片注册、源站绑定、配置注入、策略覆盖。
 * 治理动作经 onControlEvent 通知宿主(格式/存储/转发皆宿主事),框架自身不留存。
 * 服务目录为 name → current(每名字仅一份),服务面每次 handle 实时解析 → 原子切换,
 * in-flight 请求持旧版本引用跑完。
 * 回滚语义:框架不留存版本史(历史是卡片开发者/宿主制品层的责任);注册链以版本比较
 * 做门禁——同名同版本拒绝,低于 current 默认拒绝(防误发旧版),显式声明回滚意图
 * (opts.rollback)方可重发旧版制品原子替换(无下线窗口)。`deregisterCard` = 卸载。
 */
export class RelayController {
  readonly #registry = new SourceRegistry();
  /** 服务目录:当前服务版本(name → entry);制品历史由宿主制品层留存,框架不留 */
  readonly #cards = new Map<string, CatalogEntry>();
  readonly #sourceCards = new Map<string, SourceCardEntry>();
  readonly #configs = new Map<string, Record<string, unknown>>();
  readonly #policies = new Map<string, PolicyInput>();
  readonly #onControlEvent: ((event: ControlEvent) => void) | undefined;
  readonly #hooks: ControllerHooks | undefined;
  readonly #logger: Logger;
  readonly #defaultTimeoutMs: number;

  constructor(opts: RelayControllerOptions = {}) {
    this.#hooks = opts.hooks;
    this.#onControlEvent = opts.onControlEvent;
    this.#logger = opts.logger ?? noopLogger;
    this.#defaultTimeoutMs = opts.defaultTimeoutMs ?? 10_000;
  }

  // -------------------------------------------------------------------------
  // 源站
  // -------------------------------------------------------------------------

  /** 专用接口:逻辑 ref → 物理绑定(地址/认证/超时) */
  registerSource(ref: string, binding: Parameters<SourceRegistry['register']>[1]): this {
    this.#registry.register(ref, binding);
    this.#record('registerSource', ref, { baseURL: binding.baseURL, timeoutMs: binding.timeoutMs });
    return this;
  }

  // -------------------------------------------------------------------------
  // 卡片注册(校验链)
  // -------------------------------------------------------------------------

  /**
   * 注册卡片。manifest 可省略(由代码合成);提供时执行交叉校验:
   * ① manifest 合法性(含 suggests 形状,由 ManifestSchema 把关) → ② manifest↔代码一致性
   * → ③ uses 声明的源站卡片已注册且物理绑定就绪 → 版本门禁。
   * (seeds 可满足在 buildRelay 上线门统一把关,注册顺序自由;未声明 uses 的动态 invoke 在调用期把关)
   * 版本门禁:同名同版本拒绝;低于 current 默认拒绝,显式回滚意图({@link RegisterOptions.rollback})放行。
   */
  registerCard(card: RelayCard, manifest?: ManifestInput, opts?: RegisterOptions): this {
    const parsed = manifest ? parseManifest(manifest) : synthesizeManifest(card);

    // ② manifest ↔ 代码一致性
    if (parsed.name !== card.meta.name || parsed.version !== card.meta.version) {
      throw new RegistrationError(
        `manifest(${parsed.name}@${parsed.version}) 与代码(${card.meta.name}@${card.meta.version}) 不一致`,
        'manifest:identity',
      );
    }
    if (!sameSet(parsed.requires.sources, card.uses)) {
      throw new RegistrationError(
        `manifest.requires.sources(${parsed.requires.sources.join(',')}) 与代码 uses(${card.uses.join(',')}) 不一致`,
        'manifest:sources',
      );
    }
    if (!sameSet(parsed.requires.injections, card.seedKeys)) {
      throw new RegistrationError(
        `manifest.requires.injections(${parsed.requires.injections.join(',')}) 与代码 seeds(${card.seedKeys.join(',')}) 不一致`,
        'manifest:injections',
      );
    }

    // ③ uses 声明的源站卡片已注册且物理绑定就绪(声明即 fail-fast;未声明的动态 invoke 在调用期把关)
    for (const useName of card.uses) {
      const scCurrent = this.#sourceCards.get(useName);
      if (!scCurrent) {
        throw new RegistrationError(
          `uses 声明的源站卡片未注册: ${useName}(先 registerSourceCard)`,
          'sourceCard:registered',
        );
      }
      if (!this.#registry.has(scCurrent.sourceCard.def.ref)) {
        throw new RegistrationError(
          `源站 ${scCurrent.sourceCard.def.ref} 未绑定物理配置(源站卡片 ${useName} 依赖)`,
          'source:resolved',
        );
      }
    }

    // 版本门禁:同名同版本拒绝;低于 current 默认拒绝(防误发旧版),
    // 显式回滚意图放行并重发旧版制品,原子替换 current(无下线窗口)。
    const current = this.#cards.get(parsed.name);
    if (current) {
      const cmp = compareSemver(parsed.version, current.manifest.version);
      if (cmp === 0) {
        throw new RegistrationError(
          `卡片 ${parsed.name}@${parsed.version} 已注册`,
          'version:duplicate',
        );
      }
      if (cmp < 0 && !opts?.rollback) {
        throw new RegistrationError(
          `卡片 ${parsed.name}@${parsed.version} 低于当前服务版本 ${current.manifest.version}(回滚重发请声明 opts.rollback)`,
          'version:downgrade',
        );
      }
    }

    const entry: CatalogEntry = {
      card,
      manifest: parsed,
      ...this.#buildRuntime(parsed),
    };
    this.#cards.set(parsed.name, entry);
    this.#record('registerCard', `${parsed.name}@${parsed.version}`);
    return this;
  }

  /** Node 便捷入口:从 manifest 文件注册(entry 动态 import,default 导出须为卡片) */
  async registerCardFromManifest(
    manifestPath: string,
    loader: (entryAbsPath: string) => Promise<RelayCard> = defaultLoader,
  ): Promise<this> {
    const { manifest, dir } = await readManifest(manifestPath);
    const path = await import('node:path');
    const card = await loader(path.resolve(dir, manifest.entry));
    return this.registerCard(card, manifest);
  }

  // -------------------------------------------------------------------------
  // 源站卡片注册(中心化注册表:对接者向框架注册自己的能力)
  // -------------------------------------------------------------------------

  /**
   * 注册源站卡片。校验链:
   * ① manifest 合法性 → ② manifest↔代码一致性(requires.sources 即其物理 ref,源站卡片不支持注入)
   * → ③ 物理绑定就绪 → 版本门禁(同业务卡片:同版本拒绝/旧版需显式回滚意图)。
   */
  registerSourceCard(sc: SourceCard, manifest?: ManifestInput, opts?: RegisterOptions): this {
    const parsed = manifest ? parseManifest(manifest) : synthesizeSourceManifest(sc);

    // ② manifest ↔ 代码一致性
    if (parsed.name !== sc.meta.name || parsed.version !== sc.meta.version) {
      throw new RegistrationError(
        `manifest(${parsed.name}@${parsed.version}) 与源站卡片代码(${sc.meta.name}@${sc.meta.version}) 不一致`,
        'manifest:identity',
      );
    }
    if (!sameSet(parsed.requires.sources, [sc.def.ref])) {
      throw new RegistrationError(
        `manifest.requires.sources(${parsed.requires.sources.join(',')}) 与源站卡片 ref(${sc.def.ref}) 不一致`,
        'manifest:sources',
      );
    }
    if (parsed.requires.injections.length > 0) {
      throw new RegistrationError(
        '源站卡片不支持注入字段(运行时差异由业务卡片 glue 承载)',
        'manifest:injections',
      );
    }

    // ③ 物理绑定就绪
    if (!this.#registry.has(sc.def.ref)) {
      throw new RegistrationError(`源站未注册: ${sc.def.ref}`, 'source:resolved');
    }

    // 版本门禁:语义与业务卡片同构(同版本拒绝;旧版需显式回滚意图,原子替换)
    const current = this.#sourceCards.get(parsed.name);
    if (current) {
      const cmp = compareSemver(parsed.version, current.manifest.version);
      if (cmp === 0) {
        throw new RegistrationError(
          `源站卡片 ${parsed.name}@${parsed.version} 已注册`,
          'version:duplicate',
        );
      }
      if (cmp < 0 && !opts?.rollback) {
        throw new RegistrationError(
          `源站卡片 ${parsed.name}@${parsed.version} 低于当前服务版本 ${current.manifest.version}(回滚重发请声明 opts.rollback)`,
          'version:downgrade',
        );
      }
    }

    const entry: SourceCardEntry = { sourceCard: sc, manifest: parsed };
    this.#sourceCards.set(parsed.name, entry);
    this.#record('registerSourceCard', `${parsed.name}@${parsed.version}`);
    return this;
  }

  /** Node 便捷入口:从 manifest 文件注册源站卡片(entry 动态 import,default 导出须为源站卡片) */
  async registerSourceCardFromManifest(
    manifestPath: string,
    loader: (entryAbsPath: string) => Promise<SourceCard> = defaultSourceLoader,
  ): Promise<this> {
    const { manifest, dir } = await readManifest(manifestPath);
    const path = await import('node:path');
    const sc = await loader(path.resolve(dir, manifest.entry));
    return this.registerSourceCard(sc, manifest);
  }

  // -------------------------------------------------------------------------
  // 卸载(框架不留版本史:回滚=重发旧版制品,见注册链版本门禁)
  // -------------------------------------------------------------------------

  /**
   * 卸载业务卡片:从服务目录移除当前版本(handle 即 CARD.NOT_FOUND)。
   * in-flight 请求持旧引用跑完,不断服。卸载 ≠ 回滚:回滚 = 重发旧版制品
   * (注册时声明 {@link RegisterOptions.rollback});卸载后重新注册同版本制品不受限。
   * 注意:v2 下 collect 经 ctx.invoke 按名动态解析源站卡片,卸载源站卡片后 invoke 即
   * SOURCE_NOT_REGISTERED——不再内嵌副本,依赖是运行时解析的。
   */
  deregisterCard(name: string): this {
    const current = this.#cards.get(name);
    if (!current) {
      throw new RegistrationError(`卡片 ${name} 未注册`, 'card:unknown');
    }
    this.#cards.delete(name);
    this.#record('deregisterCard', `${name}@${current.manifest.version}`);
    return this;
  }

  /** 卸载源站卡片;语义与 {@link deregisterCard} 同构 */
  deregisterSourceCard(name: string): this {
    const current = this.#sourceCards.get(name);
    if (!current) {
      throw new RegistrationError(`源站卡片 ${name} 未注册`, 'sourceCard:unknown');
    }
    this.#sourceCards.delete(name);
    this.#record('deregisterSourceCard', `${name}@${current.manifest.version}`);
    return this;
  }

  /** 物理绑定只读摘要(不含认证材料:auth 只以 hasAuth 布尔呈现) */
  listBindings(): Array<{ ref: string; baseURL: string; timeoutMs?: number; hasAuth: boolean }> {
    return [...this.#registry.list().entries()].map(([ref, b]) => ({
      ref,
      baseURL: b.baseURL,
      ...(b.timeoutMs !== undefined ? { timeoutMs: b.timeoutMs } : {}),
      hasAuth: typeof b.auth === 'function',
    }));
  }

  // -------------------------------------------------------------------------
  // 配置与策略(框架主权:覆盖卡片 suggests)
  // -------------------------------------------------------------------------

  /** seeds 值(注册期静态,并入 IR;请求期动态数据一律由 collect 写入 IR) */
  setRuntimeConfig(cardName: string, config: Record<string, unknown>): this {
    this.#configs.set(cardName, { ...config });
    const current = this.#cards.get(cardName);
    if (current) {
      this.#cards.set(cardName, { ...current, ...this.#buildRuntime(current.manifest) });
    }
    this.#record('setRuntimeConfig', cardName, { keys: Object.keys(config) });
    return this;
  }

  /** 性能类策略覆盖(治理类动作不经此通道) */
  setPolicy(cardName: string, policy: PolicyInput): this {
    this.#policies.set(cardName, { ...policy });
    const current = this.#cards.get(cardName);
    if (current) {
      this.#cards.set(cardName, { ...current, ...this.#buildRuntime(current.manifest) });
    }
    this.#record('setPolicy', cardName, policy);
    return this;
  }

  // -------------------------------------------------------------------------
  // 服务面产出
  // -------------------------------------------------------------------------

  /** 上线门:所有卡片 seeds 存在 + 类型可满足后才产出 Relay(替代每请求的 glue 校验) */
  buildRelay(): Relay {
    for (const [name, entry] of this.#cards) {
      const seeds = entry.card.def.seeds ?? {};
      const config = entry.runtimeConfig ?? {};
      const missing = entry.card.seedKeys.filter((k) => !(k in config));
      if (missing.length > 0) {
        throw new RegistrationError(
          `卡片 ${name} seeds 无法满足: ${missing.join(', ')}(先 setRuntimeConfig)`,
          'seed:satisfied',
        );
      }
      // 类型门:seeds 值来自宿主运行时配置(无编译期类型),上线前一次性校验
      for (const key of entry.card.seedKeys) {
        const parsed = seeds[key]?.safeParse(config[key]);
        if (parsed && !parsed.success) {
          throw new RegistrationError(
            `卡片 ${name} seed ${key} 类型不符: ${parsed.error.message}`,
            'seed:type',
          );
        }
      }
    }
    const deps: PipelineDeps = {
      registry: this.#registry,
      sourceCards: () => this.#sourceCards,
      hooks: this.#hooks,
      logger: this.#logger,
      defaultTimeoutMs: this.#defaultTimeoutMs,
    };
    return new Relay(() => this.#cards, deps);
  }

  // -------------------------------------------------------------------------
  // 视图与审计
  // -------------------------------------------------------------------------

  /** 字段级只读视图(管理界面/审计工具消费) */
  inspectCard(name: string): InspectView {
    const entry = this.#cards.get(name);
    if (!entry) throw GlueError.cardNotFound(name);
    // sources 由 uses 解析(未声明则为空:动态 invoke 无法静态穷举依赖)
    const sources: InspectSource[] = entry.card.uses.flatMap((useName) => {
      const sc = this.#sourceCards.get(useName);
      if (!sc) return [];
      return [
        {
          name: useName,
          version: sc.manifest.version,
          ref: sc.sourceCard.def.ref,
          bound: this.#registry.has(sc.sourceCard.def.ref),
        },
      ];
    });
    return {
      name: entry.manifest.name,
      version: entry.manifest.version,
      // IR 键为请求期动态填充,静态不可穷举;此处仅呈现 seeds(extension)声明
      fields: entry.card.seedKeys.map((field) => ({ name: field, kind: 'extension' as const })),
      sources,
      policy: entry.policy,
      manifest: entry.manifest,
    };
  }

  listCards(): CardSummary[] {
    return [...this.#cards.values()].map((e) => ({
      name: e.manifest.name,
      version: e.manifest.version,
      sources: e.card.uses,
    }));
  }

  /** 源站卡片清单(中心化注册表视图) */
  listSourceCards(): Array<{ name: string; version: string; ref: string }> {
    return [...this.#sourceCards.values()].map((e) => ({
      name: e.manifest.name,
      version: e.manifest.version,
      ref: e.sourceCard.def.ref,
    }));
  }

  /** 源站卡片只读视图:能力契约(output 原子字段)与物理绑定状态 */
  inspectSourceCard(name: string): InspectSourceCardView {
    const entry = this.#sourceCards.get(name);
    if (!entry) throw GlueError.cardNotFound(name);
    const { sourceCard } = entry;
    const shape = (sourceCard.def.output as { shape?: Record<string, unknown> }).shape;
    return {
      name: entry.manifest.name,
      version: entry.manifest.version,
      ref: sourceCard.def.ref,
      bound: this.#registry.has(sourceCard.def.ref),
      outputFields: shape ? Object.keys(shape) : [],
      manifest: entry.manifest,
    };
  }

  // -------------------------------------------------------------------------

  #buildRuntime(manifest: Manifest): { policy: ResolvedPolicy; runtimeConfig: Record<string, unknown> } {
    const override = this.#policies.get(manifest.name);
    const policy: ResolvedPolicy = {
      timeoutMs: override?.timeoutMs ?? manifest.suggests?.timeoutMs,
      retry: override?.retry ?? manifest.suggests?.retry ?? { max: 0, backoff: 'expo' },
    };
    return { policy, runtimeConfig: { ...(this.#configs.get(manifest.name) ?? {}) } };
  }

  #record(action: string, target: string, detail?: unknown): void {
    this.#onControlEvent?.({ action, target, detail });
  }
}

function synthesizeManifest(card: RelayCard): Manifest {
  return parseManifest({
    name: card.meta.name,
    version: card.meta.version,
    entry: '(inline)',
    requires: { sources: [...card.uses], injections: [...card.seedKeys] },
  });
}

function synthesizeSourceManifest(sc: SourceCard): Manifest {
  return parseManifest({
    name: sc.meta.name,
    version: sc.meta.version,
    entry: '(inline)',
    requires: { sources: [sc.def.ref], injections: [] },
  });
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n');
}

/** 简单版本比较:数字段 major.minor.patch 逐段比;同数字段时带预发布标记(-x)视为更低。
 *  构建标记(+x)不参与比较。门禁用途,不追求完整 semver 先决规则 */
function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i] !== pb.nums[i]) return (pa.nums[i] as number) - (pb.nums[i] as number);
  }
  return Number(pb.pre) - Number(pa.pre);
}

function parseSemver(v: string): { nums: number[]; pre: boolean } {
  const withoutBuild = v.split('+')[0] as string;
  const [core, ...rest] = withoutBuild.split('-');
  const nums = (core ?? '').split('.').map((x) => Number(x) || 0);
  while (nums.length < 3) nums.push(0);
  return { nums: nums.slice(0, 3), pre: rest.length > 0 };
}

async function defaultLoader(entryAbsPath: string): Promise<RelayCard> {
  const { pathToFileURL } = await import('node:url');
  const mod = (await import(pathToFileURL(entryAbsPath).href)) as {
    default?: RelayCard;
  } & Partial<RelayCard>;
  const card = mod.default ?? (mod as RelayCard);
  if (!card || typeof (card as RelayCard).def !== 'object' || !(card as RelayCard).meta) {
    throw new RegistrationError(`entry 未导出卡片(default 导出须为 defineCard 产物)`, 'entry:load');
  }
  return card;
}

async function defaultSourceLoader(entryAbsPath: string): Promise<SourceCard> {
  const { pathToFileURL } = await import('node:url');
  const mod = (await import(pathToFileURL(entryAbsPath).href)) as {
    default?: SourceCard;
  } & Partial<SourceCard>;
  const sc = mod.default ?? (mod as SourceCard);
  // ref 是源站卡片 def 的专属字段,借此区分业务卡片产物
  if (!sc || typeof sc.def !== 'object' || typeof (sc.def as { ref?: unknown }).ref !== 'string' || !sc.meta) {
    throw new RegistrationError(
      `entry 未导出源站卡片(default 导出须为 defineSource 产物)`,
      'entry:load',
    );
  }
  return sc;
}
