import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Bus, defineCard, defineSource, inject, redact, RelayController } from '../src/index';
import { mockSource } from '../src/testing';
import type { RawCardDef, RelayCard, SourceCard } from '../src/index';
import { GOOD_BODY, makeCard, makeSourceCard, registerCardDeps, setup } from './helpers';

/** 构造"运行时行为故意错误"的卡片(类型上合法,用于触达各校验点) */
function patchDef(card: RelayCard, patch: Partial<RawCardDef>): RelayCard {
  return { ...card, def: { ...card.def, ...patch } } as RelayCard;
}

/** 替换卡片首个源站卡片的 def 字段(用于构造源站侧故意错误) */
function patchSourceCard(card: RelayCard, defPatch: Record<string, unknown>): RelayCard {
  const src0 = card.def.sources[0];
  const brokenSc = { ...src0.source, def: { ...src0.source.def, ...defPatch } } as SourceCard;
  return patchDef(card, { sources: [{ ...src0, source: brokenSc }] });
}

describe('relay.handle 全链路(单源站)', () => {
  it('happy path:入参转换 → 注入 → take → transport → put → 出参', async () => {
    const { relay, sources } = setup();
    const out = await relay.handle('product.detail', { sku: 'A1' });
    expect(out).toEqual({ name: 'X', cents: 990, available: true });
    expect(sources[0].mock.calls[0].url).toContain('/v2/items/A1?fmt=json');
  });

  it('默认值生效:count 缺省 → quantity=1', async () => {
    const { relay } = setup();
    const out = (await relay.handle('product.detail', { sku: 'A1', count: 3 })) as {
      name: string;
    };
    expect(out.name).toBe('X');
  });

  it('① in 校验失败 → GLUE.SCHEMA.IN / 400', async () => {
    const { relay } = setup();
    const e = await relay.handle('product.detail', { sku: 123 }).catch((x: unknown) => x);
    expect(e).toMatchObject({ code: 'GLUE.SCHEMA.IN', status: 400 });
  });

  it('② glue 校验失败(toGlue 缺字段)→ GLUE.SCHEMA.GLUE', async () => {
    const good = makeCard();
    const broken = patchDef(good, {
      toGlue: (() => ({ quantity: 1, internalTag: 'x' })) as never,
    });
    const { relay } = setup({ card: broken });
    const e = await relay.handle('product.detail', { sku: 'A1' }).catch((x: unknown) => x);
    expect(e).toMatchObject({ code: 'GLUE.SCHEMA.GLUE' });
  });

  it('③ bind 产物违反源站 input 契约 → GLUE.SCHEMA.INPUT', async () => {
    const good = makeCard();
    const src0 = good.def.sources[0];
    const broken = patchDef(good, {
      sources: [{ ...src0, bind: (() => ({ skuId: 123 })) as never }],
    });
    const { relay } = setup({ card: broken });
    const e = await relay.handle('product.detail', { sku: 'A1' }).catch((x: unknown) => x);
    expect(e).toMatchObject({ code: 'GLUE.SCHEMA.INPUT' });
  });

  it('③b take 产物违反 request 契约 → GLUE.SCHEMA.REQUEST', async () => {
    const broken = patchSourceCard(makeCard(), {
      take: () => ({ method: 'GET', path: '/x', query: { fmt: 'xml' } }),
    });
    const { relay } = setup({ card: broken });
    const e = await relay.handle('product.detail', { sku: 'A1' }).catch((x: unknown) => x);
    expect(e).toMatchObject({ code: 'GLUE.SCHEMA.REQUEST' });
  });

  it('④ 源站响应违反 upstreamRes → GLUE.SCHEMA.UPSTREAM_RES', async () => {
    const { relay } = setup({ mockBody: { wrong: 'shape' } });
    const e = await relay.handle('product.detail', { sku: 'A1' }).catch((x: unknown) => x);
    expect(e).toMatchObject({ code: 'GLUE.SCHEMA.UPSTREAM_RES' });
  });

  it('⑤ put 产物违反源站 output → GLUE.SCHEMA.OUTPUT', async () => {
    const broken = patchSourceCard(makeCard(), { put: () => ({ title: 1 }) });
    const { relay } = setup({ card: broken });
    const e = await relay.handle('product.detail', { sku: 'A1' }).catch((x: unknown) => x);
    expect(e).toMatchObject({ code: 'GLUE.SCHEMA.OUTPUT' });
  });

  it('⑥ fromGlue 产物违反 out → GLUE.SCHEMA.OUT', async () => {
    const good = makeCard();
    const broken = patchDef(good, {
      fromGlue: (() => ({ name: 'x', cents: 'bad' })) as never,
    });
    const { relay } = setup({ card: broken });
    const e = await relay.handle('product.detail', { sku: 'A1' }).catch((x: unknown) => x);
    expect(e).toMatchObject({ code: 'GLUE.SCHEMA.OUT' });
  });

  it('strict=false 跳过校验(脏数据直通)', async () => {
    const good = makeCard();
    const broken = patchDef(good, {
      fromGlue: (() => ({ name: 'x', cents: 'bad' })) as never,
    });
    const { relay } = setup({ card: broken });
    const out = await relay.handle('product.detail', { sku: 'A1' }, { strict: false });
    expect(out).toEqual({ name: 'x', cents: 'bad' });
  });

  it('未知卡片 → GLUE.CARD.NOT_FOUND', async () => {
    const { relay } = setup();
    await expect(relay.handle('nope', {})).rejects.toMatchObject({
      code: 'GLUE.CARD.NOT_FOUND',
    });
  });
});

