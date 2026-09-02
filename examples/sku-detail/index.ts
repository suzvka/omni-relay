import { z } from 'zod';
import { defineCard, defineSource } from '../../src/index';

/**
 * 示例源站卡片:京东商品详情(API 卡片 / 对接侧插件)。
 * - input:invoke 省略入参时从 IR 读取的键(skuId);
 * - output:invoke 写回 IR 的原子字段(业务无关字段在此被挡在 IR 之外);
 * - upstreamRes/put:上游契约与响应清洗;
 * - 对接者不知道谁消费,注册进中心化注册表后任何业务卡片均可按名 invoke。
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
 * 示例业务卡片:商品详情(v2 命令式双钩子)。卡片只对 IR 契约负责,不接触源站细节。
 * - in/out:商品 API 的入站请求 / 出参契约(我们定义);
 * - seeds:宿主注册期注入的 IR 初始键(tenantId;buildRelay 一次性校验存在+类型);
 * - collect:入站请求处理钩子——把入站请求填进 IR,再 invoke API 卡片把数据收集进 IR;
 * - respond:响应构筑钩子——只读 IR(不可 invoke)构筑出参。
 */
const skuDetail = defineCard({
  meta: { name: 'product.detail', version: '1.0.0' },

  in: z.object({ sku: z.string(), count: z.number().int().positive().default(1) }),
  out: z.object({ name: z.string(), cents: z.number(), available: z.boolean() }),

  seeds: { tenantId: z.string() }, // 宿主注册期注入,collect 前已并入 IR
  uses: ['jd.item-detail'], // 声明可能 invoke 的 API 卡片(供 manifest 交叉校验/inspect)

  // collect:入站请求 → IR 键值对,再 invoke(省略入参 → 从 IR 按 source.input 取 skuId)
  collect: async (ctx) => {
    const { sku, count } = ctx.input as { sku: string; count?: number };
    ctx.ir.skuId = sku;
    ctx.ir.quantity = count ?? 1;
    ctx.ir.internalTag = `tag:${sku}`;
    await ctx.invoke('jd.item-detail');
  },

  // respond:只读 IR——ir['jd.item-detail'] 是 invoke 写回的原子字段(命名空间 = 源站卡片名)
  respond: (ctx) => {
    const jd = ctx.ir['jd.item-detail'] as {
      title: string;
      priceCents: number;
      inStock: boolean;
    };
    return { name: jd.title, cents: jd.priceCents, available: jd.inStock };
  },
});

export default skuDetail;
