import { z } from 'zod';
import { defineCard, defineSource, RelayController } from '../src/index';
import { mockSource } from '../src/testing';
import type {
  ControllerHooks,
  ErrorMapDef,
  PolicyInput,
  RelayCard,
  SourceCard,
} from '../src/index';
import type { MockedSource } from '../src/testing';

/** 标准源站卡片(API 卡片;与示例同构,便于各测试复用) */
export function makeSourceCard(
  overrides: {
    name?: string;
    ref?: string;
    withRequest?: boolean;
    errorMap?: ErrorMapDef;
  } = {},
): SourceCard {
  return defineSource({
    meta: { name: overrides.name ?? 'jd.item-detail', version: '1.0.0' },
    ref: overrides.ref ?? 'jd/items/detail',
    input: z.object({ skuId: z.string() }),
    request:
      overrides.withRequest === false
        ? undefined
        : z.object({ query: z.object({ fmt: z.literal('json') }) }),
    upstreamRes: z.object({
      item_name: z.string(),
      price: z.number(),
      stock: z.number(),
    }),
    output: z.object({
      title: z.string(),
      priceCents: z.number(),
      inStock: z.boolean(),
    }),
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
    errorMap: overrides.errorMap,
  });
}

/** 源站卡片 output 的原子字段形状(respond 读 ir[name] 时用) */
export interface JdOutput {
  title: string;
  priceCents: number;
  inStock: boolean;
}

/**
 * 标准单源站业务卡片(v2:collect 把入站请求填进 IR + invoke,respond 读 ir[name])。
 * invoke 省略入参 → 从 IR 按 source.input 取 skuId(印证"确保 IR 已填好该 API 入参")。
 */
export function makeCard(
  overrides: {
    sourceCard?: SourceCard;
    sourceCardOverrides?: Parameters<typeof makeSourceCard>[0];
  } = {},
): RelayCard {
  const sc = overrides.sourceCard ?? makeSourceCard(overrides.sourceCardOverrides);
  const name = sc.meta.name;
  return defineCard({
    meta: { name: 'product.detail', version: '1.0.0' },
    in: z.object({ sku: z.string(), count: z.number().int().positive().default(1) }),
    out: z.object({ name: z.string(), cents: z.number(), available: z.boolean() }),
    seeds: { tenantId: z.string() },
    uses: [name],
    collect: async (ctx) => {
      const { sku, count } = ctx.input as { sku: string; count?: number };
      ctx.ir.skuId = sku; // 入站请求 → IR 键值对(源站 input 需要 skuId)
      ctx.ir.quantity = count ?? 1;
      ctx.ir.internalTag = `tag:${sku}`;
      await ctx.invoke(name);
    },
    respond: (ctx) => {
      const r = ctx.ir[name] as JdOutput;
      return { name: r.title, cents: r.priceCents, available: r.inStock };
    },
  });
}

export const GOOD_BODY = { item_name: 'X', price: 9.9, stock: 3 };

/** 注册卡片依赖:物理绑定 + 源站卡片 + 卡片本身 */
export function registerCardDeps(
  controller: RelayController,
  card: RelayCard,
  sourceCards: SourceCard[],
  sources: MockedSource[],
): void {
  for (const s of sources) controller.registerSource(s.ref, s.binding);
  for (const sc of sourceCards) controller.registerSourceCard(sc);
  controller.registerCard(card);
}

/** 默认组装:mock 源站 + 源站卡片注册 + 卡片注册 + seeds 注入 + buildRelay */
export function setup(
  opts: {
    card?: RelayCard;
    sourceCards?: SourceCard[];
    mockBody?: unknown;
    mocks?: MockedSource[];
    policy?: PolicyInput;
    hooks?: ControllerHooks;
    runtimeConfig?: Record<string, unknown>;
  } = {},
) {
  const sourceCards = opts.sourceCards ?? [makeSourceCard()];
  const card = opts.card ?? makeCard({ sourceCard: sourceCards[0]! });
  const mocks =
    opts.mocks ??
    sourceCards.map((sc) => mockSource(sc.def.ref, { body: opts.mockBody ?? GOOD_BODY }));
  const controller = new RelayController(opts.hooks ? { hooks: opts.hooks } : {});
  registerCardDeps(controller, card, sourceCards, mocks);
  controller.setRuntimeConfig(card.meta.name, opts.runtimeConfig ?? { tenantId: 'T-01' });
  if (opts.policy) controller.setPolicy(card.meta.name, opts.policy);
  return { controller, relay: controller.buildRelay(), sources: mocks, card, sourceCards };
}

export { mockSource };
