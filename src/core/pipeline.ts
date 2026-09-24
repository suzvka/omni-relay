import { GlueError } from './errors';
import { checkAt } from './validate';
import { isReadableStream } from './stream';
import type { Manifest } from './manifest';
import { defaultTransport } from '../source/transport';
import type {
  CollectCtx,
  ControllerHooks,
  HandleOptions,
  Logger,
  RawSourceCardDef,
  RelayCard,
  ResolvedPolicy,
  RetrySafety,
  SourceBinding,
  SourceCard,
  SourceResolver,
  TransportFn,
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

/** 一次请求(handle)的运行时状态:注册表快照 + 在飞调用守卫 */
interface RequestRuntime {
  /** 请求开始时的源站卡片注册表快照:热升级/卸载对 in-flight 请求不可见 */
  sources: ReadonlyMap<string, SourceCardEntry>;
  /** 本请求内在飞的源站卡片 id(strict 下防同 id 并发互相覆盖 ir[id]) */
  inFlight: Set<string>;
}

export interface PipelineDeps {
  /** 源站解析端口:仅依赖 ref → 物理绑定 的最小查询面 */
  registry: SourceResolver;
  /** 源站卡片注册表提供者:runCard 在请求开始时快照一次,请求内 invoke 解析同一代际 */
  sourceCards: () => ReadonlyMap<string, SourceCardEntry>;
  /** 传输实现注入点(缺省 defaultTransport);重试仍在 pipeline 层与 errorMap 共享循环 */
  transport?: TransportFn;
  hooks?: ControllerHooks;
  logger: Logger;
  defaultTimeoutMs: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 执行一张卡片(命令式双钩子):
 * in① → seeds 并入 IR → [onBusReq] → collect(直读直写 IR + invoke) → respond(只读 IR) → out⑥。
 * IR 贯穿全程;任何一跳失败都收敛为 GlueError 直接抛出。
 * strict(缺省开):源站注册表请求级快照、同 id 并发 invoke 拒绝、respond 前 IR 浅冻结。
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

  // IR:请求级黑板,先并入宿主注册期注入的 seeds 值
  const ir: Record<string, unknown> = { ...(entry.runtimeConfig ?? {}) };

  // 请求级运行时:注册表快照(依赖一致性)+ 在飞守卫(同 id 并发防覆盖)
  const runtime: RequestRuntime = {
    sources: new Map(deps.sourceCards()),
    inFlight: new Set(),
  };

  // ① 入站请求
  const parsedInput = strict ? checkAt('in', def.in, input) : input;

  const ctx: CollectCtx = {
    card: card.meta,
    input: parsedInput,
    ir,
    log: deps.logger,
    signal: opts.signal ?? new AbortController().signal,
    invoke: (id, given) => invokeSource(deps, entry.policy, ctx, runtime, id, given, strict),
  };

  try {
    // 宿主钩子:collect 前读写 IR(注入/屏蔽)
    if (deps.hooks?.onBusReq) await deps.hooks.onBusReq(ctx);

    // collect 接缝:业务过程本身(往 IR 收集填充数据 + 按需 invoke API 卡片)
    await def.collect(ctx);

    // respond 接缝:移除 invoke(类型层 + 运行时均不可再调 API 卡片),只读 IR 构筑出参;
    // strict 下浅冻结 IR:写入立即抛 TypeError,把只读契约从约定升级为运行期保证
    const { invoke: _invoke, ...respondCtx } = ctx;
    if (strict) Object.freeze(ir);
    const rawOut = await def.respond(respondCtx);

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
 * 编排原语内核:从请求级快照解析源站卡片 → 执行一次完整源站段 → 产物写入 ir[id] 并返回。
 * given 给定时用显式入参;否则从 IR 按 source.input 取(印证"确保 IR 已填好该 API 所需入参")。
 * 依赖一致性:注册表在请求开始时快照,热升级/卸载不影响 in-flight 请求。
 * 并发语义:不同 id 天然隔离(按键写 ir);strict 下同 id 并发拒绝,
 * 非 strict 同 id 并发为 ir[id] 后写覆盖(invoke 返回值始终是本次调用结果)。
 */
async function invokeSource(
  deps: PipelineDeps,
  policy: ResolvedPolicy,
  ctx: CollectCtx,
  runtime: RequestRuntime,
  id: string,
  given: unknown,
  strict: boolean,
): Promise<unknown> {
  const entry = runtime.sources.get(id);
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
  if (strict && runtime.inFlight.has(id)) throw GlueError.sourceConcurrent(id);
  runtime.inFlight.add(id);
  try {
    const srcDef = entry.sourceCard.def;
    const binding = deps.registry.resolve(srcDef.ref);
    if (!binding) {
      throw GlueError.business('SOURCE_UNBOUND', `源站 ${srcDef.ref} 未绑定物理配置`, {
        sourceId: id,
      });
    }

    // 入参:显式 given 优先,否则从 IR 取(过 ▸input 校验;source.input 从 IR 提取所需键)
    const rawInput = given !== undefined ? given : ctx.ir;
    const srcInput = strict ? checkAt('input', srcDef.input, rawInput, id) : rawInput;

    // take → ▸request(源站请求契约是"子集校验":只验不重建)
    const ureq = await srcDef.take(srcInput as never);
    if (strict && srcDef.request) checkAt('request', srcDef.request, ureq, id);

    // transport + 重试 + 业务映射
    const result = await fetchMapped(deps, policy, binding, ureq, ctx.signal, srcDef, id);

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
    if (deps.hooks?.onBusRes) await deps.hooks.onBusRes({ ...ctx, sourceId: id });
    return product;
  } finally {
    runtime.inFlight.delete(id);
  }
}

/** 默认重试安全集:HTTP 幂等方法(RFC 9110;框架源站方法集内为 GET/PUT/DELETE) */
const AUTO_SAFE_METHODS: ReadonlySet<UpstreamRequest['method']> = new Set([
  'GET',
  'PUT',
  'DELETE',
]);

/** 自动重试是否放行:unsafe 一律否;idempotent 一律是;auto 按 HTTP 方法判定 */
function isRetrySafe(safety: RetrySafety, method: UpstreamRequest['method']): boolean {
  if (safety === 'unsafe') return false;
  if (safety === 'idempotent') return true;
  return AUTO_SAFE_METHODS.has(method);
}

/**
 * 传输 + 重试 + 业务错误映射;传输错误统一补全 sourceId。
 * 重试门禁:仅"结果不确定"的传输层错误(NETWORK/TIMEOUT)受限——POST/PATCH 默认不自动重试
 * (源站可能已产生副作用,重发会重复执行),需 retrySafety: 'idempotent' 显式放行。
 */
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
  const retrySafe = isRetrySafe(src.retrySafety ?? 'auto', ureq.method);

  const transport = deps.transport ?? defaultTransport;

  let attempt = 0;
  for (;;) {
    let result: TransportResult;
    try {
      result = await transport(binding, ureq, { signal, timeoutMs });
    } catch (e) {
      if (e instanceof GlueError) {
        const canRetry = e.retryable && attempt < maxRetries;
        if (canRetry && retrySafe) {
          await sleep(backoff === 'expo' ? 200 * 2 ** attempt : 500);
          attempt++;
          continue;
        }
        if (canRetry) {
          deps.logger.warn(
            `跳过自动重试:${ureq.method} 非幂等(如需重试请声明 retrySafety: 'idempotent')`,
            { sourceId: srcId, method: ureq.method, code: e.code },
          );
        }
        throw new GlueError(
          { ...e, sourceId: e.sourceId ?? srcId },
          { cause: e.cause },
        );
      }
      throw e;
    }

    // 业务错误映射(2xx 也可能携带源站错误码;映射后仍可进入重试循环)。
    // 与传输层门禁不同:业务码代表源站已拒绝请求(无副作用歧义),
    // 重试凭映射项 retryable 或 retryableCodes 显式开启,不受方法门禁。
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
      const mappedEntry = typeof mapped === 'string' ? { code: mapped } : mapped;
      const bizErr = GlueError.business(
        mappedEntry.code,
        `源站业务错误(code=${srcCode ?? `HTTP ${result.status}`})`,
        {
          sourceId: srcId,
          raw: result.body,
          // 显式 retryable 优先,回退 retryableCodes(字符串映射项)
          retryable: mappedEntry.retryable ?? em?.retryableCodes?.includes(mappedEntry.code) ?? false,
          status: mappedEntry.status,
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
