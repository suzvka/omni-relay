import { seamMiddlewares } from './card';
import { Bus } from './bus';
import { GlueError } from './errors';
import { runWithStrategy, sleep } from './strategy';
import { checkAt } from './validate';
import { isReadableStream } from './stream';
import type { SourceRegistry } from '../source/registry';
import type { TransportFn } from '../source/transport';
import { defaultTransport } from '../source/transport';
import type {
  ControllerHooks,
  GlueCtx,
  HandleOptions,
  Logger,
  RawSourceCardDef,
  RelayCard,
  RelayMiddleware,
  SourceCardRef,
  TransportResult,
  UpstreamRequest,
} from './types';
import type { ResolvedPolicy } from './types';

/** 卡片在服务目录中的运行时状态(控制面快照产物) */
export interface RegisteredCard {
  card: RelayCard;
  policy: ResolvedPolicy;
  runtimeConfig: Record<string, unknown>;
}

export interface PipelineDeps {
  registry: SourceRegistry;
  hooks?: ControllerHooks;
  logger: Logger;
  defaultTimeoutMs: number;
  /** 供测试替换传输层 */
  transport?: TransportFn;
}

const transport: TransportFn = defaultTransport;

/** 洋葱组合:中间件依次包裹 core,next() 后可访问本接缝产物 */
function compose(
  mws: readonly RelayMiddleware[],
): (ctx: GlueCtx, core: () => Promise<void>) => Promise<void> {
  return async (ctx, core) => {
    let index = -1;
    const dispatch = (i: number): Promise<void> => {
      if (i <= index) return Promise.reject(new Error('next() 被多次调用'));
      index = i;
      const mw = mws[i];
      if (mw) return mw.run(ctx, () => dispatch(i + 1));
      return core();
    };
    return dispatch(0);
  };
}

