import { describe, expect, it } from 'vitest';
import { GlueError } from '../src/index';

describe('glue error', () => {
  it('schema 错误:① in → 400,其余 → 502', () => {
    expect(GlueError.schema('in', 'bad').status).toBe(400);
    expect(GlueError.schema('in', 'bad').code).toBe('GLUE.SCHEMA.IN');
    const codes: Record<string, string> = {
      glue: 'GLUE.SCHEMA.GLUE',
      input: 'GLUE.SCHEMA.INPUT',
      request: 'GLUE.SCHEMA.REQUEST',
      upstreamRes: 'GLUE.SCHEMA.UPSTREAM_RES',
      output: 'GLUE.SCHEMA.OUTPUT',
      out: 'GLUE.SCHEMA.OUT',
    };
    for (const [seam, code] of Object.entries(codes)) {
      const e = GlueError.schema(seam as never, 'bad');
      expect(e.status).toBe(502);
      expect(e.retryable).toBe(false);
      expect(e.code).toBe(code);
    }
  });

  it('transport 错误:TIMEOUT/NETWORK 可重试,CANCELLED 不可', () => {
    expect(GlueError.transport('TIMEOUT', 'jd').retryable).toBe(true);
    expect(GlueError.transport('TIMEOUT', 'jd').status).toBe(504);
    expect(GlueError.transport('NETWORK', 'jd').retryable).toBe(true);
    expect(GlueError.transport('NETWORK', 'jd').status).toBe(502);
    const c = GlueError.transport('CANCELLED', 'jd');
    expect(c.retryable).toBe(false);
    expect(c.status).toBe(499);
  });

  it('business 错误:默认不可重试,retryableCodes 语义由调用方传入', () => {
    const e = GlueError.business('PRODUCT_NOT_FOUND', 'msg', { raw: { a: 1 } });
    expect(e.code).toBe('GLUE.BUSINESS.PRODUCT_NOT_FOUND');
    expect(e.retryable).toBe(false);
    expect(e.status).toBe(502);
    expect(e.raw).toEqual({ a: 1 });
    const r = GlueError.business('RATE_LIMITED', 'msg', { retryable: true });
    expect(r.retryable).toBe(true);
  });

  it('toJSON 不含 raw 与 message(对外安全形状)', () => {
    const e = GlueError.business('X', '内部细节', { raw: { secret: 'v' } });
    expect(e.toJSON()).toEqual({ code: 'GLUE.BUSINESS.X', status: 502, sourceId: undefined });
    expect(JSON.stringify(e)).not.toContain('内部细节');
    expect(JSON.stringify(e)).not.toContain('secret');
  });

  it('cardNotFound / unknown', () => {
    expect(GlueError.cardNotFound('nope').code).toBe('GLUE.CARD.NOT_FOUND');
    expect(GlueError.cardNotFound('nope').status).toBe(404);
    const u = GlueError.unknown(new Error('boom'));
    expect(u.code).toBe('GLUE.UNKNOWN');
    expect(u.message).toBe('boom');
  });
});