describe('错误映射', () => {
  const codeOf = (b: unknown) => (b as { error?: { code?: string } } | null)?.error?.code;

  it('extract + map → GLUE.BUSINESS.<mapped>,raw 不外泄', async () => {
    const card = makeCard({
      sourceCardOverrides: {
        errorMap: {
          extract: codeOf,
          map: { ITEM_NOT_FOUND: 'PRODUCT_NOT_FOUND' },
          fallback: 'UPSTREAM_UNKNOWN',
        },
      },
    });
    const { relay } = setup({ card, mockBody: { error: { code: 'ITEM_NOT_FOUND' } } });
    const e = await relay.handle('product.detail', { sku: 'A1' }).catch((x: unknown) => x);
    expect(e).toMatchObject({ code: 'GLUE.BUSINESS.PRODUCT_NOT_FOUND', retryable: false });
    expect(JSON.stringify(e)).not.toContain('ITEM_NOT_FOUND');
  });

  it('2xx 但 extract 命中 map → 业务错误(200+错误体的源站形态)', async () => {
    const card = makeCard({
      sourceCardOverrides: { errorMap: { extract: codeOf, map: { BIZ_ERR: 'MAPPED' } } },
    });
    const { relay } = setup({ card, mockBody: { error: { code: 'BIZ_ERR' } } });
    await expect(relay.handle('product.detail', { sku: 'A1' })).rejects.toMatchObject({
      code: 'GLUE.BUSINESS.MAPPED',
    });
  });

  it('非 2xx 无码 → fallback', async () => {
    const card = makeCard({
      sourceCardOverrides: { errorMap: { extract: codeOf, fallback: 'UPSTREAM_UNKNOWN' } },
    });
    const src = mockSource(card.def.sources[0].source.def.ref, { status: 500, body: { unexpected: true } });
    const { relay } = setup({ card, sources: [src] });
    await expect(relay.handle('product.detail', { sku: 'A1' })).rejects.toMatchObject({
      code: 'GLUE.BUSINESS.UPSTREAM_UNKNOWN',
    });
  });

  it('retryableCodes 驱动重试:max 内成功', async () => {
    const card = makeCard({
      sourceCardOverrides: {
        errorMap: {
          extract: codeOf,
          map: { RATE_LIMITED: 'UPSTREAM_RATE_LIMITED' },
          retryableCodes: ['UPSTREAM_RATE_LIMITED'],
        },
      },
    });
    const flaky = mockSource(card.def.sources[0].source.def.ref, (_req, i) =>
      i < 2 ? { body: { error: { code: 'RATE_LIMITED' } } } : { body: GOOD_BODY },
    );
    const { relay } = setup({
      card,
      sources: [flaky],
      policy: { retry: { max: 2, backoff: 'fixed' } },
    });
    const out = await relay.handle('product.detail', { sku: 'A1' });
    expect(out).toEqual({ name: 'X', cents: 990, available: true });
    expect(flaky.mock.calls.length).toBe(3);
  });

  it('重试耗尽 → 抛业务错误;policy.retry 控制次数', async () => {
    const card = makeCard({
      sourceCardOverrides: {
        errorMap: {
          extract: codeOf,
          map: { RATE_LIMITED: 'UPSTREAM_RATE_LIMITED' },
          retryableCodes: ['UPSTREAM_RATE_LIMITED'],
        },
      },
    });
    const flaky = mockSource(card.def.sources[0].source.def.ref, {
      body: { error: { code: 'RATE_LIMITED' } },
    });
    const { relay } = setup({
      card,
      sources: [flaky],
      policy: { retry: { max: 1, backoff: 'fixed' } },
    });
    await expect(relay.handle('product.detail', { sku: 'A1' })).rejects.toMatchObject({
      code: 'GLUE.BUSINESS.UPSTREAM_RATE_LIMITED',
    });
    expect(flaky.mock.calls.length).toBe(2);
  });
});

