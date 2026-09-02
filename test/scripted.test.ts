import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  defineCard,
  defineSource,
  GlueError,
  redact,
  RelayController,
} from '../src/index';
import { lastBody, mockSource } from '../src/testing';
import type {
  ControllerHooks,
  ErrorMapDef,
  RawCardDef,
  RelayCard,
  RelayMiddleware,
  SourceCard,
} from '../src/index';
import type { MockedSource, MockResponder } from '../src/testing';
import { makeCard, registerCardDeps, setup } from './helpers';

// ---------------------------------------------------------------------------
// 源站卡片 fixtures
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
    take: (i) => ({
      method: 'POST' as const,
      path: '/v1/points/deduct',
      body: i,
    }),
    put: (raw) => raw, // 直写(identity):upstreamRes 与 output 同构
  });
}

/** 回显源站(并发/降级用;put 省略,upstreamRes 直写 res) */
function makeEchoSourceCard(tag: string, errorMap?: ErrorMapDef): SourceCard {
  return defineSource({
    meta: { name: `svc.echo-${tag}`, version: '1.0.0' },
    ref: `svc/echo-${tag}`,
    input: z.object({ n: z.number() }),
    upstreamRes: z.object({ v: z.number() }),
    output: z.object({ v: z.number() }),
    take: ({ n }) => ({ method: 'POST' as const, path: '/echo', body: { n } }),
    put: (raw) => raw, // 直写(identity):upstreamRes 与 output 同构
    errorMap,
  });
}

// ---------------------------------------------------------------------------
// 业务卡片 fixtures(scripted 编排卡:编排逻辑住在卡片自带中间件里)
// ---------------------------------------------------------------------------

const TOKEN_BODY = { token: 'tok-123', expiresAt: null };
const DEDUCT_BODY = { ok: true, balance: 880 };

/** 默认编排:先拿 token → 携带产物实扣(省略 input 走 bind + 显式传参跳过 bind 各一次) */
function orchestrationMw(): RelayMiddleware {
  return {
    seam: 'fromGlue',
    name: 'orchestration',
    run: async (ctx, next) => {
      const token = (await ctx.invoke('token')) as { value: string };
      const req = ctx.bus.req as { accountId: string; points: number };
      await ctx.invoke('deduct', {
        token: token.value,
        accountId: req.accountId,
        points: req.points,
      });
      await next();
    },
  };
}

function makeOrchestrateCard(middleware?: RelayMiddleware): RelayCard {
  return defineCard({
    meta: { name: 'orchestrate.deduct', version: '1.0.0' },
    in: z.object({ accountId: z.string(), points: z.number().int().positive() }),
    out: z.object({ receipt: z.string(), balance: z.number() }),
    glue: z.object({
      accountId: z.string(),
      points: z.number(),
      productId: redact(z.string()),
    }),
    toGlue: (i) => ({ accountId: i.accountId, points: i.points, productId: 'P-SECRET-99' }),
    sources: [
      { source: makeTokenSourceCard(), id: 'token', bind: (g) => ({ productId: g.productId }) },
      {
        source: makeDeductSourceCard(),
        id: 'deduct',
        bind: (g) => ({ token: '', accountId: g.accountId, points: g.points }),
      },
      // 声明但编排不调用:证明 scripted 下不自动执行
      { source: makeEchoSourceCard('extra'), id: 'extra', bind: () => ({ n: 0 }) },
    ],
    middlewares: [middleware ?? orchestrationMw()],
    fromGlue: (_g, res) => ({ receipt: `rcpt:${res.deduct.ok}`, balance: res.deduct.balance }),
  });
}

function makeConcurrentCard(middleware: RelayMiddleware): RelayCard {
  return defineCard({
    meta: { name: 'orchestrate.parallel', version: '1.0.0' },
    in: z.object({}),
    out: z.object({ a: z.number(), b: z.number() }),
    glue: z.object({}),
    toGlue: () => ({}),
    sources: [
      { source: makeEchoSourceCard('a'), id: 'a', bind: () => ({ n: 0 }) },
      { source: makeEchoSourceCard('b'), id: 'b', bind: () => ({ n: 0 }) },
    ],
    middlewares: [middleware],
    fromGlue: (_g, res) => ({ a: res.a.v, b: res.b.v }),
  });
}

function makeFallbackCard(middleware: RelayMiddleware): RelayCard {
  return defineCard({
    meta: { name: 'orchestrate.fallback', version: '1.0.0' },
    in: z.object({}),
    out: z.object({ v: z.number() }),
    glue: z.object({}),
    toGlue: () => ({}),
    sources: [
      {
        source: makeEchoSourceCard('primary', { fallback: 'PRIMARY_DOWN' }),
        id: 'primary',
        bind: () => ({ n: 1 }),
      },
      { source: makeEchoSourceCard('backup'), id: 'backup', bind: () => ({ n: 2 }) },
    ],
    middlewares: [middleware],
    fromGlue: (_g, res) => ({ v: res.backup.v }),
  });
}

