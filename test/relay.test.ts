import { describe, expect, it } from 'vitest';
import { mockSource } from '../src/testing';
import type { RawCardDef, RelayCard, SourceCard } from '../src/index';
import { GOOD_BODY, makeCard, makeSourceCard, setup } from './helpers';

const JD = 'jd.item-detail';

/** 构造"运行时行为故意错误"的卡片(类型上合法,用于触达各校验点) */
function patchDef(card: RelayCard, patch: Partial<RawCardDef>): RelayCard {
  return { ...card, def: { ...card.def, ...patch } } as RelayCard;
}

/** 构造"运行时行为故意错误"的源站卡片(take/put 等) */
function brokenSource(patch: Record<string, unknown>): SourceCard {
  const sc = makeSourceCard();
  return { ...sc, def: { ...sc.def, ...patch } } as SourceCard;
}

describe('relay.handle 全链路(单源站)', () => {
  it('happy path:入站请求 → IR → invoke → take → transport → put → 出参', async () => {
    const { relay, sources } = setup();
    const out = await relay.handle('product.detail', { sku: 'A1' });
    expect(out).toEqual({ name: 'X', cents: 990, available: true });
    expect(sources[0]!.mock.calls[0]!.url).toContain('/v2/items/A1?fmt=json');
  });

  it('入站请求带 count → collect 写进 IR', async () => {
    const { relay } = setup();
    const out = (await relay.handle('product.detail', { sku: 'A1', count: 3 })) as { name: string };
    expect(out.name).toBe('X');
  });

  it('① in 校验失败 → GLUE.SCHEMA.IN / 400', async () => {
    const { relay } = setup();
    const e = await relay.handle('product.detail', { sku: 123 }).catch((x: unknown) => x);
    expect(e).toMatchObject({ code: 'GLUE.SCHEMA.IN', status: 400 });
  });

  it('③ invoke 从 IR 取入参违反 source.input → GLUE.SCHEMA.INPUT', async () => {
    const broken = patchDef(makeCard(), {
      collect: async (ctx) => {
        ctx.ir.skuId = 123; // 故意写错类型:invoke 从 IR 取 skuId 时被 input 校验点拦下
        await ctx.invoke(JD);
      },
    });
    const { relay } = setup({ card: broken });
    const e = await relay.handle('product.detail', { sku: 'A1' }).catch((x: unknown) => x);
    expect(e).toMatchObject({ code: 'GLUE.SCHEMA.INPUT' });
  });

  it('③b take 产物违反 request 契约 → GLUE.SCHEMA.REQUEST', async () => {
    const sc = brokenSource({ take: () => ({ method: 'GET', path: '/x', query: { fmt: 'xml' } }) });
    const { relay } = setup({ card: makeCard({ sourceCard: sc }), sourceCards: [sc] });
    const e = await relay.handle('product.detail', { sku: 'A1' }).catch((x: unknown) => x);
    expect(e).toMatchObject({ code: 'GLUE.SCHEMA.REQUEST' });
  });

  it('④ 源站响应违反 upstreamRes → GLUE.SCHEMA.UPSTREAM_RES', async () => {
    const { relay } = setup({ mockBody: { wrong: 'shape' } });
    const e = await relay.handle('product.detail', { sku: 'A1' }).catch((x: unknown) => x);
    expect(e).toMatchObject({ code: 'GLUE.SCHEMA.UPSTREAM_RES' });
  });

  it('⑤ put 产物违反源站 output → GLUE.SCHEMA.OUTPUT', async () => {
    const sc = brokenSource({ put: () => ({ title: 1 }) });
    const { relay } = setup({ card: makeCard({ sourceCard: sc }), sourceCards: [sc] });
    const e = await relay.handle('product.detail', { sku: 'A1' }).catch((x: unknown) => x);
    expect(e).toMatchObject({ code: 'GLUE.SCHEMA.OUTPUT' });
  });

  it('⑥ respond 产物违反 out → GLUE.SCHEMA.OUT', async () => {
    const broken = patchDef(makeCard(), {
      respond: (() => ({ name: 'x', cents: 'bad' })) as never,
    });
    const { relay } = setup({ card: broken });
    const e = await relay.handle('product.detail', { sku: 'A1' }).catch((x: unknown) => x);
    expect(e).toMatchObject({ code: 'GLUE.SCHEMA.OUT' });
  });

  it('strict=false 跳过校验(脏数据直通)', async () => {
    const broken = patchDef(makeCard(), {
      respond: (() => ({ name: 'x', cents: 'bad' })) as never,
    });
    const { relay } = setup({ card: broken });
    const out = await relay.handle('product.detail', { sku: 'A1' }, { strict: false });
    expect(out).toEqual({ name: 'x', cents: 'bad' });
  });

  it('未知卡片 → GLUE.CARD.NOT_FOUND', async () => {
    const { relay } = setup();
    await expect(relay.handle('nope', {})).rejects.toMatchObject({ code: 'GLUE.CARD.NOT_FOUND' });
  });
});

