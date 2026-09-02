import { describe, expect, it } from 'vitest';
import { GlueError, RegistrationError, RelayController } from '../src/index';
import type { ControlEvent, RelayCard } from '../src/index';
import { mockSource } from '../src/testing';
import { GOOD_BODY, makeCard, makeSourceCard } from './helpers';

/** 物理绑定就绪的控制面(源站卡片注册前置) */
function boundController(onControlEvent?: (e: ControlEvent) => void): RelayController {
  const src = mockSource('jd/items/detail', { body: GOOD_BODY });
  return new RelayController({ onControlEvent }).registerSource(src.ref, src.binding);
}

describe('RelayController 源站卡片注册', () => {
  it('注册成功并进入清单/视图/事件回调', () => {
    const events: ControlEvent[] = [];
    const c = boundController((e) => events.push(e)).registerSourceCard(makeSourceCard());
    expect(c.listSourceCards()).toEqual([
      { name: 'jd.item-detail', version: '1.0.0', ref: 'jd/items/detail' },
    ]);
    const view = c.inspectSourceCard('jd.item-detail');
    expect(view.outputFields).toEqual(['title', 'priceCents', 'inStock']);
    expect(view.bound).toBe(true);
    expect(events.map((e) => e.action)).toEqual(['registerSource', 'registerSourceCard']);
  });

  it('物理绑定未就绪 → 拒绝', () => {
    expect(() => new RelayController().registerSourceCard(makeSourceCard())).toThrowError(
      /源站未注册/,
    );
  });

  it('manifest 与代码不一致 → 拒绝', () => {
    expect(() =>
      boundController().registerSourceCard(makeSourceCard(), {
        name: 'other.name',
        version: '1.0.0',
        entry: 'x.js',
        requires: { sources: ['jd/items/detail'], injections: [] },
      }),
    ).toThrowError(/不一致/);
  });

  it('manifest.requires.sources 与 ref 不符 → 拒绝', () => {
    expect(() =>
      boundController().registerSourceCard(makeSourceCard(), {
        name: 'jd.item-detail',
        version: '1.0.0',
        entry: 'x.js',
        requires: { sources: ['other/ref'], injections: [] },
      }),
    ).toThrowError(/sources/);
  });

  it('源站卡片不支持注入声明 → 拒绝', () => {
    expect(() =>
      boundController().registerSourceCard(makeSourceCard(), {
        name: 'jd.item-detail',
        version: '1.0.0',
        entry: 'x.js',
        requires: { sources: ['jd/items/detail'], injections: ['tenantId'] },
      }),
    ).toThrowError(/注入/);
  });

  it('同名同版本重复注册 → 拒绝', () => {
    const c = boundController().registerSourceCard(makeSourceCard());
    expect(() => c.registerSourceCard(makeSourceCard())).toThrowError(/已注册/);
  });

  it('inspectSourceCard 未注册 → GlueError', () => {
    expect(() => new RelayController().inspectSourceCard('nope')).toThrowError(GlueError);
  });
});

describe('RelayController 校验链', () => {
  it('manifest 与代码 name/version 不一致 → 拒绝', () => {
    const c = boundController().registerSourceCard(makeSourceCard());
    expect(() =>
      c.registerCard(makeCard(), {
        name: 'other.name',
        version: '1.0.0',
        entry: 'x.js',
        requires: { sources: ['jd.item-detail'], injections: ['tenantId'] },
      }),
    ).toThrowError(/不一致/);
  });

  it('manifest.requires.sources 与代码 uses 不符 → 拒绝', () => {
    const c = boundController().registerSourceCard(makeSourceCard());
    expect(() =>
      c.registerCard(makeCard(), {
        name: 'product.detail',
        version: '1.0.0',
        entry: 'x.js',
        requires: { sources: ['other.source'], injections: ['tenantId'] },
      }),
    ).toThrowError(/sources/);
  });

  it('manifest.requires.injections 与代码 seeds 不符 → 拒绝', () => {
    const c = boundController().registerSourceCard(makeSourceCard());
    expect(() =>
      c.registerCard(makeCard(), {
        name: 'product.detail',
        version: '1.0.0',
        entry: 'x.js',
        requires: { sources: ['jd.item-detail'], injections: ['otherField'] },
      }),
    ).toThrowError(/injections/);
  });

  it('uses 声明的源站卡片未注册 → 拒绝(step sourceCard:registered)', () => {
    const c = boundController();
    expect(() => c.registerCard(makeCard())).toThrowError(RegistrationError);
    try {
      boundController().registerCard(makeCard());
    } catch (e) {
      expect((e as RegistrationError).step).toBe('sourceCard:registered');
    }
  });

  it('同名同版本重复注册 → 拒绝;新版本 → 成功且 current 切换', () => {
    const c = boundController().registerSourceCard(makeSourceCard());
    c.registerCard(makeCard());
    expect(() => c.registerCard(makeCard())).toThrowError(/已注册/);
    const v2 = makeCard();
    const def = { ...v2.def, meta: { name: 'product.detail', version: '1.1.0' } };
    c.registerCard({ ...v2, def, meta: { name: 'product.detail', version: '1.1.0' } });
    expect(c.listCards().map((s) => s.version)).toContain('1.1.0');
  });

  it('buildRelay 上线门:seeds 无法满足 → 拒绝;setRuntimeConfig 后放行', () => {
    const c = boundController().registerSourceCard(makeSourceCard());
    c.registerCard(makeCard());
    expect(() => c.buildRelay()).toThrowError(/tenantId/);
    c.setRuntimeConfig('product.detail', { tenantId: 'T-01' });
    expect(c.buildRelay()).toBeInstanceOf(Object);
  });

  it('buildRelay 类型门:seeds 值类型不符 → 拒绝(替代每请求的 glue 校验)', () => {
    const c = boundController().registerSourceCard(makeSourceCard());
    c.registerCard(makeCard());
    c.setRuntimeConfig('product.detail', { tenantId: 123 }); // 应为 string
    expect(() => c.buildRelay()).toThrowError(/类型不符/);
  });
});