/** 框架特权钩子包成中间件:置于接缝最外层,next() 后审计/屏蔽产物 */
function hookAsMw(
  seam: RelayMiddleware['seam'],
  fn: ((ctx: GlueCtx) => void | Promise<void>) | undefined,
): RelayMiddleware[] {
  return fn
    ? [
        {
          seam,
          name: 'framework-hook',
          run: async (ctx, next) => {
            await next();
            await fn(ctx);
          },
        },
      ]
    : [];
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/**
 * 执行一张卡片(管道执行序):
 * in① → toGlue+注入合成 → glue② → per-source(bind→input校验→[钩子/中间件]→take→request校验
 * →transport(重试)→业务映射→upstreamRes校验→put→output校验→[钩子res]→writeRes)
 * → fromGlue → out⑥。总线贯穿全程,失败挂 bus.err 后抛出。
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
  const sources = def.sources as readonly SourceCardRef<any, any, any>[];

  const bus = new Bus(card.redactKeys);
  const ctx: GlueCtx = {
    card: card.meta,
    bus,
    state: new Map(),
    log: deps.logger,
    signal: opts.signal ?? new AbortController().signal,
    timing: {},
    meta: opts.meta ?? {},
  };

  try {
    // ① 商品入参
    const parsedInput = strict ? checkAt('in', def.in, input) : input;

    // toGlue 接缝(钩子最外层,next 后可审计/屏蔽 bus.req)
    const tGlue = now();
    await compose([
      ...hookAsMw('toGlue', deps.hooks?.onBusReq),
      ...seamMiddlewares(def, 'toGlue'),
    ])(ctx, async () => {
      const core = await def.toGlue(parsedInput as never);
      const full: Record<string, unknown> = { ...(core as Record<string, unknown>) };
      for (const key of card.injectKeys) full[key] = entry.runtimeConfig[key];
      bus.req = strict ? checkAt('glue', def.glue, full) : full;
    });
    ctx.timing['toGlue'] = now() - tGlue;

    // per-source 段(策略编排)
    const tSrc = now();
    await runWithStrategy(entry.policy.strategy, sources, (src) =>
      runSource(deps, entry, ctx, src, strict),
    );
    ctx.timing['sources'] = now() - tSrc;

    // fromGlue 接缝
    const tOut = now();
    await compose(seamMiddlewares(def, 'fromGlue'))(ctx, async () => {
      const rawOut = await def.fromGlue(bus.req as never, bus.res as never);
      bus.out = strict ? checkAt('out', def.out, rawOut) : rawOut;
    });
    ctx.timing['fromGlue'] = now() - tOut;

    return bus.out;
  } catch (e) {
    if (e instanceof GlueError) {
      bus.err = e;
      deps.logger.warn('relay 失败', { card: card.meta.name, digest: bus.digest() });
    }
    // 释放已建立但未消费的源站流(切换/聚合中断时防连接悬挂)
    for (const data of Object.values(bus.res)) {
      if (isReadableStream(data)) data.cancel().catch(() => {});
    }
    throw e;
  }
}

/** 单源站段:bind → input校验 → take → request校验 → transport(重试+业务映射)
 *  → upstreamRes校验 → put → output校验 → [钩子res] → writeRes */
async function runSource(
  deps: PipelineDeps,
  entry: RegisteredCard,
  ctx: GlueCtx,
  src: SourceCardRef<any, any, any>,
  strict: boolean,
): Promise<void> {
  const srcId = src.id;
  const srcDef = src.source.def;
  // per-source 隔离字段(bus/state/timing 共享,sourceInput/upstream/raw/sourceId 独立)
  const srcCtx: GlueCtx = { ...ctx, sourceId: srcId };
  const binding = deps.registry.resolve(srcDef.ref);
  if (!binding) {
    throw GlueError.business('SOURCE_UNBOUND', `源站 ${srcDef.ref} 未绑定物理配置`, {
      sourceId: srcId,
    });
  }

  // bind 接缝(业务总线 → 源站入参)
  const t0 = now();
  await compose(seamMiddlewares(entry.card.def, 'bind'))(srcCtx, async () => {
    const sInput = await src.bind(srcCtx.bus.req as never);
    srcCtx.sourceInput = strict ? checkAt('input', srcDef.input, sInput, srcId) : sInput;
  });
  ctx.timing[`${srcId}.bind`] = now() - t0;

  // take 接缝
  const t1 = now();
  await compose(seamMiddlewares(entry.card.def, 'take'))(srcCtx, async () => {
    const ureq = await srcDef.take(srcCtx.sourceInput as never);
    // 源站请求契约是"子集校验":只验不重建(zod strip 会丢弃未声明的 method/path 等)
    if (strict && srcDef.request) checkAt('request', srcDef.request, ureq, srcId);
    srcCtx.upstream = ureq;
  });
  ctx.timing[`${srcId}.take`] = now() - t1;

  // transport + 重试 + 业务映射
  const t2 = now();
  const result = await fetchMapped(
    deps,
    entry.policy,
    binding,
    srcCtx.upstream as UpstreamRequest,
    srcCtx.signal,
    srcDef,
    srcId,
  );
  ctx.timing[`${srcId}.fetch`] = now() - t2;
  srcCtx.raw = { status: result.status, body: result.body };

  // 流式守卫:旁路校验是显式授予的特权,未声明 stream 的源站收到流式响应直接拒绝
  if (result.stream && !srcDef.stream) {
    throw GlueError.business(
      'UPSTREAM_STREAM_UNDECLARED',
      `源站 ${srcId} 返回流式响应,但源站卡片未声明 stream: true`,
      { sourceId: srcId },
    );
  }

  // 源站原始响应校验(流式源站惯例声明 z.custom,校验天然通过;JSON 响应仍受 schema 约束)
  const upstreamData = strict
    ? checkAt('upstreamRes', srcDef.upstreamRes, result.body, srcId)
    : result.body;

  // put 接缝(钩子最外层,next 后可审计/屏蔽 res.<srcId>);流式源站 put 省略时流直写
  await compose([
    ...hookAsMw('put', deps.hooks?.onBusRes),
    ...seamMiddlewares(entry.card.def, 'put'),
  ])(srcCtx, async () => {
    let busData = srcDef.put ? await srcDef.put(upstreamData as never) : upstreamData;
    if (strict) busData = checkAt('output', srcDef.output, busData, srcId);
    ctx.bus.writeRes(srcId, busData);
  });
  ctx.timing[`${srcId}.put`] = now() - t2;
}

/** 传输 + 重试 + 业务错误映射;传输错误统一补全 sourceId */
async function fetchMapped(
  deps: PipelineDeps,
  policy: ResolvedPolicy,
  binding: Parameters<TransportFn>[0],
  ureq: UpstreamRequest,
  signal: AbortSignal,
  src: RawSourceCardDef<any, any, any, any>,
  srcId: string,
): Promise<TransportResult> {
  const maxRetries = Math.max(0, policy.retry?.max ?? 0);
  const backoff = policy.retry?.backoff ?? 'expo';
  const timeoutMs = policy.timeoutMs ?? binding.timeoutMs ?? deps.defaultTimeoutMs;
  const doTransport = deps.transport ?? transport;

  let attempt = 0;
  for (;;) {
    let result: TransportResult;
    try {
      result = await doTransport(binding, ureq, { signal, timeoutMs });
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
