import type { Seam } from './types';

/** 请求期校验点(对应错误码 GLUE.SCHEMA.<SEAM>) */
export type CheckSeam = 'in' | 'input' | 'request' | 'upstreamRes' | 'output' | 'out';

const CHECK_STATUS: Record<CheckSeam, number> = {
  in: 400,
  input: 502,
  request: 502,
  upstreamRes: 502,
  output: 502,
  out: 502,
};

const CHECK_CODE: Record<CheckSeam, string> = {
  in: 'GLUE.SCHEMA.IN',
  input: 'GLUE.SCHEMA.INPUT',
  request: 'GLUE.SCHEMA.REQUEST',
  upstreamRes: 'GLUE.SCHEMA.UPSTREAM_RES',
  output: 'GLUE.SCHEMA.OUTPUT',
  out: 'GLUE.SCHEMA.OUT',
};

/** 校验点归属的管道阶段 */
const SEAM_OF_CHECK: Record<CheckSeam, Seam> = {
  in: 'collect',
  input: 'invoke',
  request: 'invoke',
  upstreamRes: 'invoke',
  output: 'invoke',
  out: 'respond',
};

export interface GlueErrorInit {
  code: string;
  message: string;
  retryable: boolean;
  status: number;
  seam: Seam | 'control';
  sourceId?: string;
  raw?: unknown;
  cause?: unknown;
}

/**
 * 统一错误模型:任何一跳失败都收敛为 GlueError。
 * - `retryable` 是重试/切换源站的唯一信号;
 * - `raw`(源站原始响应体)只进日志/审计,永不透出给商品侧。
 */
export class GlueError extends Error {
  override name = 'GlueError';
  readonly code: string;
  readonly retryable: boolean;
  readonly status: number;
  readonly seam: Seam | 'control';
  readonly sourceId?: string;
  readonly raw?: unknown;

  constructor(init: GlueErrorInit, options?: { cause?: unknown }) {
    super(init.message);
    this.code = init.code;
    this.retryable = init.retryable;
    this.status = init.status;
    this.seam = init.seam;
    this.sourceId = init.sourceId;
    this.raw = init.raw;
    if (options?.cause !== undefined) this.cause = options.cause;
  }

  /** 校验点失败 */
  static schema(seam: CheckSeam, issue: string, sourceId?: string): GlueError {
    return new GlueError({
      code: CHECK_CODE[seam],
      message: `校验失败 @${seam}${sourceId ? ` (source=${sourceId})` : ''}: ${issue}`,
      retryable: false,
      status: CHECK_STATUS[seam],
      seam: SEAM_OF_CHECK[seam],
      sourceId,
    });
  }

  /** 传输层失败 */
  static transport(
    kind: 'TIMEOUT' | 'NETWORK' | 'CANCELLED',
    sourceId: string | undefined,
    cause?: unknown,
  ): GlueError {
    const conf = {
      TIMEOUT: { status: 504, retryable: true, message: '源站请求超时' },
      NETWORK: { status: 502, retryable: true, message: '源站网络错误' },
      CANCELLED: { status: 499, retryable: false, message: '请求被取消' },
    }[kind];
    return new GlueError(
      {
        code: `GLUE.TRANSPORT.${kind}`,
        message: conf.message,
        retryable: conf.retryable,
        status: conf.status,
        seam: 'invoke',
        sourceId,
      },
      { cause },
    );
  }

  /** 源站业务错误(经 errorMap 翻译;fallback 未命中也归此类) */
  static business(
    code: string,
    message: string,
    opts: { sourceId?: string; raw?: unknown; retryable?: boolean; status?: number } = {},
  ): GlueError {
    return new GlueError({
      code: `GLUE.BUSINESS.${code}`,
      message,
      retryable: opts.retryable ?? false,
      status: opts.status ?? 502,
      seam: 'invoke',
      sourceId: opts.sourceId,
      raw: opts.raw,
    });
  }

  static cardNotFound(name: string): GlueError {
    return new GlueError({
      code: 'GLUE.CARD.NOT_FOUND',
      message: `未注册的卡片: ${name}`,
      retryable: false,
      status: 404,
      seam: 'control',
    });
  }

  static unknown(cause: unknown): GlueError {
    return new GlueError({
      code: 'GLUE.UNKNOWN',
      message: cause instanceof Error ? cause.message : String(cause),
      retryable: false,
      status: 500,
      seam: 'control',
    }, { cause });
  }

  /** 供 HTTP 直通层使用的对外形状:不含 raw、不含内部 message 细节 */
  toJSON(): { code: string; status: number; sourceId?: string } {
    return { code: this.code, status: this.status, sourceId: this.sourceId };
  }
}

/** 声明期/注册期框架错误 */
export class RegistrationError extends Error {
  override name = 'RegistrationError';
  constructor(
    message: string,
    readonly step: string,
  ) {
    super(message);
  }
}
