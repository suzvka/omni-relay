import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineCard } from '../src/index';
import type { RelayCard } from '../src/index';

/** 类型健全性:collect/respond 参数由框架提供(编译期验证,任何错位都会 typecheck 失败) */
const base = defineCard({
  meta: { name: 'product.detail', version: '1.0.0' },
  in: z.object({ sku: z.string() }),
  out: z.object({ name: z.string() }),
  seeds: { tenantId: z.string() },
  uses: ['jd.item-detail'],
  collect: async (ctx) => {
    ctx.ir.skuId = (ctx.input as { sku: string }).sku;
    await ctx.invoke('jd.item-detail');
  },
  respond: (ctx) => ({
    name: (ctx.ir['jd.item-detail'] as { title: string }).title,
  }),
});

describe('defineCard', () => {
  it('正常定义并预计算元信息', () => {
    expect(base.meta).toEqual({ name: 'product.detail', version: '1.0.0' });
    expect(base.seedKeys).toEqual(['tenantId']);
    expect(base.uses).toEqual(['jd.item-detail']);
  });

  it('缺 collect → 拒绝', () => {
    expect(() => defineCard({ ...base.def, collect: undefined as never })).toThrow(
      /collect 必须是函数/,
    );
  });

  it('缺 respond → 拒绝', () => {
    expect(() => defineCard({ ...base.def, respond: undefined as never })).toThrow(
      /respond 必须是函数/,
    );
  });

  it('in 非 zod → 拒绝', () => {
    expect(() => defineCard({ ...base.def, in: { not: 'zod' } as never })).toThrow(
      /in 必须是 Zod schema/,
    );
  });

  it('seeds 值非 zod → 拒绝', () => {
    expect(() => defineCard({ ...base.def, seeds: { tenantId: 'nope' as never } })).toThrow(
      /seeds\.tenantId 必须是 Zod schema/,
    );
  });

  it('uses 含空串 → 拒绝', () => {
    expect(() => defineCard({ ...base.def, uses: [''] })).toThrow(/uses 必须是非空字符串数组/);
  });

  it('uses 可省略(动态 invoke 任意已注册源站卡片)→ 归一为空数组', () => {
    const card = defineCard({ ...base.def, uses: undefined });
    expect(card.uses).toEqual([]);
  });

  it('seeds 可省略 → seedKeys 为空', () => {
    const card = defineCard({ ...base.def, seeds: undefined });
    expect(card.seedKeys).toEqual([]);
  });

  it('缺 meta.name → 拒绝', () => {
    expect(() => defineCard({ ...base.def, meta: {} } as never)).toThrow(/meta\.name/);
  });

  it('RelayCard 冻结外壳,def 可引用', () => {
    const card = base as RelayCard;
    expect(Object.isFrozen(card)).toBe(true);
    expect(typeof card.def.collect).toBe('function');
    expect(typeof card.def.respond).toBe('function');
  });
});
