import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineCard, inject, redact } from '../src/index';
import type { RelayCard } from '../src/index';
import { makeSourceCard } from './helpers';

/** 类型健全性:回调参数由 schema 推导(编译期验证,任何错位都会 typecheck 失败) */
const typedCard = defineCard({
  meta: { name: 'product.detail', version: '1.0.0' },
  in: z.object({ sku: z.string(), count: z.number().int().positive().default(1) }),
  out: z.object({ name: z.string(), cents: z.number() }),
  glue: z.object({
    skuId: z.string(),
    quantity: z.number(),
    tenantId: inject(z.string()),
    tag: redact(z.string()),
  }),
  toGlue: ({ sku, count }) => ({ skuId: sku.toUpperCase(), quantity: count ?? 1, tag: 't' }),
  sources: [
    {
      source: makeSourceCard({ withRequest: false }),
      id: 'jd',
      bind: (g) => {
        // g 含 core + 注入字段
        const tenant: string = g.tenantId;
        return { skuId: `${g.skuId}:${tenant}` };
      },
    },
  ],
  fromGlue: (_g, res) => ({ name: res.jd.title, cents: res.jd.priceCents }),
});

describe('defineCard', () => {
  it('正常定义并预计算元信息', () => {
    expect(typedCard.meta).toEqual({ name: 'product.detail', version: '1.0.0' });
    expect(typedCard.injectKeys).toEqual(['tenantId']);
    expect(typedCard.redactKeys).toEqual(['tag']);
    expect(typedCard.sourceCardNames).toEqual(['jd.item-detail']);
  });

  it('toGlue 声明注入字段 → 编译期已禁止(此处验证运行时自洽不重复拦截)', () => {
    // 类型层面 Omit 保证;运行时只需 meta.name 校验
    expect(() => defineCard({ ...typedCard.def, meta: {} } as never)).toThrow(/meta.name/);
  });

  it('glue 非 z.object → 拒绝', () => {
    expect(() =>
      defineCard({ ...typedCard.def, glue: z.string() as never }),
    ).toThrow(/glue 必须是 z.object/);
  });

  it('sources 为空 → 拒绝', () => {
    expect(() => defineCard({ ...typedCard.def, sources: [] })).toThrow(/sources 至少声明一个源站卡片/);
  });

  it('source 未引用源站卡片 → 拒绝', () => {
    const bad = { ...typedCard.def.sources[0], source: { meta: { name: 'x' } } } as never;
    expect(() => defineCard({ ...typedCard.def, sources: [bad] })).toThrow(/defineSource/);
  });

  it('source 缺 id → 拒绝', () => {
    const bad = { ...typedCard.def.sources[0], id: undefined } as never;
    expect(() => defineCard({ ...typedCard.def, sources: [bad] })).toThrow(/必须声明 id/);
  });

  it('source id 重复 → 拒绝', () => {
    const dup = typedCard.def.sources[0];
    expect(() =>
      defineCard({
        ...typedCard.def,
        sources: [dup, { ...dup, source: makeSourceCard({ name: 'other.source' }) }] as never,
      }),
    ).toThrow(/id 重复/);
  });

  it('source 缺 bind → 拒绝', () => {
    const bad = { ...typedCard.def.sources[0], bind: undefined } as never;
    expect(() => defineCard({ ...typedCard.def, sources: [bad] })).toThrow(/bind 必须是函数/);
  });

  it('非法中间件 seam → 拒绝', () => {
    expect(() =>
      defineCard({
        ...typedCard.def,
        middlewares: [{ seam: 'nope' as never, run: async () => {} }],
      }),
    ).toThrow(/中间件非法/);
  });

  it('bind 接缝中间件合法', () => {
    const card = defineCard({
      ...typedCard.def,
      middlewares: [{ seam: 'bind' as const, run: async () => {} }],
    });
    expect(card.def.middlewares?.length).toBe(1);
  });

  it('RelayCard 冻结外壳,def 可引用', () => {
    const card = typedCard as RelayCard;
    expect(Object.isFrozen(card)).toBe(true);
    expect(typeof card.def.toGlue).toBe('function');
  });
});
