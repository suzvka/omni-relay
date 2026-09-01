import { scanGlueMeta } from './markers';
import { GlueError, RegistrationError } from './errors';
import { parseManifest, readManifest } from './manifest';
import type { Manifest, ManifestInput } from './manifest';
import { Relay } from './relay';
import type { PipelineDeps, RegisteredCard } from './pipeline';
import { SourceRegistry } from '../source/registry';
import type {
  AuditEntry,
  CardSummary,
  ControllerHooks,
  InspectSourceCardView,
  InspectView,
  Logger,
  PolicyInput,
  RelayCard,
  RelayControllerOptions,
  ResolvedPolicy,
  SourceCard,
  SourceCardRef,
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

interface SourceCardEntry {
  sourceCard: SourceCard;
  manifest: Manifest;
}

/**
 * 控制面:卡片生命周期、源站卡片注册、源站绑定、配置注入、策略覆盖、控制面操作审计。
 * 服务目录为 name → current(每名字仅一份),服务面每次 handle 实时解析 → 原子切换,
 * in-flight 请求持旧版本引用跑完。
 * 回滚语义:框架不留存版本史(历史是卡片开发者/宿主制品层的责任);注册链以版本比较
 * 做门禁——同名同版本拒绝,低于 current 默认拒绝(防误发旧版),显式声明回滚意图
 * (opts.rollback)方可重发旧版制品原子替换(无下线窗口)。`deregisterCard` = 退役。
 */
export class RelayController {
  readonly #registry = new SourceRegistry();
  /** 服务目录:当前服务版本(name → entry);制品历史由宿主制品层留存,框架不留 */
  readonly #cards = new Map<string, CatalogEntry>();
  readonly #sourceCards = new Map<string, SourceCardEntry>();
  readonly #configs = new Map<string, Record<string, unknown>>();
  readonly #policies = new Map<string, PolicyInput>();
  readonly #audit: AuditEntry[] = [];
  readonly #hooks: ControllerHooks | undefined;
  readonly #logger: Logger;
  readonly #defaultTimeoutMs: number;

  constructor(opts: RelayControllerOptions = {}) {
    this.#hooks = opts.hooks;
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
   * ① manifest 合法性 → ② manifest↔代码一致性 → ③ 引用的源站卡片已注册且物理绑定就绪 → ⑤ suggests 合法。
   * (第 ④ 步"注入可满足"在 buildRelay 上线门统一把关,注册顺序自由)
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
    if (!sameSet(parsed.requires.sources, card.sourceCardNames)) {
      throw new RegistrationError(
        `manifest.requires.sources(${parsed.requires.sources.join(',')}) 与代码引用的源站卡片(${card.sourceCardNames.join(',')}) 不一致`,
        'manifest:sources',
      );
    }
    if (!sameSet(parsed.requires.injections, card.injectKeys)) {
      throw new RegistrationError(
        `manifest.requires.injections(${parsed.requires.injections.join(',')}) 与代码 inject 字段(${card.injectKeys.join(',')}) 不一致`,
        'manifest:injections',
      );
    }

    // ③ 引用的源站卡片已注册(中心化注册表,按 name@version 精确匹配当前服务版本),且其物理绑定就绪
    for (const srcRef of card.def.sources as readonly SourceCardRef[]) {
      const sc = srcRef.source;
      const scCurrent = this.#sourceCards.get(sc.meta.name);
      if (scCurrent?.manifest.version !== sc.meta.version) {
        throw new RegistrationError(
          `源站卡片未注册: ${sc.meta.name}@${sc.meta.version}(先 registerSourceCard)`,
          'sourceCard:registered',
        );
      }
      if (!this.#registry.has(sc.def.ref)) {
        throw new RegistrationError(
          `源站 ${sc.def.ref} 未绑定物理配置(源站卡片 ${sc.meta.name} 依赖)`,
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
      ...this.#buildRuntime(card, parsed),
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
   * → ③ 物理绑定就绪 → 版本化(同名同版本拒绝,新版本原子替换)。
   */
  registerSourceCard(sc: SourceCard, manifest?: ManifestInput): this {
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

    // 版本化:同名同版本拒绝(在册时),新版本原子替换 current,旧版实体留存版本史
    const history = this.#sourceCardHistory.get(parsed.name) ?? new Map<string, SourceCardEntry>();
    if (history.has(parsed.version)) {
      throw new RegistrationError(
        `源站卡片 ${parsed.name}@${parsed.version} 已注册`,
        'version:duplicate',
      );
    }

    const entry: SourceCardEntry = { sourceCard: sc, manifest: parsed };
    history.set(parsed.version, entry);
    this.#sourceCardHistory.set(parsed.name, history);
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
  // 退役与回滚(版本史留存;移除=回滚,被移除版本可再次注册重新上架)
  // -------------------------------------------------------------------------

  /**
   * 移除业务卡片的某个版本(同步清版本标记)。
   * 移除 current → current 回落至注册序最近的在册版本;全部移除 → 退出服务目录
   * (handle 即 CARD.NOT_FOUND)。in-flight 请求持旧引用跑完,不断服。
   * 注意:已注册的商品卡片内嵌的源站卡片对象不受影响(运行时取内嵌副本),
   * 契约类回滚须下游重新注册方在服务面生效——控制面只治理,不代跑部署。
   */
  deregisterCard(name: string, version: string): this {
    const history = this.#cardHistory.get(name);
    if (!history?.has(version)) {
      throw new RegistrationError(`卡片 ${name}@${version} 未注册`, 'version:unknown');
    }
    history.delete(version);
    if (history.size === 0) {
      this.#cardHistory.delete(name);
      this.#cards.delete(name);
    } else if (this.#cards.get(name)?.manifest.version === version) {
      this.#cards.set(name, [...history.values()][history.size - 1] as CatalogEntry);
    }
    this.#record('deregisterCard', `${name}@${version}`);
    return this;
  }

  /** 移除源站卡片的某个版本;语义与 {@link deregisterCard} 同构 */
  deregisterSourceCard(name: string, version: string): this {
    const history = this.#sourceCardHistory.get(name);
    if (!history?.has(version)) {
      throw new RegistrationError(`源站卡片 ${name}@${version} 未注册`, 'version:unknown');
    }
    history.delete(version);
    if (history.size === 0) {
      this.#sourceCardHistory.delete(name);
      this.#sourceCards.delete(name);
    } else if (this.#sourceCards.get(name)?.manifest.version === version) {
      this.#sourceCards.set(name, [...history.values()][history.size - 1] as SourceCardEntry);
    }
    this.#record('deregisterSourceCard', `${name}@${version}`);
    return this;
  }

  /** 业务卡片版本时间线(注册序;标注 current;未注册过的名字 → GlueError) */
  listCardVersions(name: string): Array<{ version: string; current: boolean }> {
    const history = this.#cardHistory.get(name);
    if (!history) throw GlueError.cardNotFound(name);
    const current = this.#cards.get(name)?.manifest.version;
    return [...history.keys()].map((version) => ({ version, current: version === current }));
  }

  /** 源站卡片版本时间线(语义与 {@link listCardVersions} 同构) */
  listSourceCardVersions(name: string): Array<{ version: string; current: boolean }> {
    const history = this.#sourceCardHistory.get(name);
    if (!history) throw GlueError.cardNotFound(name);
    const current = this.#sourceCards.get(name)?.manifest.version;
    return [...history.keys()].map((version) => ({ version, current: version === current }));
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

  /** 注入字段值(注册期静态;请求期动态数据一律由 toGlue 写入) */
  setRuntimeConfig(cardName: string, config: Record<string, unknown>): this {
    this.#configs.set(cardName, { ...config });
    const current = this.#cards.get(cardName);
    if (current) {
      this.#cards.set(cardName, { ...current, ...this.#buildRuntime(current.card, current.manifest) });
    }
    this.#record('setRuntimeConfig', cardName, { keys: Object.keys(config) });
    return this;
  }

  /** 性能类策略覆盖(审计/屏蔽等安全类策略不在此列) */
  setPolicy(cardName: string, policy: PolicyInput): this {
    this.#policies.set(cardName, { ...policy });
    const current = this.#cards.get(cardName);
    if (current) {
      this.#cards.set(cardName, { ...current, ...this.#buildRuntime(current.card, current.manifest) });
    }
    this.#record('setPolicy', cardName, policy);
    return this;
  }

  // -------------------------------------------------------------------------
  // 服务面产出
  // -------------------------------------------------------------------------

  /** 上线门:所有卡片 inject 字段可满足后才产出 Relay */
  buildRelay(): Relay {
    for (const [name, entry] of this.#cards) {
      const missing = entry.card.injectKeys.filter(
        (k) => !(k in (entry.runtimeConfig ?? {})),
      );
      if (missing.length > 0) {
        throw new RegistrationError(
          `卡片 ${name} 注入字段无法满足: ${missing.join(', ')}(先 setRuntimeConfig)`,
          'inject:satisfied',
        );
      }
    }
    const deps: PipelineDeps = {
      registry: this.#registry,
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
    const { injectKeys, redactKeys } = scanGlueMeta(entry.card.def.glue);
    const sources = (entry.card.def.sources as readonly SourceCardRef[]).map((s) => ({
      id: s.id,
      sourceCard: s.source.meta.name,
      version: s.source.meta.version,
      ref: s.source.def.ref,
      bound: this.#registry.has(s.source.def.ref),
    }));
    return {
      name: entry.manifest.name,
      version: entry.manifest.version,
      fields: Object.keys((entry.card.def.glue as { shape: Record<string, unknown> }).shape).map(
        (field) => ({
          name: field,
          kind: injectKeys.includes(field) ? ('extension' as const) : ('core' as const),
          redact: redactKeys.includes(field),
        }),
      ),
      sources,
      policy: entry.policy,
      manifest: entry.manifest,
    };
  }

  listCards(): CardSummary[] {
    return [...this.#cards.values()].map((e) => ({
      name: e.manifest.name,
      version: e.manifest.version,
      sources: e.card.sourceCardNames,
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

  /** 控制面操作审计(谁在何时注册/变更了什么) */
  getAuditLog(): readonly AuditEntry[] {
    return this.#audit;
  }

  // -------------------------------------------------------------------------

  #buildRuntime(card: RelayCard, manifest: Manifest): { policy: ResolvedPolicy; runtimeConfig: Record<string, unknown> } {
    const override = this.#policies.get(manifest.name);
    const policy: ResolvedPolicy = {
      timeoutMs: override?.timeoutMs ?? manifest.suggests?.timeoutMs,
      retry: override?.retry ?? manifest.suggests?.retry ?? { max: 0, backoff: 'expo' },
      strategy: override?.strategy ?? manifest.suggests?.strategy ?? 'firstSuccess',
    };
    return { policy, runtimeConfig: { ...(this.#configs.get(manifest.name) ?? {}) } };
  }

  #record(action: string, target: string, detail?: unknown): void {
    this.#audit.push({ ts: Date.now(), action, target, detail });
  }
}

function synthesizeManifest(card: RelayCard): Manifest {
  return parseManifest({
    name: card.meta.name,
    version: card.meta.version,
    entry: '(inline)',
    requires: { sources: [...card.sourceCardNames], injections: [...card.injectKeys] },
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