describe('框架钩子与中间件', () => {
  it('onBusReq 可屏蔽总线字段;onBusRes 可审计响应', async () => {
    const seen: string[] = [];
    const controller = new RelayController({
      hooks: {
        onBusReq: (ctx: { bus: Bus }) => {
          (ctx.bus.req as Record<string, unknown>).internalTag = '***';
          seen.push('req:' + JSON.stringify(ctx.bus.req));
        },
        onBusRes: (ctx: { bus: Bus }) => {
            seen.push('res:' + JSON.stringify(ctx.bus.res));
          },
      },
    });
    const src = mockSource('jd/items/detail', { body: GOOD_BODY });
    const card = makeCard();
    controller.registerSource(src.ref, src.binding);
    controller.registerSourceCard(card.def.sources[0].source);
    controller.registerCard(card);
    controller.setRuntimeConfig('product.detail', { tenantId: 'T-01' });
    await controller.buildRelay().handle('product.detail', { sku: 'A1' });
    expect(seen[0]).toContain('"internalTag":"***"');
    expect(seen[1]).toContain('"jd":{');
  });

  it('接缝中间件:next 前改写 upstream,next 后读取产物', async () => {
    const withMw = defineCard({
      meta: { name: 'product.detail', version: '1.0.0' },
      in: z.object({ sku: z.string() }),
      out: z.object({ name: z.string() }),
      glue: z.object({ skuId: z.string() }),
      toGlue: ({ sku }) => ({ skuId: sku }),
      sources: [
        {
          source: defineSource({
            meta: { name: 'jd.item-title', version: '1.0.0' },
            ref: 'jd/items/detail',
            input: z.object({ skuId: z.string() }),
            upstreamRes: z.object({ item_name: z.string() }),
            output: z.object({ title: z.string() }),
            take: () => ({ method: 'GET' as const, path: '/x' }),
            put: (raw) => ({ title: raw.item_name }),
          }),
          id: 'jd',
          bind: (g) => ({ skuId: g.skuId }),
        },
      ],
      fromGlue: (_g, res) => ({ name: res.jd.title }),
      middlewares: [
        {
          seam: 'take',
          run: async (ctx, next) => {
            await next();
            // next 后:take 产物就绪、transport 未执行 → 此时改写 upstream 生效
            ctx.upstream = {
              ...(ctx.upstream ?? { method: 'GET', path: '/' }),
              headers: { 'x-mw': '1' },
            };
          },
        },
      ],
    });
    const { relay, sources } = setup({ card: withMw });
    await relay.handle('product.detail', { sku: 'A1' });
    const init = sources[0].mock.calls[0].init as RequestInit;
    expect((init.headers as Record<string, string>)['x-mw']).toBe('1');
  });
});

