import type * as z from 'zod';
import type { Manifest } from './manifest';

// ---------------------------------------------------------------------------
// 执行阶段与钩子
// ---------------------------------------------------------------------------

/** 管道阶段:collect(入站请求处理)/ invoke(调用 API 卡片)/ respond(响应构筑) */
export type Seam = 'collect' | 'invoke' | 'respond';

/** 框架特权钩子:宿主规则在 IR 上的执行点(注入/屏蔽/审计),卡片不可覆盖 */
export interface ControllerHooks {
  /** in 校验通过、seeds 并入 IR 后、collect 之前;可读写 ctx.ir */
  onBusReq?: (ctx: CollectCtx) => void | Promise<void>;
  /** 每次 invoke 产物写入 ir[id] 之后;可读写 ctx.ir(ctx.sourceId 为本次源站卡片名) */
  onBusRes?: (ctx: CollectCtx) => void | Promise<void>;
}

/**
 * 贯穿一次 handle 的执行上下文(collect 阶段)。
 * IR(`ir`)是自由直读直写的键值对缓存:collect 往其中收集/填充数据,
 * invoke 产物写入 `ir[id]`,respond 只读其中已有的值。
 */
export interface CollectCtx {
  readonly card: CardMeta;
  /** ▸in 校验后的入站请求(collect 从这里取值填进 IR) */
  readonly input: unknown;
  /** IR:键值对缓存(已并入 seeds;invoke 产物写入 ir[id]) */
  readonly ir: Record<string, unknown>;
  state: Map<unknown, unknown>;
  log: Logger;
  signal: AbortSignal;
  /** 各阶段耗时(键:collect/respond 或 "<id>.fetch"/"<id>.invoke") */
  timing: Record<string, number>;
  /** 请求级透传元数据(trace id 等),不进 IR */
  meta: Record<string, unknown>;
  /**
   * 编排原语:调用一张已注册的 API 卡片(源站卡片),产物写入 `ir[id]` 并返回。
   * - invoke(id):从 IR 按 source.input 取入参(过 ▸input 校验);
   * - invoke(id, input):用显式入参(仍过 ▸input);
   * - 每次都走完整源站段(take/transport/retry/errorMap/put/各校验点/onBusRes)。
   */
  invoke: (id: string, input?: unknown) => Promise<unknown>;
  /** 当前 invoke 的源站卡片名(仅 onBusRes 期间的快照上有值) */
  sourceId?: string;
}

/** respond 阶段上下文:与 collect 同形,但类型层移除 invoke(只读 IR 构筑响应) */
export type RespondCtx = Omit<CollectCtx, 'invoke'>;

// ---------------------------------------------------------------------------
// HTTP / 源站
// ---------------------------------------------------------------------------

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/** 源站物理绑定:控制面经 registerSource 注入 */
export interface SourceBinding {
  baseURL: string;
  headers?: Record<string, string>;
  /** 惰性取用,值不进 IR、不进日志摘要 */
  auth?: () => AuthInput | Promise<AuthInput>;
  timeoutMs?: number;
  fetch?: FetchLike;
}

export type AuthInput = string | { headers: Record<string, string> };

/** take 产物:对源站请求的声明式描述(path 支持 :param 占位) */
export interface UpstreamRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  params?: Record<string, string | number>;
  query?: Record<string, string | number | boolean | undefined>;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface TransportResult {
  status: number;
  body: unknown;
  headers: Record<string, string>;
  /** 源站返回 event-stream:true 时 body 为 ReadableStream<Uint8Array>(流式透传) */
  stream?: boolean;
}

// ---------------------------------------------------------------------------
// 卡片
// ---------------------------------------------------------------------------

export interface CardMeta {
  readonly name: string;
  readonly version: string;
}

/**
 * 源站卡片原始定义(API 卡片 / 对接侧插件):封装"连接一个源站 + 清洗为原子字段"。
 * 对接者声明能力契约:需要哪些入参(input)、能提供哪些原子字段(output);
 * collect 经 ctx.invoke 按名调用,不接触源站细节。
 */
