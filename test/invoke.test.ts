import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineCard, defineSource, GlueError, RelayController } from '../src/index';
import { lastBody, mockSource } from '../src/testing';
import type { ControllerHooks, ErrorMapDef, RelayCard, SourceCard } from '../src/index';
import type { MockedSource, MockResponder } from '../src/testing';
import { registerCardDeps } from './helpers';

// ---------------------------------------------------------------------------
// 源站卡片 fixtures(defineSource 契约不变)
// ---------------------------------------------------------------------------

/** 签发 token(两步依赖的第一步) */
function makeTokenSourceCard(): SourceCard {
  return defineSource({
    meta: { name: 'svc.token', version: '1.0.0' },
    ref: 'svc/token',
    input: z.object({ productId: z.string() }),
    upstreamRes: z.object({ token: z.string(), expiresAt: z.string().nullable() }),
    output: z.object({ value: z.string(), expiresAt: z.string().nullable() }),
    take: ({ productId }) => ({
      method: 'POST' as const,
      path: '/v1/token/issue',
      body: { productId },
    }),
    put: (raw) => ({ value: raw.token, expiresAt: raw.expiresAt }),
  });
}

/** 积分实扣(两步依赖的第二步,消费第一步产物) */
function makeDeductSourceCard(): SourceCard {
  return defineSource({
    meta: { name: 'svc.deduct', version: '1.0.0' },
    ref: 'svc/deduct',
    input: z.object({ token: z.string(), accountId: z.string(), points: z.number() }),
    upstreamRes: z.object({ ok: z.boolean(), balance: z.number() }),
    output: z.object({ ok: z.boolean(), balance: z.number() }),
    take: (i) => ({ method: 'POST' as const, path: '/v1/points/deduct', body: i }),
    put: (raw) => raw, // 直写(identity):upstreamRes 与 output 同构
  });
}

/** 回显源站(并发/降级用) */
function makeEchoSourceCard(tag: string, errorMap?: ErrorMapDef): SourceCard {
  return defineSource({
    meta: { name: `svc.echo-${tag}`, version: '1.0.0' },
    ref: `svc/echo-${tag}`,
    input: z.object({ n: z.number() }),
    upstreamRes: z.object({ v: z.number() }),
    output: z.object({ v: z.number() }),
    take: ({ n }) => ({ method: 'POST' as const, path: '/echo', body: { n } }),
    put: (raw) => raw,
    errorMap,
  });
}

const TOKEN_BODY = { token: 'tok-123', expiresAt: null };
const DEDUCT_BODY = { ok: true, balance: 880 };

/** 组装:mock 源站 + 注册(源站卡片 + 业务卡片)+ buildRelay */
function setupInvoke(
  card: RelayCard,
  sourceCards: SourceCard[],
  bodies: Record<string, MockResponder> = {},
  hooks?: ControllerHooks,
): { controller: RelayController; relay: ReturnType<RelayController['buildRelay']>; mocks: MockedSource[] } {
  const mocks = sourceCards.map((sc) =>
    mockSource(sc.def.ref, bodies[sc.def.ref] ?? { body: { v: 0 } }),
  );
  const controller = new RelayController(hooks ? { hooks } : {});
  registerCardDeps(controller, card, sourceCards, mocks);
  return { controller, relay: controller.buildRelay(), mocks };
}

/** 两步依赖编排卡:collect 先 invoke(token,从 IR 取入参)→ 再 invoke(deduct,显式派生入参) */
function orchestrateCard(token: SourceCard, deduct: SourceCard, extra: SourceCard): RelayCard {
  return defineCard({
    meta: { name: 'orchestrate.deduct', version: '1.0.0' },
    in: z.object({ accountId: z.string(), points: z.number().int().positive() }),
    out: z.object({ receipt: z.string(), balance: z.number() }),
    uses: [token.meta.name, deduct.meta.name, extra.meta.name],
    collect: async (ctx) => {
      const { accountId, points } = ctx.input as { accountId: string; points: number };
      ctx.ir.productId = 'P-SECRET-99'; // 填 IR:token 源站的 input 需要 productId
      const t = (await ctx.invoke(token.meta.name)) as { value: string }; // 省略入参 → 从 IR 取
      await ctx.invoke(deduct.meta.name, { token: t.value, accountId, points }); // 显式派生入参
      // extra 声明于 uses 但编排不调用 → 全程不执行
    },
    respond: (ctx) => {
      const d = ctx.ir[deduct.meta.name] as { ok: boolean; balance: number };
      return { receipt: `rcpt:${d.ok}`, balance: d.balance };
    },
  });
}

