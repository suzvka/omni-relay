import { z } from 'zod';
import { defineCard, defineSource, inject, redact } from '../../src/index';

/**
 * 示例源站卡片:京东商品详情(对接侧插件)。
 * - input/output:对接者声明"需要什么入参、能提供哪些原子字段";
 * - upstreamRes/put:上游契约与响应清洗(业务无关字段在此被挡在总线之外);
 * - 对接者不知道谁消费,注册进中心化注册表后任何业务卡片均可引用。
 */
export const jdItemDetail = defineSource({
  meta: { name: 'jd.item-detail', version: '1.0.0' },
  ref: 'jd/items/detail',

  input: z.object({ skuId: z.string() }),
  output: z.object({
    title: z.string(),
    priceCents: z.number(),
    inStock: z.boolean(),
  }),
  upstreamRes: z.object({
    item_name: z.string(),
    price: z.number(),
    stock: z.number(),
  }),
  request: z.object({ query: z.object({ fmt: z.literal('json') }) }),

  take: ({ skuId }) => ({
    method: 'GET' as const,
    path: '/v2/items/:skuId',
    params: { skuId },
    query: { fmt: 'json' as const },
  }),
  put: (raw) => ({
    title: raw.item_name,
    priceCents: Math.round(raw.price * 100),
    inStock: raw.stock > 0,
  }),
  errorMap: {
    extract: (body) => (body as { error?: { code?: string } } | null)?.error?.code,
    map: { ITEM_NOT_FOUND: 'PRODUCT_NOT_FOUND', 'HTTP:404': 'PRODUCT_NOT_FOUND' },
    fallback: 'UPSTREAM_UNKNOWN',
  },
});

/**
 * 示例业务卡片:商品详情。
 * - in/out:商品 API 契约(我们定义);
 * - glue:总线 req 区(框架按字段审计/注入/屏蔽);
 * - sources:引用源站卡片,bind 把总线数据映射为源站入参;
 * - fromGlue:读取源站原子字段并计算派生出参。
 */
const skuDetail = defineCard({
  meta: { name: 'product.detail', version: '1.0.0' },

  in: z.object({ sku: z.string(), count: z.number().int().positive().default(1) }),
  out: z.object({ name: z.string(), cents: z.number(), available: z.boolean() }),

  glue: z.object({
    skuId: z.string(),
    quantity: z.number(),
    tenantId: inject(z.string()), // extension:注册期由运行时配置注入
    internalTag: redact(z.string()), // core:审计摘要自动脱敏
  }),

  toGlue: ({ sku, count }) => ({ skuId: sku, quantity: count ?? 1, internalTag: `tag:${sku}` }),

  sources: [{ source: jdItemDetail, id: 'jd', bind: (g) => ({ skuId: g.skuId }) }],

  fromGlue: (_g, res) => ({
    name: res.jd.title,
    cents: res.jd.priceCents,
    available: res.jd.inStock,
  }),
});

export default skuDetail;