describe('RelayController 视图与治理事件', () => {
  it('inspectCard 给出 seeds 字段视图与 uses 依赖状态', () => {
    const c = boundController()
      .registerSourceCard(makeSourceCard())
      .registerCard(makeCard())
      .setRuntimeConfig('product.detail', { tenantId: 'T-01' });
    const view = c.inspectCard('product.detail');
    // IR 键请求期动态填充,静态不可穷举;fields 仅呈现 seeds(extension)
    expect(view.fields).toEqual([{ name: 'tenantId', kind: 'extension' }]);
    expect(view.sources).toEqual([
      { name: 'jd.item-detail', version: '1.0.0', ref: 'jd/items/detail', bound: true },
    ]);
    expect(view.policy.retry).toEqual({ max: 0, backoff: 'expo' });
    expect(view.policy.timeoutMs).toBeUndefined();
  });

  it('setPolicy 覆盖 manifest.suggests', () => {
    const c = boundController()
      .registerSourceCard(makeSourceCard())
      .registerCard(makeCard(), {
        name: 'product.detail',
        version: '1.0.0',
        entry: 'x.js',
        requires: { sources: ['jd.item-detail'], injections: ['tenantId'] },
        suggests: { timeoutMs: 3000, retry: { max: 2, backoff: 'expo' } },
      })
      .setRuntimeConfig('product.detail', { tenantId: 'T' })
      .setPolicy('product.detail', { timeoutMs: 100, retry: { max: 0, backoff: 'fixed' } });
    expect(c.inspectCard('product.detail').policy).toEqual({
      timeoutMs: 100,
      retry: { max: 0, backoff: 'fixed' },
    });
  });

  it('控制面动作全部通知宿主回调', () => {
    const events: ControlEvent[] = [];
    const c = boundController((e) => events.push(e));
    c.registerSourceCard(makeSourceCard());
    c.registerCard(makeCard());
    c.setRuntimeConfig('product.detail', { tenantId: 'T' });
    c.setPolicy('product.detail', { timeoutMs: 1 });
    expect(events.map((e) => e.action)).toEqual([
      'registerSource',
      'registerSourceCard',
      'registerCard',
      'setRuntimeConfig',
      'setPolicy',
    ]);
    expect(JSON.stringify(events)).not.toContain('auth');
  });

  it('inspectCard 未注册卡片 → GlueError', () => {
    expect(() => new RelayController().inspectCard('nope')).toThrowError(GlueError);
  });

  it('registerSource 拒绝非法 baseURL', () => {
    expect(() => new RelayController().registerSource('x', { baseURL: 'ftp://x' })).toThrowError(
      /baseURL/,
    );
  });
});

