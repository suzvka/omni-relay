import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Bus, GlueError } from '../src/index';

describe('bus', () => {
  it('res 分区按 sourceId 隔离写入', () => {
    const bus = new Bus([]);
    bus.writeRes('jd', { a: 1 });
    bus.writeRes('tb', { b: 2 });
    bus.writeRes('jd', { a: 9 }); // 同命名空间覆盖
    expect(bus.res).toEqual({ jd: { a: 9 }, tb: { b: 2 } });
  });

  it('digest 对 redact 字段递归打码', () => {
    const bus = new Bus(['secret', 'short']);
    bus.req = {
      keep: 'visible',
      secret: 'averylongsecretvalue',
      short: 'ab',
      nested: { secret: 'inner-secret-value', deep: [{ secret: 'x1' }] },
      num: 42,
    };
    const digest = bus.digest() as Record<string, any>;
    expect(digest.req.keep).toBe('visible');
    expect(digest.req.secret).toBe('***ue'); // 长字符串保留末 2 位
    expect(digest.req.short).toBe('***');
    expect(digest.req.nested.secret).toBe('***ue');
    expect(digest.req.nested.deep[0].secret).toBe('***');
    expect(digest.req.num).toBe(42);
  });

  it('digest 携带 err 摘要', () => {
    const bus = new Bus([]);
    const err = GlueError.business('X', '原始细节不应外泄', { raw: { body: 1 } });
    bus.err = err;
    const d = bus.digest();
    expect(d.err).toEqual({ code: 'GLUE.BUSINESS.X', message: '原始细节不应外泄', sourceId: undefined });
  });

  it('out 与 req 原样保留(无标记字段)', () => {
    const bus = new Bus([]);
    bus.req = { a: 1 };
    bus.out = { b: 2 };
    expect(bus.digest().req).toEqual({ a: 1 });
    expect(bus.digest().out).toEqual({ b: 2 });
  });

  it('glue schema 输出可作为 req(类型健全性冒烟)', () => {
    const glue = z.object({ skuId: z.string() });
    const bus = new Bus([]);
    bus.req = glue.parse({ skuId: 'A1' });
    expect(bus.req).toEqual({ skuId: 'A1' });
  });
});
