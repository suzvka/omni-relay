import { GlueError } from './errors';
import { checkAt } from './validate';
import { isReadableStream } from './stream';
import type { Manifest } from './manifest';
import type { SourceRegistry } from '../source/registry';
import { defaultTransport } from '../source/transport';
import type {
  CollectCtx,
  ControllerHooks,
  HandleOptions,
  Logger,
  RawSourceCardDef,
  RelayCard,
  ResolvedPolicy,
  SourceBinding,
  SourceCard,
  TransportResult,
  UpstreamRequest,
} from './types';

/** 卡片在服务目录中的运行时状态(控制面快照产物) */
export interface RegisteredCard {
  card: RelayCard;
  policy: ResolvedPolicy;
  runtimeConfig: Record<string, unknown>;
}

/** 源站卡片注册表条目(中心化注册表:名 → 源站卡片 + manifest) */
export interface SourceCardEntry {
  sourceCard: SourceCard;
  manifest: Manifest;
}

export interface PipelineDeps {
  registry: SourceRegistry;
  /** 源站卡片注册表提供者:invoke 按名解析任意已注册 API 卡片 */
  sourceCards: () => ReadonlyMap<string, SourceCardEntry>;
  hooks?: ControllerHooks;
  logger: Logger;
  defaultTimeoutMs: number;
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 执行一张卡片(v2 命令式双钩子):
 * in① → seeds 并入 IR → [onBusReq] → collect(直读直写 IR + invoke) → respond(只读 IR) → out⑥。
 * IR 贯穿全程;任何一跳失败都收敛为 GlueError 直接抛出。
 */
export async function runCard(
  deps: PipelineDeps,
  entry: RegisteredCard,
  input: unknown,
  opts: HandleOptions = {},
): Promise<unknown> {
  const { card } = entry;
  const def = card.def;
  const strict = opts.strict ?? true;

  // IR:键值对缓存,先并入宿主注册期注入的 seeds 值
  const ir: Record<string, unknown> = { ...(entry.runtimeConfig ?? {}) };

  // ① 入站请求
  const parsedInput = strict ? checkAt('in', def.in, input) : input;

  const ctx: CollectCtx = {
    card: card.meta,
    input: parsedInput,
    ir,
    state: new Map(),
    log: deps.logger,
    signal: opts.signal ?? new AbortController().signal,
    timing: {},
    meta: opts.meta ?? {},
    invoke: (id, given) => invokeSource(deps, entry.policy, ctx, id, given, strict),
  };

  try {
    // 宿主钩子:collect 前读写 IR(注入/屏蔽)
    if (deps.hooks?.onBusReq) await deps.hooks.onBusReq(ctx);

    // collect 接缝:业务过程本身(往 IR 收集填充数据 + 按需 invoke API 卡片)
    const tCollect = now();
    await def.collect(ctx);
    ctx.timing['collect'] = now() - tCollect;

    // respond 接缝:移除 invoke(类型层 + 运行时均不可再调 API 卡片),只读 IR 构筑出参
    const tRespond = now();
    const { invoke: _invoke, ...respondCtx } = ctx;
    const rawOut = await def.respond(respondCtx);
    ctx.timing['respond'] = now() - tRespond;

    return strict ? checkAt('out', def.out, rawOut) : rawOut;
  } catch (e) {
    // 释放已建立但未消费的源站流(切换/聚合中断时防连接悬挂)
    for (const value of Object.values(ir)) {
      if (isReadableStream(value)) value.cancel().catch(() => {});
    }
    throw e;
  }
}

/**
 * 编排原语内核:解析源站卡片 → 执行一次完整源站段 → 产物写入 ir[id] 并返回。
 * given 给定时用显式入参;否则从 IR 按 source.input 取(印证"确保 IR 已填好该 API 所需入参")。
 * 并发安全:内部不写共享 ctx(仅 ir[id] 与 timing[<id>.*] 按键隔离),Promise.all 多路 invoke 互不踩。
 */
async function invokeSource(
  deps: PipelineDeps,
  policy: ResolvedPolicy,
  ctx: CollectCtx,
  id: string,
  given: unknown,
  strict: boolean,
): Promise<unknown> {
  const entry = deps.sourceCards().get(id);
  if (!entry) {
    throw new GlueError({
      code: 'GLUE.CARD.SOURCE_NOT_REGISTERED',
      message: `未注册的 API 卡片: ${id}(先 registerSourceCard)`,
      retryable: false,
      status: 404,
      seam: 'control',
      sourceId: id,
    });
  }
  const srcDef = entry.sourceCard.def;
  const binding = deps.registry.resolve(srcDef.ref);
  if (!binding) {
    throw GlueError.business('SOURCE_UNBOUND', `源站 ${srcDef.ref} 未绑定物理配置`, {
      sourceId: id,
    });
  }

  const t0 = now();
  // 入参:显式 given 优先,否则从 IR 取(过 ▸input 校验;source.input 从 IR 提取所需键)
  const rawInput = given !== undefined ? given : ctx.ir;
  const srcInput = strict ? checkAt('input', srcDef.input, rawInput, id) : rawInput;

  // take → ▸request(源站请求契约是"子集校验":只验不重建)
  const ureq = await srcDef.take(srcInput as never);
  if (strict && srcDef.request) checkAt('request', srcDef.request, ureq, id);

  // transport + 重试 + 业务映射
  const result = await fetchMapped(deps, policy, binding, ureq, ctx.signal, srcDef, id);
  ctx.timing[`${id}.fetch`] = now() - t0;

  // 流式守卫:旁路校验是显式授予的特权,未声明 stream 的源站收到流式响应直接拒绝
  if (result.stream && !srcDef.stream) {
    throw GlueError.business(
      'UPSTREAM_STREAM_UNDECLARED',
      `源站 ${id} 返回流式响应,但源站卡片未声明 stream: true`,
      { sourceId: id },
    );
  }

  // ▸upstreamRes(流式源站惯例声明 z.custom,校验天然通过)→ put → ▸output
  const upstreamData = strict
    ? checkAt('upstreamRes', srcDef.upstreamRes, result.body, id)
    : result.body;
  let product = srcDef.put ? await srcDef.put(upstreamData as never) : upstreamData;
  if (strict) product = checkAt('output', srcDef.output, product, id);

  // 写回 IR(命名空间 by id),触发宿主 onBusRes(带本次 sourceId 的快照)
  ctx.ir[id] = product;
  ctx.timing[`${id}.invoke`] = now() - t0;
  if (deps.hooks?.onBusRes) await deps.hooks.onBusRes({ ...ctx, sourceId: id });
  return product;
}

/** 传输 + 重试 + 业务错误映射;传输错误统一补全 sourceId */
async function fetchMapped(
  deps: PipelineDeps,
  policy: ResolvedPolicy,
  binding: SourceBinding,
  ureq: UpstreamRequest,
  signal: AbortSignal,
  src: RawSourceCardDef<any, any, any, any>,
  srcId: string,
): Promise<TransportResult> {
  const maxRetries = Math.max(0, policy.retry?.max ?? 0);
  const backoff = policy.retry?.backoff ?? 'expo';
  const timeoutMs = policy.timeoutMs ?? binding.timeoutMs ?? deps.defaultTimeoutMs;

  let attempt = 0;
  for (;;) {
    let result: TransportResult;
    try {
      result = await defaultTransport(binding, ureq, { signal, timeoutMs });
    } catch (e) {
      if (e instanceof GlueError && e.retryable && attempt < maxRetries) {
        await sleep(backoff === 'expo' ? 200 * 2 ** attempt : 500);
        attempt++;
        continue;
      }
      if (e instanceof GlueError) {
        throw new GlueError(
          { ...e, sourceId: e.sourceId ?? srcId },
          { cause: e.cause },
        );
      }
      throw e;
    }

    // 业务错误映射(2xx 也可能携带源站错误码;映射后仍可进入重试循环)
    // 流式响应体不可提取错误码(流未消费),跳过 extract;HTTP 状态映射不受影响
    const em = src.errorMap;
    const srcCode = result.stream
      ? undefined
      : em?.extract
        ? em.extract(result.body)
        : undefined;
    const mapped =
      (srcCode != null ? em?.map?.[String(srcCode)] : undefined) ??
      em?.map?.[`HTTP:${result.status}`] ??
      (result.status >= 200 && result.status < 300
        ? undefined
        : em?.fallback ?? 'UPSTREAM_UNKNOWN');
    if (mapped) {
      const bizErr = GlueError.business(
        mapped,
        `源站业务错误(code=${srcCode ?? `HTTP ${result.status}`})`,
        {
          sourceId: srcId,
          raw: result.body,
          retryable: em?.retryableCodes?.includes(mapped) ?? false,
        },
      );
      if (bizErr.retryable && attempt < maxRetries) {
        await sleep(backoff === 'expo' ? 200 * 2 ** attempt : 500);
        attempt++;
        continue;
      }
      throw bizErr;
    }
    return result;
  }
}