describe('collect + ctx.invoke 编排', () => {
  it('两步依赖:invoke(token) 从 IR 取入参 → invoke(deduct, 显式派生入参);未 invoke 的源站不执行', async () => {
    const token = makeTokenSourceCard();
    const deduct = makeDeductSourceCard();
    const extra = makeEchoSourceCard('extra');
    const { relay, mocks } = setupInvoke(orchestrateCard(token, deduct, extra), [token, deduct, extra], {
      'svc/token': { body: TOKEN_BODY },
      'svc/deduct': { body: DEDUCT_BODY },
    });
    const [tokenMock, deductMock, extraMock] = mocks;

    const out = await relay.handle('orchestrate.deduct', { accountId: 'A-1', points: 120 });
    expect(out).toEqual({ receipt: 'rcpt:true', balance: 880 });

    // token 步:省略 input → 从 IR 取 productId(collect 写入)
    expect(tokenMock!.mock.calls).toHaveLength(1);
    expect(tokenMock!.mock.calls[0]!.url).toContain('/v1/token/issue');
    expect(lastBody(tokenMock!.mock)).toEqual({ productId: 'P-SECRET-99' });

    // deduct 步:显式传参,携带上一步产物
    expect(deductMock!.mock.calls).toHaveLength(1);
    expect(lastBody(deductMock!.mock)).toEqual({ token: 'tok-123', accountId: 'A-1', points: 120 });

    // uses 声明但编排未 invoke → 全程不执行
    expect(extraMock!.mock.calls).toHaveLength(0);
  });

  it('并发编排:Promise.all 多路 invoke,ir 命名空间互不踩', async () => {
    const a = makeEchoSourceCard('a');
    const b = makeEchoSourceCard('b');
    const card = defineCard({
      meta: { name: 'orchestrate.parallel', version: '1.0.0' },
      in: z.object({}),
      out: z.object({ a: z.number(), b: z.number() }),
      uses: [a.meta.name, b.meta.name],
      collect: async (ctx) => {
        await Promise.all([ctx.invoke(a.meta.name, { n: 1 }), ctx.invoke(b.meta.name, { n: 2 })]);
      },
      respond: (ctx) => ({
        a: (ctx.ir[a.meta.name] as { v: number }).v,
        b: (ctx.ir[b.meta.name] as { v: number }).v,
      }),
    });
    const { relay, mocks } = setupInvoke(card, [a, b], {
      'svc/echo-a': { body: { v: 11 } },
      'svc/echo-b': { body: { v: 22 } },
    });
    const out = await relay.handle('orchestrate.parallel', {});
    expect(out).toEqual({ a: 11, b: 22 });
    expect(lastBody(mocks[0]!.mock)).toEqual({ n: 1 });
    expect(lastBody(mocks[1]!.mock)).toEqual({ n: 2 });
  });

  it('失败降级:主源站业务失败 → collect 手写 try/catch → invoke 兜底源站', async () => {
    const primary = makeEchoSourceCard('primary', { fallback: 'PRIMARY_DOWN' });
    const backup = makeEchoSourceCard('backup');
    let caught: unknown;
    const card = defineCard({
      meta: { name: 'orchestrate.fallback', version: '1.0.0' },
      in: z.object({}),
      out: z.object({ v: z.number() }),
      uses: [primary.meta.name, backup.meta.name],
      collect: async (ctx) => {
        try {
          await ctx.invoke(primary.meta.name, { n: 1 });
        } catch (e) {
          caught = e; // 降级由编排逻辑决定(框架不再自动切换)
        }
        await ctx.invoke(backup.meta.name, { n: 2 });
      },
      respond: (ctx) => ({ v: (ctx.ir[backup.meta.name] as { v: number }).v }),
    });
    const { relay, mocks } = setupInvoke(card, [primary, backup], {
      'svc/echo-primary': { status: 500, body: { error: 'boom' } },
      'svc/echo-backup': { body: { v: 2 } },
    });
    const out = await relay.handle('orchestrate.fallback', {});
    expect(out).toEqual({ v: 2 });
    expect(caught).toBeInstanceOf(GlueError);
    expect((caught as GlueError).code).toBe('GLUE.BUSINESS.PRIMARY_DOWN');
    expect(mocks[0]!.mock.calls).toHaveLength(1); // 失败一次,未重试(retry.max 缺省 0)
    expect(mocks[1]!.mock.calls).toHaveLength(1); // 兜底执行一次
  });

  it('onBusRes 逐步触发:次数 = 实际 invoke 数;IR 逐步累积可见', async () => {
    const token = makeTokenSourceCard();
    const deduct = makeDeductSourceCard();
    const extra = makeEchoSourceCard('extra');
    let count = 0;
    const snapshots: string[][] = [];
    const hooks: ControllerHooks = {
      onBusRes: (ctx) => {
        count++;
        snapshots.push(Object.keys(ctx.ir).sort()); // 宿主治理动作:直接读 IR
      },
    };
    const { relay } = setupInvoke(
      orchestrateCard(token, deduct, extra),
      [token, deduct, extra],
      { 'svc/token': { body: TOKEN_BODY }, 'svc/deduct': { body: DEDUCT_BODY } },
      hooks,
    );
    await relay.handle('orchestrate.deduct', { accountId: 'A-1', points: 120 });
    expect(count).toBe(2); // token + deduct;extra 未 invoke 不触发
    expect(snapshots[1]).toContain('svc.token');
    expect(snapshots[1]).toContain('svc.deduct');
  });

  it('守卫:invoke 未注册的源站卡片 → GLUE.CARD.SOURCE_NOT_REGISTERED', async () => {
    const token = makeTokenSourceCard();
    const card = defineCard({
      meta: { name: 'r.ghost', version: '1.0.0' },
      in: z.object({}),
      out: z.object({ ok: z.boolean() }),
      collect: async (ctx) => {
        await ctx.invoke('ghost');
      },
      respond: () => ({ ok: true }),
    });
    const { relay } = setupInvoke(card, [token], { 'svc/token': { body: TOKEN_BODY } });
    const e = await relay.handle('r.ghost', {}).catch((x: unknown) => x);
    expect(e).toMatchObject({ code: 'GLUE.CARD.SOURCE_NOT_REGISTERED', sourceId: 'ghost' });
  });

  it('校验点不旁路:invoke(id, 坏 input) → GLUE.SCHEMA.INPUT', async () => {
    const deduct = makeDeductSourceCard();
    const card = defineCard({
      meta: { name: 'r.badinput', version: '1.0.0' },
      in: z.object({ accountId: z.string(), points: z.number() }),
      out: z.object({ ok: z.boolean() }),
      uses: [deduct.meta.name],
      collect: async (ctx) => {
        await ctx.invoke(deduct.meta.name, { token: 123, accountId: 'A-1', points: 1 });
      },
      respond: () => ({ ok: true }),
    });
    const { relay } = setupInvoke(card, [deduct], { 'svc/deduct': { body: DEDUCT_BODY } });
    const e = await relay
      .handle('r.badinput', { accountId: 'A-1', points: 1 })
      .catch((x: unknown) => x);
    expect(e).toMatchObject({ code: 'GLUE.SCHEMA.INPUT', sourceId: deduct.meta.name });
  });

  it('respond 阶段无 invoke(运行时不可再调 API 卡片)', async () => {
    const token = makeTokenSourceCard();
    let hasInvoke: unknown;
    const card = defineCard({
      meta: { name: 'r.noinvoke', version: '1.0.0' },
      in: z.object({}),
      out: z.object({ ok: z.boolean() }),
      uses: [token.meta.name],
      collect: async (ctx) => {
        ctx.ir.productId = 'P';
        await ctx.invoke(token.meta.name);
      },
      respond: (ctx) => {
        hasInvoke = 'invoke' in ctx; // 类型层已 Omit;运行时也确实被移除
        return { ok: true };
      },
    });
    const { relay } = setupInvoke(card, [token], { 'svc/token': { body: TOKEN_BODY } });
    await relay.handle('r.noinvoke', {});
    expect(hasInvoke).toBe(false);
  });
});
