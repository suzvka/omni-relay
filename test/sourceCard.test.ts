import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineCard, defineSource, RelayController } from '../src/index';
import type { SourceCard } from '../src/index';
import { mockSource } from '../src/testing';
import { GOOD_BODY, makeSourceCard, setup } from './helpers';

describe('defineSource 声明期校验', () => {
  it('正常定义并冻结', () => {
    const sc = makeSourceCard();
    expect(sc.meta).toEqual({ name: 'jd.item-detail', version: '1.0.0' });
    expect(sc.def.ref).toBe('jd/items/detail');
    expect(Object.isFrozen(sc)).toBe(true);
  });

  it('缺 meta.name → 拒绝', () => {
    expect(() =>
      defineSource({
        ref: 'a/b',
        input: z.object({}),
        output: z.object({}),
        upstreamRes: z.object({}),
        take: () => ({ method: 'GET', path: '/' }),
        put: () => ({}),
      } as never),
    ).toThrow(/meta.name/);
  });

  it('缺 ref → 拒绝', () => {
    expect(() => defineSource({ ...makeSourceCard().def, ref: '' })).toThrow(/ref 必填/);
  });

  it('input 非 zod → 拒绝', () => {
    expect(() =>
      defineSource({ ...makeSourceCard().def, input: { not: 'zod' } as never }),
    ).toThrow(/input 必须是 Zod schema/);
  });

  it('缺 take → 拒绝', () => {
    expect(() =>
      defineSource({ ...makeSourceCard().def, take: undefined as never }),
    ).toThrow(/take 必须是函数/);
  });

  it('非流式缺 put → 拒绝;声明 stream 可省略', () => {
    expect(() =>
      defineSource({ ...makeSourceCard().def, put: undefined as never }),
    ).toThrow(/put 必须是函数/);
    expect(() =>
      defineSource({ ...makeSourceCard().def, put: undefined, stream: true }),
    ).not.toThrow();
  });
});

describe('源站卡片注册(中心化注册表)', () => {
  it('物理绑定未就绪 → 拒绝', () => {
    expect(() => new RelayController().registerSourceCard(makeSourceCard())).toThrow(
      /源站未注册/,
    );
  });

  it('同名同版本重复注册 → 拒绝;新版本可替换', () => {
    const src = mockSource('jd/items/detail', { body: GOOD_BODY });
    const c = new RelayController().registerSource(src.ref, src.binding);
    c.registerSourceCard(makeSourceCard());
    expect(() => c.registerSourceCard(makeSourceCard())).toThrow(/已注册/);
    const v2def = { ...makeSourceCard().def, meta: { name: 'jd.item-detail', version: '1.1.0' } };
    c.registerSourceCard({ def: v2def, meta: { name: 'jd.item-detail', version: '1.1.0' } } as SourceCard);
    expect(c.listSourceCards().map((s) => s.version)).toContain('1.1.0');
  });

  it('业务卡片 uses 未注册源站卡片 → registerCard 拒绝', () => {
    const src = mockSource('jd/items/detail', { body: GOOD_BODY });
    const c = new RelayController().registerSource(src.ref, src.binding);
    const card = defineCard({
      meta: { name: 'x.y', version: '1.0.0' },
      in: z.object({}),
      out: z.object({}),
      uses: ['jd.item-detail'],
      collect: async () => {},
      respond: () => ({}),
    });
    expect(() => c.registerCard(card)).toThrow(/源站卡片未注册/);
  });
});