describe('错误映射', () => {
  const codeOf = (b: unknown) => (b as { error?: { code?: string } } | null)?.error?.code;

  it('extract + map → GLUE.BUSINESS.<mapped>,raw 不外泄', async () => {
    const sc = makeSourceCard({
      errorMap: {
        extract: codeOf,
        map: { ITEM_NOT_FOUND: 'PRODUCT_NOT_FOUND' },
        fallback: 'UPSTREAM_UNKNOWN',
      },
    });
    const { relay } = setup({
      card: makeCard({ sourceCard: sc }),
      sourceCards: [sc],
      mockBody: { error: { code: 'ITEM_NOT_FOUND' } },
    });
    const e = await relay.handle('product.detail', { sku: 'A1' }).catch((x: unknown) => x);
    expect(e).toMatchObject({ code: 'GLUE.BUSINESS.PRODUCT_NOT_FOUND', retryable: false });
    expect(JSON.stringify(e)).not.toContain('ITEM_NOT_FOUND');
  });

  it('非 2xx 无码 → fallback', async () => {
    const sc = makeSourceCard({ errorMap: { extract: codeOf, fallback: 'UPSTREAM_UNKNOWN' } });
    const mock = mockSource(sc.def.ref, { status: 500, body: { unexpected: true } });
    const { relay } = setup({ card: makeCard({ sourceCard: sc }), sourceCards: [sc], mocks: [mock] });
    await expect(relay.handle('product.detail', { sku: 'A1' })).rejects.toMatchObject({
      code: 'GLUE.BUSINESS.UPSTREAM_UNKNOWN',
    });
  });

  it('retryableCodes 驱动重试:max 内成功', async () => {
    const sc = makeSourceCard({
      errorMap: {
        extract: codeOf,
        map: { RATE_LIMITED: 'UPSTREAM_RATE_LIMITED' },
        retryableCodes: ['UPSTREAM_RATE_LIMITED'],
      },
    });
    const flaky = mockSource(sc.def.ref, (_req, i) =>
      i < 2 ? { body: { error: { code: 'RATE_LIMITED' } } } : { body: GOOD_BODY },
    );
    const { relay } = setup({
      card: makeCard({ sourceCard: sc }),
      sourceCards: [sc],
      mocks: [flaky],
      policy: { retry: { max: 2, backoff: 'fixed' } },
    });
    const out = await relay.handle('product.detail', { sku: 'A1' });
    expect(out).toEqual({ name: 'X', cents: 990, available: true });
    expect(flaky.mock.calls.length).toBe(3);
  });

  it('重试耗尽 → 抛业务错误;policy.retry 控制次数', async () => {
    const sc = makeSourceCard({
      errorMap: {
        extract: codeOf,
        map: { RATE_LIMITED: 'UPSTREAM_RATE_LIMITED' },
        retryableCodes: ['UPSTREAM_RATE_LIMITED'],
      },
    });
    const flaky = mockSource(sc.def.ref, { body: { error: { code: 'RATE_LIMITED' } } });
    const { relay } = setup({
      card: makeCard({ sourceCard: sc }),
      sourceCards: [sc],
      mocks: [flaky],
      policy: { retry: { max: 1, backoff: 'fixed' } },
    });
    await expect(relay.handle('product.detail', { sku: 'A1' })).rejects.toMatchObject({
      code: 'GLUE.BUSINESS.UPSTREAM_RATE_LIMITED',
    });
    expect(flaky.mock.calls.length).toBe(2);
  });
});

describe('框架钩子(宿主规则在 IR 上的执行点)', () => {
  it('onBusReq 在 collect 前触发(IR 仅含 seeds);onBusRes 每次 invoke 后带 sourceId', async () => {
    const events: string[] = [];
    const { relay } = setup({
      hooks: {
        onBusReq: (ctx) => {
          events.push('req:' + JSON.stringify(ctx.ir));
        },
        onBusRes: (ctx) => {
          events.push(`res:${ctx.sourceId}:${JSON.stringify(ctx.ir[ctx.sourceId!])}`);
        },
      },
    });
    await relay.handle('product.detail', { sku: 'A1' });
    expect(events[0]).toBe('req:{"tenantId":"T-01"}');
    expect(events[1]).toContain('res:jd.item-detail:');
    expect(events[1]).toContain('"title":"X"');
  });

  it('onBusReq 可预填/屏蔽 IR,collect 可见', async () => {
    let seenTag: unknown;
    const card = patchDef(makeCard(), {
      collect: async (ctx) => {
        seenTag = ctx.ir.internalTag; // 宿主在 collect 前写入的值
        ctx.ir.skuId = (ctx.input as { sku: string }).sku;
        await ctx.invoke(JD);
      },
    });
    const { relay } = setup({ card, hooks: { onBusReq: (ctx) => { ctx.ir.internalTag = '***'; } } });
    await relay.handle('product.detail', { sku: 'A1' });
    expect(seenTag).toBe('***');
  });
});

describe('取消', () => {
  it('请求取消 → GLUE.TRANSPORT.CANCELLED', async () => {
    const ac = new AbortController();
    const { relay } = setup();
    const p = relay.handle('product.detail', { sku: 'A1' }, { signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toMatchObject({ code: 'GLUE.TRANSPORT.CANCELLED' });
  });
});
