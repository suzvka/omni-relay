import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  defaultTransport,
  defineCard,
  defineSource,
  isReadableStream,
  RegistrationError,
  RelayController,
} from '../src/index';
import { mockSource } from '../src/testing';
import type { ErrorMapDef, RelayCard, SourceBinding, UpstreamRequest } from '../src/index';
import type { MockedSource } from '../src/testing';
import { registerCardDeps } from './helpers';

const binding: SourceBinding = { baseURL: 'https://x.test' };
const req: UpstreamRequest = { method: 'POST', path: '/v1/chat/completions' };

/** 流式源站卡片(stream 声明 + 省略 put) */
function sseSourceCard(ref: string, name: string, errorMap?: ErrorMapDef) {
  return defineSource({
    meta: { name, version: '1.0.0' },
    ref,
    stream: true,
    input: z.object({ prompt: z.string() }),
    upstreamRes: z.custom<ReadableStream<Uint8Array>>(),
    output: z.custom<ReadableStream<Uint8Array>>(),
    take: ({ prompt }) => ({
      method: 'POST' as const,
      path: '/v1/chat/completions',
      body: { prompt, stream: true },
    }),
    errorMap,
  });
}

/** 流式卡片(id 默认 up;可声明多源站用于切换测试) */
function sseCard(
  sources: Array<{ ref: string; id: string; name?: string; errorMap?: ErrorMapDef }> = [
    { ref: 'llm/openai', id: 'up' },
  ],
): RelayCard {
  return defineCard({
    meta: { name: 'llm.chat', version: '1.0.0' },
    in: z.object({ prompt: z.string() }),
    out: z.custom<ReadableStream<Uint8Array>>(),
    glue: z.object({ prompt: z.string() }),
    toGlue: ({ prompt }) => ({ prompt }),
    sources: sources.map(({ ref, id, name, errorMap }) => ({
      source: sseSourceCard(ref, name ?? `sse.${id}`, errorMap),
      id,
      bind: (g) => ({ prompt: g.prompt }),
    })),
    fromGlue: (_g, res) => {
      const bundle = res as Record<string, ReadableStream<Uint8Array>>;
      return bundle[sources[0].id] ?? Object.values(bundle)[0];
    },
  });
}

function setup(card: RelayCard, sources: MockedSource[], policy?: { strategy?: 'firstSuccess' | 'race' | 'all' }) {
  const controller = new RelayController();
  registerCardDeps(controller, card, sources);
  if (policy) controller.setPolicy(card.meta.name, policy);
  return { controller, relay: controller.buildRelay(), sources };
}

describe('defaultTransport 流式识别', () => {
  it('event-stream → stream: true + ReadableStream 直通(不读体)', async () => {
    const mock = mockSource('llm/x', { sse: 'data: hi\n\ndata: [DONE]\n\n' });
    const r = await defaultTransport({ ...binding, fetch: mock.binding.fetch }, req, {});
    expect(r.stream).toBe(true);
    expect(isReadableStream(r.body)).toBe(true);
    expect(await new Response(r.body as ReadableStream<Uint8Array>).text()).toBe('data: hi\n\ndata: [DONE]\n\n');
  });

  it('JSON 响应不受影响(stream 标记缺省)', async () => {
    const mock = mockSource('llm/x', { body: { ok: true } });
    const r = await defaultTransport({ ...binding, fetch: mock.binding.fetch }, req, {});
    expect(r.stream).toBeUndefined();
    expect(r.body).toEqual({ ok: true });
  });

  it('超时只覆盖到流建立:消费期超过 timeoutMs 仍完整读取', async () => {
    const enc = new TextEncoder();
    const slow = new ReadableStream<Uint8Array>({
      async start(c) {
        await new Promise((r) => setTimeout(r, 60));
        c.enqueue(enc.encode('data: a\n\n'));
        await new Promise((r) => setTimeout(r, 60));
        c.enqueue(enc.encode('data: [DONE]\n\n'));
        c.close();
      },
    });
    const r = await defaultTransport(
      { ...binding, fetch: async () => new Response(slow, { headers: { 'content-type': 'text/event-stream' } }) },
      req,
      { timeoutMs: 20 },
    );
    expect(r.stream).toBe(true);
    expect(await new Response(r.body as ReadableStream<Uint8Array>).text()).toContain('[DONE]');
  });
});