export interface RawSourceCardDef<
  TIn extends z.ZodType = z.ZodType,
  TOut extends z.ZodType = z.ZodType,
  TUpRes extends z.ZodType = z.ZodType,
  TReq extends z.ZodType | undefined = z.ZodType | undefined,
> {
  meta?: Partial<CardMeta>;
  /** 物理绑定引用(控制面经 registerSource 注入) */
  readonly ref: string;
  /** 源站入参契约:invoke 省略入参时从 IR 按此 schema 取(可含分支字段,由 take 按值路由端点) */
  readonly input: TIn;
  /** 原子字段契约(对接者承诺;invoke 产物写入 ir[id];流式源站惯例 z.custom<ReadableStream>) */
  readonly output: TOut;
  /** 源站原始响应 schema(照抄对方文档;流式源站惯例 z.custom<ReadableStream>) */
  readonly upstreamRes: TUpRes;
  /** 可选:源站请求契约(照抄对方文档,校验 take 产物) */
  readonly request?: TReq;
  readonly take: (input: z.output<TIn>) => UpstreamRequest | Promise<UpstreamRequest>;
  /** 可选:非流式为响应清洗;流式源站省略时流直写,声明时可对流做加工 */
  readonly put?: (raw: z.output<TUpRes>) => z.input<TOut> | Promise<z.input<TOut>>;
  readonly errorMap?: ErrorMapDef;
  /** 流式透传声明:声明后 event-stream 响应旁路校验,put 可省略;
   *  未声明却收到流式响应 → GLUE.BUSINESS.UPSTREAM_STREAM_UNDECLARED(旁路必须显式授予) */
  readonly stream?: boolean;
}

/** defineSource 产物:def + 预计算的运行时元信息 */
export interface SourceCard<
  TDef extends RawSourceCardDef<any, any, any, any> = RawSourceCardDef<any, any, any, any>,
> {
  readonly def: TDef;
  readonly meta: CardMeta;
}

/** 源站业务错误映射:extract 提取源站码 → map(支持 "HTTP:404" 形态)→ fallback */
export interface ErrorMapDef {
  extract?: (body: unknown) => string | null | undefined;
  map?: Record<string, string>;
  fallback?: string;
  /** 映射后的业务码中可重试的(如 RATE_LIMITED) */
  retryableCodes?: readonly string[];
}

/**
 * 卡片原始定义(v2 命令式双钩子)。
 * IR 是自由键值缓存:collect 直读直写 IR 并按需 invoke API 卡片把数据收集进来,
 * respond 只读 IR 构筑出参。校验落在两端(in/out)与每次 invoke 的源站段(input/…)。
 */
export interface RawCardDef<
  TIn extends z.ZodType = z.ZodType,
  TOut extends z.ZodType = z.ZodType,
> {
  meta?: Partial<CardMeta>;
  /** ① 入站请求契约(collect 的 ctx.input 来源;▸in 校验点) */
  in: TIn;
  /** ⑥ 出参契约(respond 产物;▸out 校验点) */
  out: TOut;
  /** 宿主注册期注入的 IR 初始键(替代 inject):buildRelay 一次性校验存在 + 类型 */
  seeds?: Record<string, z.ZodType>;
  /** 可选:声明可能 invoke 的源站卡片名(manifest 交叉校验 + inspect 依赖边);不限制 invoke */
  uses?: readonly string[];
  /** 入站请求处理钩子:直读直写 ir、invoke API 卡片,把数据收集进 IR(业务过程本身) */
  collect: (ctx: CollectCtx) => void | Promise<void>;
  /** 响应构筑钩子:只读 ir、不可 invoke,产出 out */
  respond: (ctx: RespondCtx) => z.input<TOut> | Promise<z.input<TOut>>;
}

