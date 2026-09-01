import type { GlueError } from './errors';

export interface BusDigest {
  req: unknown;
  res: Record<string, unknown>;
  out: unknown;
  err?: { code: string; message: string; sourceId?: string };
}

/**
 * 中介总线:三分区 + err。
 * - req:商品入参铺入(toGlue + 注入合成),源站只读;
 * - res.<srcId>:各源站只写自己的命名空间(经 writeRes 强制);
 * - out:fromGlue 产出;
 * - err:失败时记录规范化错误。
 */
export class Bus {
  req: unknown;
  readonly res: Record<string, unknown> = {};
  out: unknown;
  err: GlueError | undefined;

  constructor(private readonly redactKeys: readonly string[]) {}

  /** 写隔离:仅管道以源站身份调用,写入自己的命名空间 */
  writeRes(sourceId: string, data: unknown): void {
    this.res[sourceId] = data;
  }

  /** 脱敏摘要:redact 标记字段递归打码;供审计/日志消费,raw 不在此列 */
  digest(): BusDigest {
    return {
      req: this.mask(this.req),
      res: Object.fromEntries(
        Object.entries(this.res).map(([k, v]) => [k, this.mask(v)]),
      ),
      out: this.mask(this.out),
      err: this.err
        ? { code: this.err.code, message: this.err.message, sourceId: this.err.sourceId }
        : undefined,
    };
  }

  private mask(value: unknown): unknown {
    if (Array.isArray(value)) return value.map((v) => this.mask(v));
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = this.redactKeys.includes(k) ? maskLeaf(v) : this.mask(v);
      }
      return out;
    }
    return value;
  }
}

function maskLeaf(v: unknown): string {
  if (typeof v === 'string' && v.length > 4) return `***${v.slice(-2)}`;
  return '***';
}