describe('多源站策略', () => {
  /** 两源站卡片引用(id: a/b),fromGlue 优先取 a */
  function twoSourceCard(): RelayCard {
    return defineCard({
      meta: { name: 'product.detail', version: '1.0.0' },
      in: z.object({ sku: z.string() }),
      out: z.object({ name: z.string(), cents: z.number(), available: z.boolean() }),
      glue: z.object({
        skuId: z.string(),
        quantity: z.number(),
        tenantId: inject(z.string()),
        internalTag: redact(z.string()),
      }),
      toGlue: ({ sku }) => ({ skuId: sku, quantity: 1, internalTag: `tag:${sku}` }),
      sources: [
        {
          source: makeSourceCard({ name: 'src.a', ref: 'src/a' }),
          id: 'a',
          bind: (g) => ({ skuId: g.skuId }),
        },
        {
          source: makeSourceCard({ name: 'src.b', ref: 'src/b' }),
          id: 'b',
          bind: (g) => ({ skuId: g.skuId }),
        },
      ],
      fromGlue: (_g, res) => {
        const bundle = res as Record<string, { title: string; priceCents: number; inStock: boolean }>;
        const pick = bundle.a ?? bundle.b;
        return { name: pick.title, cents: pick.priceCents, available: pick.inStock };
      },
    });
  }

  function twoSetup(sources: ReturnType<typeof mockSource>[], strategy: 'firstSuccess' | 'all') {
    const card = twoSourceCard();
    const controller = new RelayController();
    registerCardDeps(controller, card, sources);
    controller.setRuntimeConfig('product.detail', { tenantId: 'T-01' });
    controller.setPolicy('product.detail', { strategy });
    return { relay: controller.buildRelay(), sources };
  }

  it('firstSuccess:源站 a 网络失败(retryable)→ 切换 b 成功', async () => {
    const a = mockSource('src/a', () => {
      throw new TypeError('net down');
    });
    const b = mockSource('src/b', { body: GOOD_BODY });
    const { relay } = twoSetup([a, b], 'firstSuccess');
    const out = await relay.handle('product.detail', { sku: 'A1' });
    expect(out).toEqual({ name: 'X', cents: 990, available: true });
    expect(b.mock.calls.length).toBe(1);
  });

  it('firstSuccess:业务性失败不切换,直接抛出', async () => {
    const base = twoSourceCard();
    const srcA = base.def.sources[0];
    const brokenA = {
      ...srcA.source,
      def: {
        ...srcA.source.def,
        errorMap: {
          extract: (b: unknown) => (b as { error?: { code?: string } } | null)?.error?.code,
          map: { ITEM_NOT_FOUND: 'PRODUCT_NOT_FOUND' },
        },
      },
    };
    const card = patchDef(base, {
      sources: [{ ...srcA, source: brokenA }, base.def.sources[1]],
    });
    const a = mockSource('src/a', { status: 404, body: { error: { code: 'ITEM_NOT_FOUND' } } });
    const b = mockSource('src/b', { body: GOOD_BODY });
    const controller = new RelayController();
    registerCardDeps(controller, card, [a, b]);
    controller.setRuntimeConfig('product.detail', { tenantId: 'T-01' });
    await expect(controller.buildRelay().handle('product.detail', { sku: 'A1' })).rejects.toMatchObject(
      { code: 'GLUE.BUSINESS.PRODUCT_NOT_FOUND' },
    );
    expect(b.mock.calls.length).toBe(0);
  });

  it('all:两个源站都执行,fromGlue 显式聚合', async () => {
    const base = twoSourceCard();
    const card = patchDef(base, {
      fromGlue: ((_g: unknown, res: Record<string, { title: string; priceCents: number; inStock: boolean }>) => ({
        name: `${res.a.title}/${res.b.title}`,
        cents: res.a.priceCents + res.b.priceCents,
        available: res.a.inStock && res.b.inStock,
      })) as never,
    });
    const a = mockSource('src/a', { body: { item_name: 'A', price: 1, stock: 1 } });
    const b = mockSource('src/b', { body: { item_name: 'B', price: 2, stock: 0 } });
    const controller = new RelayController();
    registerCardDeps(controller, card, [a, b]);
    controller.setRuntimeConfig('product.detail', { tenantId: 'T-01' });
    controller.setPolicy('product.detail', { strategy: 'all' });
    const out = (await controller.buildRelay().handle('product.detail', { sku: 'A1' })) as {
      name: string;
    };
    expect(out.name).toBe('A/B');
  });
});

describe('取消与总线摘要', () => {
  it('请求取消 → GLUE.TRANSPORT.CANCELLED', async () => {
    const ac = new AbortController();
    const { relay } = setup();
    const p = relay.handle('product.detail', { sku: 'A1' }, { signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toMatchObject({ code: 'GLUE.TRANSPORT.CANCELLED' });
  });

  it('redact 值不进入 digest 序列化结果', () => {
    const bus = new Bus(['internalTag']);
    bus.req = { internalTag: 'tag:A1' };
    expect(JSON.stringify(bus.digest())).not.toContain('tag:A1');
  });
});
