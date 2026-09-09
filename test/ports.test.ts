import { describe, expect, it } from 'vitest';
import { GlueError, RelayController } from '../src/index';
import type { SourceBinding, SourceRegistryPort, TransportFn } from '../src/index';
import { GOOD_BODY, makeCard, makeSourceCard, mockSource, registerCardDeps } from './helpers';

/** T1/T2 共用:注册链就绪(物理绑定用 mock 占位,实际传输由注入的 transport 承担) */
function setupWith(transport: TransportFn): RelayController {
  const sc = makeSourceCard();
  const card = makeCard({ sourceCard: sc });
  const mock = mockSource(sc.def.ref, { body: GOOD_BODY });
  const controller = new RelayController({ transport });
  registerCardDeps(controller, card, [sc], [mock]);
  controller.setRuntimeConfig(card.meta.name, { tenantId: 'T-01' });
  return controller;
}

describe('组合根注入:transport', () => {
  it('自定义 transport 被 invoke 使用,收到 take 产物与超时策略', async () => {
    const calls: Array<{ url: string; timeoutMs?: number }> = [];
    const controller = setupWith(async (binding, req, opts) => {
      calls.push({ url: `${binding.baseURL}${req.path}`, timeoutMs: opts.timeoutMs });
      return { status: 200, body: GOOD_BODY, headers: { 'content-type': 'application/json' } };
    });
    const relay = controller.buildRelay();

    const out = await relay.handle('product.detail', { sku: 'A1' });

    expect(out).toEqual({ name: 'X', cents: 990, available: true });
    expect(calls).toHaveLength(1);
    // req 为 take 产物(:param 替换是 defaultTransport 的职责,注入实现自行处理)
    expect(calls[0]!.url).toContain('mock.local/jd/items/detail');
    expect(calls[0]!.url).toContain('/v2/items/:skuId');
    // 超时策略透传:卡片/源站均未声明 → 兜底 defaultTimeoutMs
    expect(calls[0]!.timeoutMs).toBe(10_000);
  });

  it('retry 循环仍作用于注入的 transport(前两次 NETWORK 可重试,第三次成功)', async () => {
    let attempts = 0;
    const controller = setupWith(async () => {
      attempts++;
      if (attempts <= 2) throw GlueError.transport('NETWORK', undefined);
      return { status: 200, body: GOOD_BODY, headers: {} };
    });
    controller.setPolicy('product.detail', { retry: { max: 2, backoff: 'expo' } });
    const relay = controller.buildRelay();

    const out = await relay.handle('product.detail', { sku: 'A1' });

    expect(attempts).toBe(3);
    expect(out).toEqual({ name: 'X', cents: 990, available: true });
  });
});

describe('组合根注入:registry', () => {
  it('自定义 SourceRegistryPort 全链路可用(register/resolve/has/list)', async () => {
    const sc = makeSourceCard();
    const card = makeCard({ sourceCard: sc });
    const mock = mockSource(sc.def.ref, { body: GOOD_BODY });
    const store = new Map<string, SourceBinding>();
    const registry: SourceRegistryPort = {
      register: (ref, binding) => void store.set(ref, binding),
      resolve: (ref) => store.get(ref),
      has: (ref) => store.has(ref),
      list: () => store,
    };

    const controller = new RelayController({ registry });
    controller.registerSource(sc.def.ref, mock.binding);
    controller.registerSourceCard(sc);
    controller.registerCard(card);
    controller.setRuntimeConfig(card.meta.name, { tenantId: 'T-01' });

    // 管理视图走自定义 list
    expect(controller.listBindings()).toEqual([
      { ref: sc.def.ref, baseURL: mock.binding.baseURL, hasAuth: false },
    ]);

    const relay = controller.buildRelay();
    const out = await relay.handle('product.detail', { sku: 'A1' });
    expect(out).toEqual({ name: 'X', cents: 990, available: true });
    expect([...store.keys()]).toEqual([sc.def.ref]); // 确认自实现被真正使用
  });
});