/** defineCard 产物:def + 预计算的运行时元信息 */
export interface RelayCard<TDef extends RawCardDef<any, any> = RawCardDef<any, any>> {
  readonly def: TDef;
  readonly meta: CardMeta;
  /** seeds 声明的键(与 manifest.requires.injections 交叉校验、buildRelay 上线门的依据) */
  readonly seedKeys: readonly string[];
  /** uses 声明的源站卡片名(与 manifest.requires.sources 交叉校验、inspect 依赖边) */
  readonly uses: readonly string[];
}

// ---------------------------------------------------------------------------
// 策略与配置
// ---------------------------------------------------------------------------

export interface RetryPolicy {
  max: number;
  backoff: 'fixed' | 'expo';
}

/** 卡片建议 + 框架覆盖后的解析结果(多源容灾由 collect 手写,框架不再有策略) */
export interface PolicyInput {
  timeoutMs?: number;
  retry?: RetryPolicy;
}

export interface ResolvedPolicy {
  timeoutMs?: number;
  retry: RetryPolicy;
}

/** 注册选项（卡片与源站卡片通用） */
export interface RegisterOptions {
  /** 显式回滚意图:允许重发更旧版本(version < current),原子替换 current;
   *  缺省拒绝旧版注册(防误发)。版本史不由框架留存,旧版制品由制品层重新提供 */
  rollback?: boolean;
}

/** 服务面调用选项 */
export interface HandleOptions {
  signal?: AbortSignal;
  /** 请求级元数据(trace id 等),进入 ctx.meta,不进 IR */
  meta?: Record<string, unknown>;
  /** 关闭 6 个校验点(默认全开) */
  strict?: boolean;
}

// ---------------------------------------------------------------------------
// 控制面视图
// ---------------------------------------------------------------------------

export interface InspectField {
  name: string;
  kind: 'core' | 'extension';
}

export interface InspectSource {
  /** 源站卡片名(= invoke id = ir 命名空间键) */
  name: string;
  /** 源站卡片版本(契约身份:回滚影响面=内嵌该版本的商品卡片集合) */
  version: string;
  ref: string;
  bound: boolean;
}

/** 源站卡片字段级只读视图 */
export interface InspectSourceCardView {
  name: string;
  version: string;
  ref: string;
  bound: boolean;
  /** output 原子字段名清单(流式源站无 shape 时为空) */
  outputFields: string[];
  manifest: Manifest;
}

export interface InspectView {
  name: string;
  version: string;
  /** seeds 声明的键(kind='extension');IR 其余键为请求期动态填充,不静态可知 */
  fields: InspectField[];
  /** 由 uses 解析(未声明则为空:动态 invoke 无法静态穷举依赖) */
  sources: InspectSource[];
  policy: ResolvedPolicy;
  manifest: Manifest;
}

export interface CardSummary {
  name: string;
  version: string;
  sources: readonly string[];
}

export interface ControlEvent {
  action: string;
  target: string;
  detail?: unknown;
}

// ---------------------------------------------------------------------------
// 通用
// ---------------------------------------------------------------------------

export interface Logger {
  debug: (msg: string, data?: unknown) => void;
  info: (msg: string, data?: unknown) => void;
  warn: (msg: string, data?: unknown) => void;
  error: (msg: string, data?: unknown) => void;
}

export type FetchHandler = (req: Request) => Promise<Response>;

export interface FetchHandlerOptions {
  /** URL → 卡片名解析;缺省:整个 pathname(去首尾斜杠)decodeURIComponent */
  route?: (req: Request) => string | null | undefined | Promise<string | null | undefined>;
}

export interface RelayControllerOptions {
  /** 框架特权钩子:宿主规则的请求期执行点(IR),卡片不可覆盖 */
  hooks?: ControllerHooks;
  logger?: Logger;
  /** 卡片与源站均未声明超时时的兜底 */
  defaultTimeoutMs?: number;
  /** 宿主治理事件回调(注册/卸载/配置/策略变更时触发);未配置则框架不留存任何条目 */
  onControlEvent?: (event: ControlEvent) => void;
}
