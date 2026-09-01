import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { inject, redact, relayMeta, scanGlueMeta } from '../src/index';

describe('markers', () => {
  it('inject 挂载运行时元数据并保持 schema 行为', () => {
    const s = inject(z.string());
    expect(s.safeParse('x').success).toBe(true);
    expect(relayMeta.get(s)).toMatchObject({ 'x-omni-inject': true });
  });

  it('redact 挂载运行时元数据并保持 schema 行为', () => {
    const s = redact(z.string());
    expect(s.safeParse('secret-value').success).toBe(true);
    expect(relayMeta.get(s)).toMatchObject({ 'x-omni-redact': true });
  });

  it('scanGlueMeta 精确分类 core / extension / 脱敏字段', () => {
    const glue = z.object({
      a: z.string(),
      b: inject(z.string()),
      c: redact(z.string()),
      d: inject(redact(z.number())), // 注入值也可脱敏
    });
    const meta = scanGlueMeta(glue);
    expect(meta.injectKeys.sort()).toEqual(['b', 'd']);
    expect(meta.redactKeys.sort()).toEqual(['c', 'd']);
  });
});
