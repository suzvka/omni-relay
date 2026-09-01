import { describe, expect, it } from 'vitest';
import { GlueError } from '../src/index';
import { buildInit, buildUrl, defaultTransport, MockSource } from '../src/index';
import type { SourceBinding, UpstreamRequest } from '../src/index';

const binding: SourceBinding = { baseURL: 'https://jd.test/api/' };

const req: UpstreamRequest = {
  method: 'GET',
  path: '/v2/items/:skuId',
  params: { skuId: 'A 1' },
  query: { fmt: 'json', skip: undefined, n: 3 },
};

describe('buildUrl / buildInit', () => {
  it('组装 URL:param 替换 + query 过滤 undefined + 去尾斜杠', () => {
    expect(buildUrl(binding, req)).toBe('https://jd.test/api/v2/items/A%201?fmt=json&n=3');
  });

  it('无 path 时直接命中 baseURL', () => {
    expect(buildUrl({ baseURL: 'https://x.test' }, { method: 'GET', path: '' })).toBe('https://x.test');
  });

  it('auth:字符串补 Bearer 前缀;对象直接合并 headers', async () => {
    const b1: SourceBinding = { baseURL: 'https://x', auth: () => 'tok-1' };
    const i1 = await buildInit(b1, { method: 'GET', path: '/' });
    expect(i1.headers!.authorization).toBe('Bearer tok-1');

    const b2: SourceBinding = { baseURL: 'https://x', auth: () => ({ headers: { 'x-app-key': 'k' } }) };
    const i2 = await buildInit(b2, { method: 'GET', path: '/' });
    expect(i2.headers!['x-app-key']).toBe('k');

    const b3: SourceBinding = { baseURL: 'https://x', auth: () => 'Bearer raw' };
    const i3 = await buildInit(b3, { method: 'GET', path: '/' });
    expect(i3.headers!.authorization).toBe('Bearer raw'); // 不重复加前缀
  });

  it('body 序列化并默认 content-type', async () => {
    const init = await buildInit(binding, { method: 'POST', path: '/', body: { a: 1 } });
    expect(init.body).toBe('{"a":1}');
    expect(init.headers!['content-type']).toBe('application/json');
  });
});

describe('defaultTransport', () => {
  it('成功解析 JSON 响应', async () => {
    const mock = new MockSource({ body: { ok: true } });
    const r = await defaultTransport({ ...binding, fetch: mock.fetch }, req, {});
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
    expect(mock.calls[0].url).toContain('/v2/items/A%201');
  });

  it('非 2xx 原样返回 status/body(业务映射在管道层)', async () => {
    const mock = new MockSource({ status: 404, body: { error: { code: 'X' } } });
    const r = await defaultTransport({ ...binding, fetch: mock.fetch }, req, {});
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: { code: 'X' } });
  });

  it('fetch 抛错 → GLUE.TRANSPORT.NETWORK', async () => {
    const bad: SourceBinding = {
      baseURL: 'https://x',
      fetch: () => Promise.reject(new TypeError('boom')),
    };
    await expect(defaultTransport(bad, req, {})).rejects.toMatchObject({
      code: 'GLUE.TRANSPORT.NETWORK',
      retryable: true,
    });
  });

  it('超时 → GLUE.TRANSPORT.TIMEOUT(可重试)', async () => {
    const mock = new MockSource(async () => {
      await new Promise((r) => setTimeout(r, 200));
      return { body: {} };
    });
    const p = defaultTransport({ ...binding, fetch: mock.fetch }, req, { timeoutMs: 30 });
    await expect(p).rejects.toMatchObject({ code: 'GLUE.TRANSPORT.TIMEOUT', retryable: true });
  });

  it('外部取消 → GLUE.TRANSPORT.CANCELLED(不可重试)', async () => {
    const mock = new MockSource(async () => {
      await new Promise((r) => setTimeout(r, 200));
      return { body: {} };
    });
    const ac = new AbortController();
    const p = defaultTransport({ ...binding, fetch: mock.fetch }, req, { signal: ac.signal });
    setTimeout(() => ac.abort(), 20);
    await expect(p).rejects.toMatchObject({ code: 'GLUE.TRANSPORT.CANCELLED', retryable: false });
  });

  it('发起前已取消 → 直接 CANCELLED', async () => {
    const ac = new AbortController();
    ac.abort();
    const mock = new MockSource({ body: {} });
    await expect(
      defaultTransport({ ...binding, fetch: mock.fetch }, req, { signal: ac.signal }),
    ).rejects.toMatchObject({ code: 'GLUE.TRANSPORT.CANCELLED' });
    expect(mock.calls.length).toBe(0);
  });

  it('GlueError 抛出时 instanceof 保持', async () => {
    const bad: SourceBinding = { baseURL: 'https://x', fetch: () => Promise.reject(new Error('x')) };
    const e = await defaultTransport(bad, req, {}).catch((err: unknown) => err);
    expect(e).toBeInstanceOf(GlueError);
  });
});
