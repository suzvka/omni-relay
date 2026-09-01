import type * as z from 'zod';
import type { Bus } from './bus';
import type { Manifest } from './manifest';

// ---------------------------------------------------------------------------
// 字段品牌(schema 层标记的类型面,运行时标记见 markers.ts)
// ---------------------------------------------------------------------------

declare const injectBrand: unique symbol;
declare const redactBrand: unique symbol;

/** inject() 标记的类型面:声明该字段由控制面运行时配置注入(extension 分区) */
export interface InjectedBrand {
  readonly [injectBrand]: true;
}

/** redact() 标记的类型面:声明该字段在审计摘要中脱敏 */
export interface RedactedBrand {
  readonly [redactBrand]: true;
}

export type Injected<T extends z.ZodType> = T & InjectedBrand;
export type Redacted<T extends z.ZodType> = T & RedactedBrand;

// ---------------------------------------------------------------------------
// 管道与中间件
// ---------------------------------------------------------------------------

/** 管道接缝:toGlue(入参→总线)/ bind(总线→源站入参)/ take(源站入参→源站请求)/ put(源站响应→总线)/ fromGlue(总线→出参) */
export type Seam = 'toGlue' | 'bind' | 'take' | 'put' | 'fromGlue';

/** 洋葱中间件,声明作用于哪个接缝 */
export interface RelayMiddleware {
  readonly seam: Seam;
  readonly name?: string;
  run: (ctx: GlueCtx, next: () => Promise<void>) => Promise<void>;
}

/** 框架特权钩子:框架主权操作(审计/注入/屏蔽)的执行点,卡片不可覆盖 */
export interface ControllerHooks {
  /** glue 校验通过后、per-source 段之前;可读写 ctx.bus.req 实现注入/屏蔽 */
  onBusReq?: (ctx: GlueCtx) => void | Promise<void>;
  /** 源站响应写入 res.<srcId> 之后;可读写 ctx.bus.res 实现审计/屏蔽 */
  onBusRes?: (ctx: GlueCtx) => void | Promise<void>;
}

/** 贯穿一次 handle 的执行上下文 */
export interface GlueCtx {
  readonly card: CardMeta;
  bus: Bus;
  state: Map<unknown, unknown>;
  log: Logger;
  signal: AbortSignal;
  /** 各阶段耗时(键:接缝名或 "<srcId>.<段>") */
  timing: Record<string, number>;
  /** 请求级透传元数据(trace id 等),不进总线 */
  meta: Record<string, unknown>;
  // ---- 以下字段为 per-source 段隔离(race/并发时各源站持有浅拷贝) ----
  sourceId?: string;
  /** bind 产物(源站入参),经 input 校验点校验 */
  sourceInput?: unknown;
  /** take 产物,中间件可在 next 前改写 */
  upstream?: UpstreamRequest;
  /** 源站原始响应 */
  raw?: { status: number; body: unknown };
}

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
  /** 惰性取用,值不进总线、不进日志摘要 */
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
 * 源站卡片原始定义(对接侧插件):封装"连接一个源站 + 清洗为原子字段"。
 * 对接者声明能力契约:需要哪些入参(input)、能提供哪些原子字段(output);
 * 业务卡片经 SourceCardRef 引用,不接触源站细节。
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
  /** 源站入参契约(可含分支字段,由 take 按值路由端点) */
  readonly input: TIn;
  /** 原子字段契约(对接者承诺;流式源站惯例 z.custom<ReadableStream>,仅类型留档) */
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

/** 业务卡片对源站卡片的引用:id 为总线 res.<id> 命名空间键;bind 把业务 glue 映射为源站入参 */
export interface SourceCardRef<
  TGlue extends z.ZodObject<any> = z.ZodObject<any>,
  TSc extends SourceCard<any> = SourceCard<any>,
  TId extends string = string,
> {
  readonly source: TSc;
  readonly id: TId;
  readonly bind: (
    glue: z.output<TGlue>,
  ) => z.input<TSc['def']['input']> | Promise<z.input<TSc['def']['input']>>;
}

/** 源站业务错误映射:extract 提取源站码 → map(支持 "HTTP:404" 形态)→ fallback */
export interface ErrorMapDef {
  extract?: (body: unknown) => string | null | undefined;
  map?: Record<string, string>;
  fallback?: string;
  /** 映射后的业务码中可重试的(如 RATE_LIMITED) */
  retryableCodes?: readonly string[];
}