describe('运行时链路', () => {
  it('分支参数:input 分支字段驱动 take 路由不同端点', async () => {
    const branched = defineSource({
      meta: { name: 'jd.branched', version: '1.0.0' },
      ref: 'jd/items/detail',
      input: z.object({ skuId: z.string(), mode: z.enum(['detail', 'price']) }),
      upstreamRes: z.object({ v: z.string() }),
      output: z.object({ v: z.string() }),
      take: ({ skuId, mode }) => ({
        method: 'GET' as const,
        path: mode === 'detail' ? '/v2/items/:skuId/full' : '/v2/items/:skuId/price',
        params: { skuId },
      }),
      put: (raw) => ({ v: raw.v }),
    });
    const card = defineCard({
      meta: { name: 'x.y', version: '1.0.0' },
      in: z.object({ sku: z.string(), mode: z.enum(['detail', 'price']) }),
      out: z.object({ v: z.string() }),
      uses: [branched.meta.name],
      collect: async (ctx) => {
        const { sku, mode } = ctx.input as { sku: string; mode: 'detail' | 'price' };
        ctx.ir.skuId = sku; // 填 IR:源站 input 需要 skuId + mode
        ctx.ir.mode = mode;
        await ctx.invoke(branched.meta.name);
      },
      respond: (ctx) => ({ v: (ctx.ir[branched.meta.name] as { v: string }).v }),
    });
    const { relay, sources } = setup({ card, sourceCards: [branched], mockBody: { v: 'ok' } });
    await relay.handle('x.y', { sku: 'A1', mode: 'price' });
    expect(sources[0]!.mock.calls[0]!.url).toContain('/v2/items/A1/price');
  });

  it('invoke 从 IR 取入参违反 input → GLUE.SCHEMA.INPUT(脏参数被拦在源站之外)', async () => {
    const sc = makeSourceCard();
    const broken = defineCard({
      meta: { name: 'product.detail', version: '1.0.0' },
      in: z.object({ sku: z.string() }),
      out: z.object({ name: z.string() }),
      uses: [sc.meta.name],
      collect: async (ctx) => {
        await ctx.invoke(sc.meta.name); // 故意不往 IR 写 skuId → input 校验点缺字段
      },
      respond: (ctx) => ({ name: (ctx.ir[sc.meta.name] as { title: string }).title }),
    });
    const { relay } = setup({ card: broken, sourceCards: [sc] });
    const e = await relay.handle('product.detail', { sku: 'A1' }).catch((x: unknown) => x);
    expect(e).toMatchObject({ code: 'GLUE.SCHEMA.INPUT' });
  });

  it('多卡片 invoke 同源站卡片:每次 handle 独立 IR,互不污染', async () => {
    const sc = makeSourceCard();
    const mkCard = (name: string) =>
      defineCard({
        meta: { name, version: '1.0.0' },
        in: z.object({ sku: z.string() }),
        out: z.object({ name: z.string() }),
        uses: [sc.meta.name],
        collect: async (ctx) => {
          ctx.ir.skuId = (ctx.input as { sku: string }).sku;
          await ctx.invoke(sc.meta.name);
        },
        respond: (ctx) => ({ name: (ctx.ir[sc.meta.name] as { title: string }).title }),
      });
    const controller = new RelayController();
    const src = mockSource('jd/items/detail', { body: GOOD_BODY });
    controller.registerSource(src.ref, src.binding);
    controller.registerSourceCard(sc);
    controller.registerCard(mkCard('card.a'));
    controller.registerCard(mkCard('card.b'));
    const relay = controller.buildRelay();
    const [outA, outB] = await Promise.all([
      relay.handle('card.a', { sku: 'A1' }),
      relay.handle('card.b', { sku: 'A2' }),
    ]);
    expect(outA).toEqual({ name: 'X' });
    expect(outB).toEqual({ name: 'X' });
  });

  it('inspectSourceCard:output 字段清单与绑定状态', () => {
    const controller = new RelayController();
    const src = mockSource('jd/items/detail', { body: GOOD_BODY });
    controller.registerSource(src.ref, src.binding);
    controller.registerSourceCard(makeSourceCard());
    const view = controller.inspectSourceCard('jd.item-detail');
    expect(view.outputFields).toEqual(['title', 'priceCents', 'inStock']);
    expect(view.bound).toBe(true);
    expect(view.ref).toBe('jd/items/detail');
  });
});