// ---------------------------------------------------------------------------
// 组装
// ---------------------------------------------------------------------------

/** scripted 组装:mock 源站 + 注册 + setPolicy(scripted) + buildRelay */
function setupScripted(
  card: RelayCard,
  opts: { hooks?: ControllerHooks; bodies?: Record<string, MockResponder> } = {},
): { controller: RelayController; relay: ReturnType<RelayController['buildRelay']>; mocks: MockedSource[] } {
  const bodies = opts.bodies ?? {};
  const mocks = card.def.sources.map((s) =>
    mockSource(s.source.def.ref, bodies[s.source.def.ref] ?? { body: { v: 0 } }),
  );
  const controller = new RelayController({ hooks: opts.hooks });
  registerCardDeps(controller, card, mocks);
  controller.setPolicy(card.meta.name, { strategy: 'scripted' });
  return { controller, relay: controller.buildRelay(), mocks };
}

/** 构造"运行时行为故意错误"的卡片(类型上合法,用于触达守卫) */
function patchDef(card: RelayCard, patch: Partial<RawCardDef>): RelayCard {
  return { ...card, def: { ...card.def, ...patch } } as RelayCard;
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

describe('scripted 策略 + ctx.invoke 编排', () => {
  it('两步依赖:invoke(token) 产物 → invoke(deduct, 派生入参);未经 invoke 的源站不自动执行', async () => {
    const { relay, mocks } = setupScripted(makeOrchestrateCard(), {
      bodies: { 'svc/token': { body: TOKEN_BODY }, 'svc/deduct': { body: DEDUCT_BODY } },
    });
    const [tokenMock, deductMock, extraMock] = mocks;

    const out = await relay.handle('orchestrate.deduct', { accountId: 'A-1', points: 120 });
    expect(out).toEqual({ receipt: 'rcpt:true', balance: 880 });

    // token 步:省略 input → 走 bind(glue),productId 来自 toGlue
    expect(tokenMock.mock.calls).toHaveLength(1);
    expect(tokenMock.mock.calls[0].url).toContain('/v1/token/issue');
    expect(lastBody(tokenMock.mock)).toEqual({ productId: 'P-SECRET-99' });

    // deduct 步:显式传参跳过 bind,携带上一步产物
    expect(deductMock.mock.calls).toHaveLength(1);
    expect(lastBody(deductMock.mock)).toEqual({
      token: 'tok-123',
      accountId: 'A-1',
      points: 120,
    });

    // 声明了但编排未调用 → 全程不执行
    expect(extraMock.mock.calls).toHaveLength(0);
  });

  it('并发编排:Promise.all 多路 invoke,res 命名空间互不踩', async () => {
    const mw: RelayMiddleware = {
      seam: 'fromGlue',
      run: async (ctx, next) => {
        await Promise.all([ctx.invoke('a', { n: 1 }), ctx.invoke('b', { n: 2 })]);
        await next();
      },
    };
    const { relay, mocks } = setupScripted(makeConcurrentCard(mw), {
      bodies: { 'svc/echo-a': { body: { v: 11 } }, 'svc/echo-b': { body: { v: 22 } } },
    });
    const [aMock, bMock] = mocks;

    const out = await relay.handle('orchestrate.parallel', {});
    expect(out).toEqual({ a: 11, b: 22 });
    expect(lastBody(aMock.mock)).toEqual({ n: 1 });
    expect(lastBody(bMock.mock)).toEqual({ n: 2 });
  });

  it('失败降级:主源站业务失败 → 编排 catch → invoke 兜底源站,out 来自兜底', async () => {
    let caught: unknown;
    const mw: RelayMiddleware = {
      seam: 'fromGlue',
      run: async (ctx, next) => {
        try {
          await ctx.invoke('primary', { n: 1 });
        } catch (e) {
          caught = e;
        }
        await ctx.invoke('backup', { n: 2 });
        await next();
      },
    };
    const { relay, mocks } = setupScripted(makeFallbackCard(mw), {
      bodies: {
        // 非 2xx 且未命中 map → fallback PRIMARY_DOWN(不可重试,retry.max=0 不重试)
        'svc/echo-primary': { status: 500, body: { error: 'boom' } },
        'svc/echo-backup': { body: { v: 2 } },
      },
    });

    const out = await relay.handle('orchestrate.fallback', {});
    expect(out).toEqual({ v: 2 });
    expect(caught).toBeInstanceOf(GlueError);
    expect((caught as GlueError).code).toBe('GLUE.BUSINESS.PRIMARY_DOWN');
    expect(mocks[0].mock.calls).toHaveLength(1); // 失败一次,未重试
    expect(mocks[1].mock.calls).toHaveLength(1); // 兜底执行一次
  });

  it('onBusRes 逐步触发:次数 = 实际执行的源站段数;digest 全量可见且 redact 打码', async () => {
    const digests: unknown[] = [];
    let count = 0;
    const hooks: ControllerHooks = {
      onBusRes: (ctx) => {
        count++;
        digests.push(ctx.bus.digest());
      },
    };
    const { relay } = setupScripted(makeOrchestrateCard(), {
      hooks,
      bodies: { 'svc/token': { body: TOKEN_BODY }, 'svc/deduct': { body: DEDUCT_BODY } },
    });

    await relay.handle('orchestrate.deduct', { accountId: 'A-1', points: 120 });
    expect(count).toBe(2); // token + deduct;extra 未 invoke 不触发

    const d0 = digests[0] as { req: { productId: string }; res: Record<string, unknown> };
    const d1 = digests[1] as { req: { productId: string }; res: Record<string, unknown> };
    expect(d0.req.productId).toBe('***99'); // redact 字段在审计摘要中打码
    expect(Object.keys(d1.res).sort()).toEqual(['deduct', 'token']); // IR 逐步累积
  });

  it('守卫:非 scripted 卡调用 invoke → GLUE.CARD.INVOKE_FORBIDDEN', async () => {
    const card = patchDef(makeCard(), {
      middlewares: [
        {
          seam: 'fromGlue',
          run: async (ctx, next) => {
            await ctx.invoke('jd');
            await next();
          },
        },
      ],
    });
    const { relay, sources } = setup({ card });
    const e = await relay.handle('product.detail', { sku: 'A1' }).catch((x: unknown) => x);
    expect(e).toMatchObject({ code: 'GLUE.CARD.INVOKE_FORBIDDEN' });
    expect(sources[0].mock.calls).toHaveLength(1); // 仅自动编排执行过一次,invoke 未触达源站
  });

  it('守卫:invoke 未声明的 sourceId → GLUE.CARD.SOURCE_NOT_DECLARED', async () => {
    const mw: RelayMiddleware = {
      seam: 'fromGlue',
      run: async (ctx, next) => {
        await ctx.invoke('ghost');
        await next();
      },
    };
    const ghostCard = patchDef(makeOrchestrateCard(), { middlewares: [mw] });
    const { relay } = setupScripted(ghostCard, {
      bodies: { 'svc/token': { body: TOKEN_BODY }, 'svc/deduct': { body: DEDUCT_BODY } },
    });
    const e = await relay
      .handle('orchestrate.deduct', { accountId: 'A-1', points: 1 })
      .catch((x: unknown) => x);
    expect(e).toMatchObject({ code: 'GLUE.CARD.SOURCE_NOT_DECLARED', sourceId: 'ghost' });
  });

  it('校验点不旁路:invoke(id, 坏 input) → GLUE.SCHEMA.INPUT', async () => {
    const mw: RelayMiddleware = {
      seam: 'fromGlue',
      run: async (ctx, next) => {
        await ctx.invoke('deduct', { token: 123, accountId: 'A-1', points: 1 });
        await next();
      },
    };
    const { relay } = setupScripted(makeOrchestrateCard(mw), {
      bodies: { 'svc/token': { body: TOKEN_BODY }, 'svc/deduct': { body: DEDUCT_BODY } },
    });
    const e = await relay
      .handle('orchestrate.deduct', { accountId: 'A-1', points: 1 })
      .catch((x: unknown) => x);
    expect(e).toMatchObject({ code: 'GLUE.SCHEMA.INPUT', sourceId: 'deduct' });
  });

  it('manifest.suggests.strategy = scripted 生效(未生效则 invoke 会抛 INVOKE_FORBIDDEN)', async () => {
    const card = makeOrchestrateCard();
    const bodies: Record<string, MockResponder> = {
      'svc/token': { body: TOKEN_BODY },
      'svc/deduct': { body: DEDUCT_BODY },
    };
    const mocks = card.def.sources.map((s) => mockSource(s.source.def.ref, bodies[s.source.def.ref] ?? { body: { v: 0 } }));
    const controller = new RelayController();
    for (const s of mocks) controller.registerSource(s.ref, s.binding);
    const seen = new Set<string>();
    for (const srcRef of card.def.sources) {
      const key = `${srcRef.source.meta.name}@${srcRef.source.meta.version}`;
      if (!seen.has(key)) {
        seen.add(key);
        controller.registerSourceCard(srcRef.source);
      }
    }
    controller.registerCard(card, {
      name: card.meta.name,
      version: card.meta.version,
      entry: '(inline)',
      requires: { sources: [...card.sourceCardNames], injections: [...card.injectKeys] },
      suggests: { strategy: 'scripted' },
    });
    const relay = controller.buildRelay();

    // 成功即证明 scripted 生效:firstSuccess 下 invoke 会被守卫拒绝
    const out = await relay.handle('orchestrate.deduct', { accountId: 'A-1', points: 120 });
    expect(out).toEqual({ receipt: 'rcpt:true', balance: 880 });
  });
});
