import { z } from 'zod';
import { defineCard, defineSource, inject, redact, RelayController } from '../src/index';
import { mockSource } from '../src/testing';
import type { ErrorMapDef, MultiSourceStrategy, RelayCard, SourceCard } from '../src/index';
import type { MockedSource } from '../src/testing';

/** 标准源站卡片(与示例源站卡片同构,便于各测试复用) */
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

/** 标准单源站业务卡片(引用源站卡片,与示例卡片同构) */
export function makeCard(
  overrides: {
    id?: string;
    sourceCard?: SourceCard;
    sourceCardOverrides?: Parameters<typeof makeSourceCard>[0];
  } = {},
): RelayCard {
  const sc = overrides.sourceCard ?? makeSourceCard(overrides.sourceCardOverrides);
  const id = overrides.id ?? 'jd';
  return defineCard({
    meta: { name: 'product.detail', version: '1.0.0' },
    in: z.object({ sku: z.string(), count: z.number().int().positive().default(1) }),
    out: z.object({ name: z.string(), cents: z.number(), available: z.boolean() }),
    glue: z.object({
      skuId: z.string(),
      quantity: z.number(),
      tenantId: inject(z.string()),
      internalTag: redact(z.string()),
    }),
    toGlue: ({ sku, count }) => ({
      skuId: sku,
      quantity: count ?? 1,
      internalTag: `tag:${sku}`,
    }),
    sources: [{ source: sc, id, bind: (g) => ({ skuId: g.skuId }) }],
    fromGlue: (_g, res) => ({
      name: (res as Record<string, { title: string; priceCents: number; inStock: boolean }>)[id]
        .title,
      cents: (res as Record<string, { title: string; priceCents: number; inStock: boolean }>)[id]
        .priceCents,
      available: (
        res as Record<string, { title: string; priceCents: number; inStock: boolean }>
      )[id].inStock,
    }),
  });
}

const GOOD_BODY = { item_name: 'X', price: 9.9, stock: 3 };

/** 注册卡片依赖的全部源站卡片(去重)与其物理绑定 */
export function registerCardDeps(
  controller: RelayController,
  card: RelayCard,
  sources: MockedSource[],
): void {
  for (const s of sources) controller.registerSource(s.ref, s.binding);
  const seen = new Set<string>();
  for (const srcRef of card.def.sources) {
    const sc = srcRef.source;
    const key = `${sc.meta.name}@${sc.meta.version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    controller.registerSourceCard(sc);
  }
  controller.registerCard(card);
}

/** 默认组装:mock 源站 + 源站卡片注册 + 卡片注册 + 注入 + buildRelay */
export function setup(
  opts: {
    card?: RelayCard;
    mockBody?: unknown;
    sources?: MockedSource[];
    policy?: { timeoutMs?: number; retry?: { max: number; backoff: 'fixed' | 'expo' }; strategy?: MultiSourceStrategy };
  } = {},
) {
  const card = opts.card ?? makeCard();
  const refs = card.def.sources.map((s) => s.source.def.ref);
  const sources = opts.sources ?? refs.map((ref) => mockSource(ref, { body: opts.mockBody ?? GOOD_BODY }));
  const controller = new RelayController();
  registerCardDeps(controller, card, sources);
  controller.setRuntimeConfig(card.meta.name, { tenantId: 'T-01' });
  if (opts.policy) controller.setPolicy(card.meta.name, opts.policy);
  return { controller, relay: controller.buildRelay(), sources, card };
}

export { GOOD_BODY, mockSource };