describe('RelayController 卸载与回滚（只留 current；版本史归制品层）', () => {
  /** 同一业务卡片的指定版本变体(仅 meta 差异) */
  function cardAtVersion(version: string): RelayCard {
    const base = makeCard();
    const meta = { name: 'product.detail', version };
    return { ...base, def: { ...base.def, meta }, meta };
  }

  /** 源站卡片 + 物理绑定就绪,且业务卡片 seeds 满足(可直接 buildRelay) */
  function readyController(onControlEvent?: (e: ControlEvent) => void): RelayController {
    const c = boundController(onControlEvent).registerSourceCard(makeSourceCard());
    c.setRuntimeConfig('product.detail', { tenantId: 'T-01' });
    return c;
  }

  it('注册新版本 → 原子替换 current', () => {
    const c = readyController();
    c.registerCard(cardAtVersion('1.0.0')).registerCard(cardAtVersion('1.1.0'));
    expect(c.listCards().map((s) => s.version)).toEqual(['1.1.0']);
  });

  it('误发旧版 → 拒绝(version:downgrade);声明 rollback 重发旧版 → 替换', () => {
    const c = readyController();
    c.registerCard(cardAtVersion('1.0.0')).registerCard(cardAtVersion('1.1.0'));
    try {
      c.registerCard(cardAtVersion('1.0.0'));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(RegistrationError);
      expect((e as RegistrationError).step).toBe('version:downgrade');
    }
    c.registerCard(cardAtVersion('1.0.0'), undefined, { rollback: true });
    expect(c.listCards().map((s) => s.version)).toEqual(['1.0.0']);
  });

  it('回滚重发原子切换:服务面无下线窗口(期间 handle 恒可解析)', async () => {
    const c = readyController();
    c.registerCard(cardAtVersion('1.0.0')).registerCard(cardAtVersion('1.1.0'));
    const relay = c.buildRelay();
    await expect(relay.handle('product.detail', { sku: 'A1' })).resolves.toBeTruthy();
    c.registerCard(cardAtVersion('1.0.0'), undefined, { rollback: true });
    await expect(relay.handle('product.detail', { sku: 'A1' })).resolves.toBeTruthy();
  });

  it('卸载:移除 current → handle 即 CARD.NOT_FOUND;卸载后重注册同版本不受限', async () => {
    const c = readyController();
    c.registerCard(cardAtVersion('1.0.0'));
    const relay = c.buildRelay();
    await expect(relay.handle('product.detail', { sku: 'A1' })).resolves.toBeTruthy();

    c.deregisterCard('product.detail');
    await expect(relay.handle('product.detail', { sku: 'A1' })).rejects.toThrowError(GlueError);
    expect(c.listCards()).toEqual([]);

    expect(() => c.registerCard(cardAtVersion('1.0.0'))).not.toThrow();
    expect(c.listCards().map((s) => s.version)).toEqual(['1.0.0']);
  });

  it('卸载未注册卡片 → RegistrationError(card:unknown)', () => {
    try {
      readyController().deregisterCard('nope');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(RegistrationError);
      expect((e as RegistrationError).step).toBe('card:unknown');
    }
  });

  it('源站卡片卸载后:新业务卡片注册被拒(uses 门);已注册卡片 invoke 即 SOURCE_NOT_REGISTERED', async () => {
    const c = readyController();
    c.registerCard(cardAtVersion('1.0.0'));
    const relay = c.buildRelay();
    await expect(relay.handle('product.detail', { sku: 'A1' })).resolves.toBeTruthy();

    c.deregisterSourceCard('jd.item-detail');
    // v2:invoke 运行时按名动态解析,不再内嵌副本
    expect(() => c.registerCard(cardAtVersion('1.1.0'))).toThrowError(/源站卡片未注册/);
    await expect(relay.handle('product.detail', { sku: 'A1' })).rejects.toMatchObject({
      code: 'GLUE.CARD.SOURCE_NOT_REGISTERED',
    });
  });

  it('deregister 通知宿主(target 含 name@version)', () => {
    const events: ControlEvent[] = [];
    const c = readyController((e) => events.push(e));
    c.registerCard(cardAtVersion('1.0.0'));
    c.deregisterCard('product.detail');
    c.deregisterSourceCard('jd.item-detail');
    const actions = events.map((e) => e.action);
    expect(actions).toContain('deregisterCard');
    expect(actions).toContain('deregisterSourceCard');
    expect(events.find((e) => e.action === 'deregisterCard')?.target).toBe('product.detail@1.0.0');
    expect(events.find((e) => e.action === 'deregisterSourceCard')?.target).toBe(
      'jd.item-detail@1.0.0',
    );
  });

  it('listBindings 给出绑定摘要且不含认证材料', () => {
    const c = new RelayController().registerSource('x/ref', {
      baseURL: 'https://x.example.com',
      timeoutMs: 1234,
      auth: () => 'secret',
    });
    expect(c.listBindings()).toEqual([
      { ref: 'x/ref', baseURL: 'https://x.example.com', timeoutMs: 1234, hasAuth: true },
    ]);
    expect(JSON.stringify(c.listBindings())).not.toContain('secret');
  });
});