/** 从 glue 类型中排除注入字段后的核心字段集(toGlue 的返回类型) */
export type InjectKeysOf<TGlue extends z.ZodObject<any>> = {
  [K in keyof z.output<TGlue>]: TGlue['shape'][K] extends InjectedBrand ? K : never;
}[keyof z.output<TGlue> & string];

export type GlueCoreOf<TGlue extends z.ZodObject<any>> = Omit<
  z.output<TGlue>,
  InjectKeysOf<TGlue>
>;

/** 从源站卡片引用数组推导 res 命名空间束:{ [id]: 源站卡片 output } */
export type ResBundleOf<TSrcs> = TSrcs extends readonly unknown[]
  ? {
      [S in TSrcs[number] as S extends SourceCardRef<any, any, infer TId>
        ? TId
        : never]: S extends SourceCardRef<any, infer TSc, any>
        ? TSc extends SourceCard<infer TDef>
          ? z.output<TDef['output']>
          : never
        : never;
    }
  : Record<string, never>;

/** 卡片原始定义(5 件套;manifest 是独立配置文件) */
export interface RawCardDef<
  TIn extends z.ZodType = z.ZodType,
  TOut extends z.ZodType = z.ZodType,
  TGlue extends z.ZodObject<any> = z.ZodObject<any>,
> {
  meta?: Partial<CardMeta>;
  /** ① 商品入参 schema(我们定义) */
  in: TIn;
  /** ⑥ 商品出参 schema(我们定义) */
  out: TOut;
  /** ② 总线 req 区 schema(显式声明,框架按字段操作) */
  glue: TGlue;
  /** ③ 入参 → 总线(只写 core 字段,inject 字段由框架合成) */
  toGlue: (input: z.output<TIn>) => GlueCoreOf<TGlue> | Promise<GlueCoreOf<TGlue>>;
  /** ④ 源站卡片引用:bind 把总线数据映射为源站入参 */
  sources: readonly SourceCardRef<TGlue, any, any>[];
  /** ⑤ 总线 → 出参(多源站聚合时显式合并各命名空间) */
  fromGlue: (
    glue: z.output<TGlue>,
    res: ResBundleOf<this['sources']>,
  ) => z.input<TOut> | Promise<z.input<TOut>>;
  middlewares?: readonly RelayMiddleware[];
}

/** defineCard 产物:def + 预计算的运行时元信息 */
export interface RelayCard<TDef extends RawCardDef<any, any, any> = RawCardDef<any, any, any>> {
  readonly def: TDef;
  readonly meta: CardMeta;
  readonly injectKeys: readonly string[];
  readonly redactKeys: readonly string[];
  /** 引用的源站卡片名清单(与 manifest.requires.sources 交叉校验的依据) */
  readonly sourceCardNames: readonly string[];
}

// ---------------------------------------------------------------------------
// 策略与配置
// ---------------------------------------------------------------------------

export type MultiSourceStrategy = 'firstSuccess' | 'race' | 'all';

export interface RetryPolicy {
  max: number;
  backoff: 'fixed' | 'expo';
}

/** 卡片建议 + 框架覆盖后的解析结果 */
export interface PolicyInput {
  timeoutMs?: number;
  retry?: RetryPolicy;
  strategy?: MultiSourceStrategy;
}

export interface ResolvedPolicy {
  timeoutMs?: number;
  retry: RetryPolicy;
  strategy: MultiSourceStrategy;
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
  /** 请求级元数据(trace id 等),进入 ctx.meta,不进总线 */
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
  redact: boolean;
}

export interface InspectSource {
  id: string;
  /** 引用的源站卡片名 */
  sourceCard: string;
  /** 引用的源站卡片版本(契约身份:回滚影响面=内嵌该版本的商品卡片集合) */
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
  fields: InspectField[];
  sources: InspectSource[];
  policy: ResolvedPolicy;
  manifest: Manifest;
}

export interface CardSummary {
  name: string;
  version: string;
  sources: readonly string[];
}

export interface AuditEntry {
  ts: number;
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
  /** URL → 卡片名解析;缺省:pathname 首段 decodeURIComponent */
  route?: (req: Request) => string | null | undefined | Promise<string | null | undefined>;
}

export interface RelayControllerOptions {
  /** 框架特权钩子(审计/注入/屏蔽的执行点) */
  hooks?: ControllerHooks;
  logger?: Logger;
  /** 卡片与源站均未声明超时时的兜底 */
  defaultTimeoutMs?: number;
}