describe('流式透传全链路', () => {
  it('声明 stream + 省略 put:流进 res.<id>,fromGlue 直通为 out', async () => {
    const src = mockSource('llm/openai', { sse: 'data: hello\n\ndata: [DONE]\n\n' });
    const { relay } = setup(sseCard(), [src]);
    const out = await relay.handle('llm.chat', { prompt: 'hi' });
    expect(isReadableStream(out)).toBe(true);
    expect(await new Response(out as ReadableStream<Uint8Array>).text()).toContain('data: hello');
  });

  it('toFetchHandler:流式出参 → SSE Response 直通', async () => {
    const src = mockSource('llm/openai', { sse: 'data: hello\n\ndata: [DONE]\n\n' });
    const { relay } = setup(sseCard(), [src]);
    const handler = relay.toFetchHandler();
    const res = await handler(
      new Request('https://x.test/llm.chat', {
        method: 'POST',
        body: JSON.stringify({ prompt: 'hi' }),
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(await res.text()).toContain('data: hello');
  });

  it('流建立前错误照常规范化:非 2xx JSON → errorMap fallback', async () => {
    const card = sseCard([{ ref: 'llm/openai', id: 'up', errorMap: { fallback: 'UPSTREAM_UNKNOWN' } }]);
    const src = mockSource('llm/openai', { status: 503, body: { error: { code: 'OVERLOADED' } } });
    const { relay } = setup(card, [src]);
    await expect(relay.handle('llm.chat', { prompt: 'hi' })).rejects.toMatchObject({
      code: 'GLUE.BUSINESS.UPSTREAM_UNKNOWN',
      status: 502,
    });
  });

  it('未声明 stream 收到流式响应 → UPSTREAM_STREAM_UNDECLARED(拒绝静默旁路)', async () => {
    // 类型上合法的"未声明流式"源站卡片(put 齐备),运行时触达守卫
    const undeclared = defineCard({
      meta: { name: 'llm.chat', version: '1.0.0' },
      in: z.object({ prompt: z.string() }),
      out: z.custom<ReadableStream<Uint8Array>>(),
      glue: z.object({ prompt: z.string() }),
      toGlue: ({ prompt }) => ({ prompt }),
      sources: [
        {
          source: defineSource({
            meta: { name: 'sse.undeclared', version: '1.0.0' },
            ref: 'llm/openai',
            input: z.object({ prompt: z.string() }),
            upstreamRes: z.custom<ReadableStream<Uint8Array>>(),
            output: z.custom<ReadableStream<Uint8Array>>(),
            take: () => ({ method: 'POST' as const, path: '/v1/chat/completions' }),
            put: (raw: ReadableStream<Uint8Array>) => raw,
          }),
          id: 'up',
          bind: (g) => ({ prompt: g.prompt }),
        },
      ],
      fromGlue: (_g, res) => (res as Record<string, ReadableStream<Uint8Array>>).up,
    });
    const src = mockSource('llm/openai', { sse: 'data: hello\n\n' });
    const { relay } = setup(undeclared, [src]);
    const e = await relay.handle('llm.chat', { prompt: 'hi' }).catch((x: unknown) => x);
    expect(e).toMatchObject({ code: 'GLUE.BUSINESS.UPSTREAM_STREAM_UNDECLARED', retryable: false });
  });

  it('firstSuccess:源站 a 网络失败(retryable)→ 切换流式源站 b', async () => {
    const a = mockSource('llm/a', () => {
      throw new TypeError('net down');
    });
    const b = mockSource('llm/b', { sse: 'data: from-b\n\n' });
    const { relay } = setup(
      sseCard([
        { ref: 'llm/a', id: 'a', name: 'sse.a' },
        { ref: 'llm/b', id: 'b', name: 'sse.b' },
      ]),
      [a, b],
    );
    const out = await relay.handle('llm.chat', { prompt: 'hi' });
    expect(await new Response(out as ReadableStream<Uint8Array>).text()).toContain('data: from-b');
    expect(b.mock.calls.length).toBe(1);
  });

  it('失败时释放已建立但未消费的流(fromGlue 抛错路径)', async () => {
    const base = sseCard();
    const captured: unknown[] = [];
    const broken = {
      ...base,
      def: {
        ...base.def,
        fromGlue: (_g: unknown, res: unknown) => {
          captured.push((res as Record<string, ReadableStream<Uint8Array>>).up);
          throw new Error('agg fail');
        },
      },
    } as RelayCard;
    const src = mockSource('llm/openai', { sse: 'data: dangling\n\n' });
    const { relay } = setup(broken, [src]);
    await expect(relay.handle('llm.chat', { prompt: 'hi' })).rejects.toThrow('agg fail');
    const stream = captured[0] as ReadableStream<Uint8Array>;
    const reader = stream.getReader();
    const chunk = await reader.read();
    expect(chunk.done).toBe(true); // 已被 cancel,不再吐内容
  });
});

describe('声明期校验', () => {
  it('stream 源站卡片可省略 put', () => {
    expect(() => sseCard()).not.toThrow();
  });

  it('未声明 stream 的源站卡片省略 put → RegistrationError', () => {
    expect(() =>
      defineSource({
        meta: { name: 'x.y', version: '1.0.0' },
        ref: 'a/b',
        input: z.object({}),
        upstreamRes: z.object({}),
        output: z.object({}),
        take: () => ({ method: 'GET' as const, path: '/' }),
      }),
    ).toThrow(RegistrationError);
  });
});
