import { describe, expect, it } from 'vitest';
import {
  GlueError,
  RegistrationError,
  RelayController,
} from '../src/index';
import { mockSource } from '../src/testing';
import { GOOD_BODY, makeCard, makeSourceCard } from './helpers';

/** 物理绑定就绪的控制面(源站卡片注册前置) */
function boundController(): RelayController {
  const src = mockSource('jd/items/detail', { body: GOOD_BODY });
  return new RelayController().registerSource(src.ref, src.binding);
}

describe('RelayController 源站卡片注册', () => {
  it('注册成功并进入清单/视图/审计', () => {
    const c = boundController().registerSourceCard(makeSourceCard());
    expect(c.listSourceCards()).toEqual([
      { name: 'jd.item-detail', version: '1.0.0', ref: 'jd/items/detail' },
    ]);
    const view = c.inspectSourceCard('jd.item-detail');
    expect(view.outputFields).toEqual(['title', 'priceCents', 'inStock']);
    expect(view.bound).toBe(true);
    expect(c.getAuditLog().map((a) => a.action)).toEqual([
      'registerSource',
      'registerSourceCard',
    ]);
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

  it('manifest.requires.sources 与代码不符 → 拒绝', () => {
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

  it('manifest.requires.injections 与代码 inject 字段不符 → 拒绝', () => {
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

  it('引用的源站卡片未注册 → 拒绝(step sourceCard:registered)', () => {
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
    // 模拟新版本:直接改 meta(仅测试版本化路径)
    const def = { ...v2.def, meta: { name: 'product.detail', version: '1.1.0' } };
    c.registerCard({ ...v2, def, meta: { name: 'product.detail', version: '1.1.0' } });
    expect(c.listCards().map((s) => s.version)).toContain('1.1.0');
  });

  it('buildRelay 上线门:inject 字段无法满足 → 拒绝;setRuntimeConfig 后放行', () => {
    const c = boundController().registerSourceCard(makeSourceCard());
    c.registerCard(makeCard());
    expect(() => c.buildRelay()).toThrowError(/tenantId/);
    c.setRuntimeConfig('product.detail', { tenantId: 'T-01' });
    expect(c.buildRelay()).toBeInstanceOf(Object);
  });
});

describe('RelayController 视图与审计', () => {
  it('inspectCard 给出字段级视图与源站卡片引用状态', () => {
    const c = boundController()
      .registerSourceCard(makeSourceCard())
      .registerCard(makeCard())
      .setRuntimeConfig('product.detail', { tenantId: 'T-01' });
    const view = c.inspectCard('product.detail');
    expect(view.fields).toEqual([
      { name: 'skuId', kind: 'core', redact: false },
      { name: 'quantity', kind: 'core', redact: false },
      { name: 'tenantId', kind: 'extension', redact: false },
      { name: 'internalTag', kind: 'core', redact: true },
    ]);
    expect(view.sources).toEqual([
      { id: 'jd', sourceCard: 'jd.item-detail', version: '1.0.0', ref: 'jd/items/detail', bound: true },
    ]);
    expect(view.policy.strategy).toBe('firstSuccess');
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
      strategy: 'firstSuccess',
    });
  });

  it('控制面操作全部进入审计日志', () => {
    const c = boundController();
    c.registerSourceCard(makeSourceCard());
    c.registerCard(makeCard());
    c.setRuntimeConfig('product.detail', { tenantId: 'T' });
    c.setPolicy('product.detail', { timeoutMs: 1 });
    const actions = c.getAuditLog().map((a) => a.action);
    expect(actions).toEqual([
      'registerSource',
      'registerSourceCard',
      'registerCard',
      'setRuntimeConfig',
      'setPolicy',
    ]);
    // 审计不记录认证材料
    expect(JSON.stringify(c.getAuditLog())).not.toContain('auth');
  });

  it('inspectCard 未注册卡片 → GlueError', async () => {
    expect(() => new RelayController().inspectCard('nope')).toThrowError(GlueError);
  });

  it('registerSource 拒绝非法 baseURL', () => {
    expect(() => new RelayController().registerSource('x', { baseURL: 'ftp://x' })).toThrowError(
      /baseURL/,
    );
  });
});

describe('RelayController 退役与回滚（只留 current；版本史归制品层）', () => {
  /** 同一业务卡片的指定版本变体(仅 meta 差异) */
  function cardAtVersion(version: string): ReturnType<typeof makeCard> {
    const base = makeCard();
    const meta = { name: 'product.detail', version };
    return { ...base, def: { ...base.def, meta }, meta };
  }

  /** 同源站卡片的指定版本变体(仅 meta 差异) */
  function sourceAtVersion(version: string): ReturnType<typeof makeSourceCard> {
    const base = makeSourceCard();
    const meta = { name: base.meta.name, version };
    return { ...base, def: { ...base.def, meta }, meta };
  }

  /** 源站卡片 + 物理绑定就绪,且业务卡片注入满足(可直接 buildRelay) */
  function readyController(): RelayController {
    const c = boundController().registerSourceCard(makeSourceCard());
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

  it('退役:移除 current → handle 即 CARD.NOT_FOUND;退役后重注册同版本不受限', async () => {
    const c = readyController();
    c.registerCard(cardAtVersion('1.0.0'));
    const relay = c.buildRelay();
    await expect(relay.handle('product.detail', { sku: 'A1' })).resolves.toBeTruthy();

    c.deregisterCard('product.detail');
    await expect(relay.handle('product.detail', { sku: 'A1' })).rejects.toThrowError(GlueError);
    expect(c.listCards()).toEqual([]);

    // 退役 ≠ 版本黑名单:同版本制品重新上架放行
    expect(() => c.registerCard(cardAtVersion('1.0.0'))).not.toThrow();
    expect(c.listCards().map((s) => s.version)).toEqual(['1.0.0']);
  });

  it('退役未注册卡片 → RegistrationError(card:unknown)', () => {
    try {
      readyController().deregisterCard('nope');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(RegistrationError);
      expect((e as RegistrationError).step).toBe('card:unknown');
    }
  });

  it('源站卡片 ③ 校验精确匹配 current 版本:旧版回滚重发后引用方方可注册', () => {
    const c = boundController();
    c.registerSourceCard(sourceAtVersion('1.1.0'));
    // 业务卡片内嵌 1.0.0(标准夹具),与 current 1.1.0 不符 → ③ 拒绝
    expect(() => c.registerCard(makeCard())).toThrowError(/源站卡片未注册/);
    // 旧版回滚重发 → current 切为 1.0.0 → 引用方通过
    c.registerSourceCard(sourceAtVersion('1.0.0'), undefined, { rollback: true });
    expect(() => c.registerCard(makeCard())).not.toThrow();
  });

  it('源站卡片退役后:新业务卡片注册被拒(③);已注册业务卡片照常运行(内嵌对象)', async () => {
    const c = readyController();
    c.registerCard(cardAtVersion('1.0.0'));
    const relay = c.buildRelay();

    c.deregisterSourceCard('jd.item-detail');
    expect(() => c.registerCard(cardAtVersion('1.1.0'))).toThrowError(/源站卡片未注册/);
    // 运行时取业务卡片内嵌的源站卡片对象,控制面退役不代跑部署
    await expect(relay.handle('product.detail', { sku: 'A1' })).resolves.toBeTruthy();
  });

  it('deregister 进入审计(target 含 name@version)', () => {
    const c = readyController();
    c.registerCard(cardAtVersion('1.0.0'));
    c.deregisterCard('product.detail');
    c.deregisterSourceCard('jd.item-detail');
    const log = c.getAuditLog();
    expect(log.map((a) => a.action)).toContain('deregisterCard');
    expect(log.map((a) => a.action)).toContain('deregisterSourceCard');
    expect(log.find((a) => a.action === 'deregisterCard')?.target).toBe('product.detail@1.0.0');
    expect(log.find((a) => a.action === 'deregisterSourceCard')?.target).toBe('jd.item-detail@1.0.0');
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
