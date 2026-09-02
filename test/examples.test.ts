import { describe, expect, it } from 'vitest';
import { readManifest, RelayController } from '../src/index';
import type { CollectCtx, ControllerHooks } from '../src/index';
import skuDetail, { jdItemDetail } from '../examples/sku-detail/index';
import { mockSource } from '../src/testing';
import { GOOD_BODY } from './helpers';

/** 注册示例源站卡片(物理绑定 + 中心化注册表) */
function seededController(opts: { hooks?: ControllerHooks } = {}) {
  const controller = new RelayController({ hooks: opts.hooks });
  const src = mockSource(jdItemDetail.def.ref, { body: GOOD_BODY });
  controller.registerSource(src.ref, src.binding);
  controller.registerSourceCard(jdItemDetail);
  return controller;
}

describe('示例卡片(sku-detail)', () => {
  it('manifest 文件与代码一致并可加载注册', async () => {
    const { manifest } = await readManifest('examples/sku-detail/card.json');
    const controller = seededController();
    controller.registerCard(skuDetail, manifest);
    controller.setRuntimeConfig('product.detail', { tenantId: 'T-01' });
    const relay = controller.buildRelay();
    const out = await relay.handle('product.detail', { sku: 'A1' });
    expect(out).toEqual({ name: 'X', cents: 990, available: true });
  });

  it('golden:IR 贯穿一次执行(seeds 并入 → collect 填充 → invoke 写回命名空间)', async () => {
    const controller = seededController({
      hooks: {
        onBusRes: (ctx: CollectCtx) => {
          // 宿主治理动作:直接读 IR(collect 已填充 + invoke 已写回)
          expect(ctx.ir.skuId).toBe('A1');
          expect(ctx.ir.quantity).toBe(1);
          expect(ctx.ir.tenantId).toBe('T-01');
          expect(ctx.ir.internalTag).toBe('tag:A1');
          expect(ctx.ir['jd.item-detail']).toEqual({ title: 'X', priceCents: 990, inStock: true });
        },
      },
    });
    controller.registerCard(skuDetail);
    controller.setRuntimeConfig('product.detail', { tenantId: 'T-01' });
    const relay = controller.buildRelay();
    expect(await relay.handle('product.detail', { sku: 'A1' })).toEqual({
      name: 'X',
      cents: 990,
      available: true,
    });
  });

  it('业务错误映射 + fetch handler 错误形状(不透 raw)', async () => {
    const controller = new RelayController();
    const src = mockSource('jd/items/detail', {
      status: 404,
      body: { error: { code: 'ITEM_NOT_FOUND' } },
    });
    controller.registerSource(src.ref, src.binding);
    controller.registerSourceCard(jdItemDetail);
    controller.registerCard(skuDetail);
    controller.setRuntimeConfig('product.detail', { tenantId: 'T-01' });
    const handler = controller.buildRelay().toFetchHandler();

    const res = await handler(
      new Request('http://local/product.detail', {
        method: 'POST',
        body: JSON.stringify({ sku: 'NOPE' }),
        headers: { 'content-type': 'application/json' },
      }),
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('GLUE.BUSINESS.PRODUCT_NOT_FOUND');
    expect(JSON.stringify(body)).not.toContain('ITEM_NOT_FOUND');
  });

  it('fetch handler:GET 查询串入参与成功响应', async () => {
    const controller = seededController();
    controller.registerCard(skuDetail);
    controller.setRuntimeConfig('product.detail', { tenantId: 'T-01' });
    const handler = controller.buildRelay().toFetchHandler();

    const res = await handler(new Request('http://local/product.detail?sku=A1'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: 'X', cents: 990, available: true });
  });

  it('fetch handler:未知路由 → 404', async () => {
    const controller = new RelayController();
    const handler = controller.buildRelay().toFetchHandler();
    const res = await handler(
      new Request('http://local/unknown.card', { method: 'POST', body: '{}' }),
    );
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'GLUE.CARD.NOT_FOUND',
    );
  });

  it('版本化 + 原子切换:注册 1.1.0 后新请求用新版本,in-flight 持旧版本', async () => {
    const controller = seededController();
    controller.registerCard(skuDetail);
    controller.setRuntimeConfig('product.detail', { tenantId: 'T-01' });
    const relay = controller.buildRelay();

    const inflight = relay.handle('product.detail', { sku: 'A1' });

    const def = { ...skuDetail.def, meta: { name: 'product.detail', version: '1.1.0' } };
    controller.registerCard({
      ...skuDetail,
      def,
      meta: { name: 'product.detail', version: '1.1.0' },
    });

    expect(await inflight).toEqual({ name: 'X', cents: 990, available: true });
    expect(controller.listCards()).toEqual([
      { name: 'product.detail', version: '1.1.0', sources: ['jd.item-detail'] },
    ]);
  });
});
