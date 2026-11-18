/** test-meta: tier=fast; risk=medium; owner=platform; expires=2027-03-31 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  defaultTransport,
  defineCard,
  defineSource,
  GlueError,
  isReadableStream,
  RegistrationError,
  RelayController,
} from '../src/index';
import { mockSource } from '../src/testing';
import type {
  ErrorMapDef,
  RelayCard,
  RespondCtx,
  SourceBinding,
  SourceCard,
  UpstreamRequest,
} from '../src/index';
import type { MockedSource } from '../src/testing';
import { registerCardDeps } from './helpers';

const binding: SourceBinding = { baseURL: 'https://x.test' };
const req: UpstreamRequest = { method: 'POST', path: '/v1/chat/completions' };

/** 流式源站卡片(stream 声明 + 省略 put) */
function sseSourceCard(ref: string, name: string, errorMap?: ErrorMapDef): SourceCard {
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

/** 流式业务卡片(collect 手写多源容灾 + invoke;respond 直通首个成功产物) */
function sseCard(
  specs: Array<{ ref: string; name: string; errorMap?: ErrorMapDef }> = [
    { ref: 'llm/openai', name: 'sse.up' },
  ],
): { card: RelayCard; sourceCards: SourceCard[] } {
  const sourceCards = specs.map(({ ref, name, errorMap }) => sseSourceCard(ref, name, errorMap));
  const card = defineCard({
    meta: { name: 'llm.chat', version: '1.0.0' },
    in: z.object({ prompt: z.string() }),
    out: z.custom<ReadableStream<Uint8Array>>(),
    uses: sourceCards.map((sc) => sc.meta.name),
    collect: async (ctx) => {
      ctx.ir.prompt = (ctx.input as { prompt: string }).prompt;
      // 多源手写 firstSuccess 容灾:仅 retryable 错误切换下一个(框架不再自动编排)
      let lastErr: unknown;
      for (const sc of sourceCards) {
        try {
          await ctx.invoke(sc.meta.name);
          return;
        } catch (e) {
          if (e instanceof GlueError && e.retryable) {
            lastErr = e;
            continue;
          }
          throw e;
        }
      }
      throw lastErr;
    },
    respond: (ctx) => {
      for (const sc of sourceCards) {
        const v = ctx.ir[sc.meta.name];
        if (v !== undefined) return v as ReadableStream<Uint8Array>;
      }
      throw new Error('无流式产物');
    },
  });
  return { card, sourceCards };
}

function setupStream(card: RelayCard, sourceCards: SourceCard[], sources: MockedSource[]) {
  const controller = new RelayController();
  registerCardDeps(controller, card, sourceCards, sources);
  return { controller, relay: controller.buildRelay(), sources };
}

describe('defaultTransport 流式识别', () => {
  it('event-stream → stream: true + ReadableStream 直通(不读体)', async () => {
    const mock = mockSource('llm/x', { sse: 'data: hi\n\ndata: [DONE]\n\n' });
    const r = await defaultTransport({ ...binding, fetch: mock.binding.fetch }, req, {});
    expect(r.stream).toBe(true);
    expect(isReadableStream(r.body)).toBe(true);
    expect(await new Response(r.body as ReadableStream<Uint8Array>).text()).toBe(
      'data: hi\n\ndata: [DONE]\n\n',
    );
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
      {
        ...binding,
        fetch: async () => new Response(slow, { headers: { 'content-type': 'text/event-stream' } }),
      },
      req,
      { timeoutMs: 20 },
    );
    expect(r.stream).toBe(true);
    expect(await new Response(r.body as ReadableStream<Uint8Array>).text()).toContain('[DONE]');
  });
});

describe('流式透传全链路', () => {
  it('声明 stream + 省略 put:流进 ir[id],respond 直通为 out', async () => {
    const { card, sourceCards } = sseCard();
    const src = mockSource('llm/openai', { sse: 'data: hello\n\ndata: [DONE]\n\n' });
    const { relay } = setupStream(card, sourceCards, [src]);
    const out = await relay.handle('llm.chat', { prompt: 'hi' });
    expect(isReadableStream(out)).toBe(true);
    expect(await new Response(out as ReadableStream<Uint8Array>).text()).toContain('data: hello');
  });

  it('toFetchHandler:流式出参 → SSE Response 直通', async () => {
    const { card, sourceCards } = sseCard();
    const src = mockSource('llm/openai', { sse: 'data: hello\n\ndata: [DONE]\n\n' });
    const { relay } = setupStream(card, sourceCards, [src]);
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
    const { card, sourceCards } = sseCard([
      { ref: 'llm/openai', name: 'sse.up', errorMap: { fallback: 'UPSTREAM_UNKNOWN' } },
    ]);
    const src = mockSource('llm/openai', { status: 503, body: { error: { code: 'OVERLOADED' } } });
    const { relay } = setupStream(card, sourceCards, [src]);
    await expect(relay.handle('llm.chat', { prompt: 'hi' })).rejects.toMatchObject({
      code: 'GLUE.BUSINESS.UPSTREAM_UNKNOWN',
      status: 502,
    });
  });

  it('未声明 stream 收到流式响应 → UPSTREAM_STREAM_UNDECLARED(拒绝静默旁路)', async () => {
    const undeclaredSc = defineSource({
      meta: { name: 'sse.undeclared', version: '1.0.0' },
      ref: 'llm/openai',
      input: z.object({ prompt: z.string() }),
      upstreamRes: z.custom<ReadableStream<Uint8Array>>(),
      output: z.custom<ReadableStream<Uint8Array>>(),
      take: () => ({ method: 'POST' as const, path: '/v1/chat/completions' }),
      put: (raw: ReadableStream<Uint8Array>) => raw,
    });
    const card = defineCard({
      meta: { name: 'llm.chat', version: '1.0.0' },
      in: z.object({ prompt: z.string() }),
      out: z.custom<ReadableStream<Uint8Array>>(),
      uses: [undeclaredSc.meta.name],
      collect: async (ctx) => {
        ctx.ir.prompt = (ctx.input as { prompt: string }).prompt;
        await ctx.invoke(undeclaredSc.meta.name);
      },
      respond: (ctx) => ctx.ir[undeclaredSc.meta.name] as ReadableStream<Uint8Array>,
    });
    const src = mockSource('llm/openai', { sse: 'data: hello\n\n' });
    const { relay } = setupStream(card, [undeclaredSc], [src]);
    const e = await relay.handle('llm.chat', { prompt: 'hi' }).catch((x: unknown) => x);
    expect(e).toMatchObject({
      code: 'GLUE.BUSINESS.UPSTREAM_STREAM_UNDECLARED',
      retryable: false,
    });
  });

  it('多源手写容灾:源站 a 网络失败(retryable)→ 切换流式源站 b', async () => {
    const { card, sourceCards } = sseCard([
      { ref: 'llm/a', name: 'sse.a' },
      { ref: 'llm/b', name: 'sse.b' },
    ]);
    const a = mockSource('llm/a', () => {
      throw new TypeError('net down');
    });
    const b = mockSource('llm/b', { sse: 'data: from-b\n\n' });
    const { relay } = setupStream(card, sourceCards, [a, b]);
    const out = await relay.handle('llm.chat', { prompt: 'hi' });
    expect(await new Response(out as ReadableStream<Uint8Array>).text()).toContain('data: from-b');
    expect(b.mock.calls.length).toBe(1);
  });

  it('失败时释放已建立但未消费的流(respond 抛错路径)', async () => {
    const { card, sourceCards } = sseCard();
    const name = sourceCards[0]!.meta.name;
    const captured: unknown[] = [];
    const broken = {
      ...card,
      def: {
        ...card.def,
        respond: (ctx: RespondCtx) => {
          captured.push(ctx.ir[name]);
          throw new Error('agg fail');
        },
      },
    } as RelayCard;
    const src = mockSource('llm/openai', { sse: 'data: dangling\n\n' });
    const { relay } = setupStream(broken, sourceCards, [src]);
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

describe('非 SSE 流式帧(ndjson)', () => {
  const NDJSON = 'application/x-ndjson';
  const ndjsonBody = '{"type":"progress","p":0.5}\n{"type":"done"}\n';

  function ndjsonSource(): SourceCard {
    return defineSource({
      meta: { name: 'nd.up', version: '1.0.0' },
      ref: 'render/ndjson',
      stream: true,
      streamContentType: NDJSON,
      input: z.object({ prompt: z.string() }),
      upstreamRes: z.custom<ReadableStream<Uint8Array>>(),
      output: z.custom<ReadableStream<Uint8Array>>(),
      take: ({ prompt }) => ({ method: 'POST' as const, path: '/v1/render', body: { prompt } }),
    });
  }

  function ndjsonCard(streamContentType?: string): RelayCard {
    return defineCard({
      meta: { name: 'render.ndjson', version: '1.0.0' },
      in: z.object({ prompt: z.string() }),
      out: z.custom<ReadableStream<Uint8Array>>(),
      uses: ['nd.up'],
      streamContentType,
      collect: async (ctx) => {
        ctx.ir.prompt = (ctx.input as { prompt: string }).prompt;
        await ctx.invoke('nd.up');
      },
      respond: (ctx) => ctx.ir['nd.up'] as ReadableStream<Uint8Array>,
    });
  }

  it('defaultTransport:声明 ndjson 标签时识别为流,未声明时按文本读取', async () => {
    const tagged = mockSource('render/ndjson', {
      sse: ndjsonBody,
      headers: { 'content-type': NDJSON },
    });
    const withTag = await defaultTransport(
      { ...binding, fetch: tagged.binding.fetch },
      req,
      { streamContentType: NDJSON },
    );
    expect(withTag.stream).toBe(true);
    expect(await new Response(withTag.body as ReadableStream<Uint8Array>).text()).toBe(ndjsonBody);

    const untagged = mockSource('render/ndjson', {
      sse: ndjsonBody,
      headers: { 'content-type': NDJSON },
    });
    const withoutTag = await defaultTransport(
      { ...binding, fetch: untagged.binding.fetch },
      req,
      {},
    );
    expect(withoutTag.stream).toBeUndefined();
  });

  it('源站卡片声明 streamContentType:accept 按声明协商', async () => {
    const src = mockSource('render/ndjson', {
      sse: ndjsonBody,
      headers: { 'content-type': NDJSON },
    });
    const { relay } = setupStream(ndjsonCard(), [ndjsonSource()], [src]);
    const out = await relay.handle('render.ndjson', { prompt: 'x' });
    expect(await new Response(out as ReadableStream<Uint8Array>).text()).toContain('done');
    const headers = src.mock.calls[0]?.init?.headers as Record<string, string>;
    expect(headers.accept).toBe(NDJSON);
  });

  it('业务卡片声明 streamContentType:toFetchHandler 按声明返回', async () => {
    const src = mockSource('render/ndjson', {
      sse: ndjsonBody,
      headers: { 'content-type': NDJSON },
    });
    const { relay } = setupStream(ndjsonCard(NDJSON), [ndjsonSource()], [src]);
    const res = await relay.toFetchHandler()(
      new Request('https://x.test/render.ndjson', {
        method: 'POST',
        body: JSON.stringify({ prompt: 'x' }),
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe(NDJSON);
    expect(await res.text()).toContain('done');
  });

  it('stream 源站显式 accept 不被覆盖', async () => {
    const sc = defineSource({
      meta: { name: 'nd.accept', version: '1.0.0' },
      ref: 'render/ndjson',
      stream: true,
      streamContentType: NDJSON,
      input: z.object({ prompt: z.string() }),
      upstreamRes: z.custom<ReadableStream<Uint8Array>>(),
      output: z.custom<ReadableStream<Uint8Array>>(),
      take: ({ prompt }) => ({
        method: 'POST' as const,
        path: '/v1/render',
        headers: { accept: 'application/json' },
        body: { prompt },
      }),
    });
    const card = defineCard({
      meta: { name: 'render.accept', version: '1.0.0' },
      in: z.object({ prompt: z.string() }),
      out: z.custom<ReadableStream<Uint8Array>>(),
      uses: ['nd.accept'],
      collect: async (ctx) => {
        ctx.ir.prompt = (ctx.input as { prompt: string }).prompt;
        await ctx.invoke('nd.accept');
      },
      respond: (ctx) => ctx.ir['nd.accept'] as ReadableStream<Uint8Array>,
    });
    const src = mockSource('render/ndjson', {
      sse: ndjsonBody,
      headers: { 'content-type': NDJSON },
    });
    const { relay } = setupStream(card, [sc], [src]);
    await relay.handle('render.accept', { prompt: 'x' });
    const headers = src.mock.calls[0]?.init?.headers as Record<string, string>;
    expect(headers.accept).toBe('application/json');
  });

  it('未声明 stream 却给 streamContentType → RegistrationError', () => {
    expect(() =>
      defineSource({
        meta: { name: 'x.y', version: '1.0.0' },
        ref: 'a/b',
        streamContentType: NDJSON,
        input: z.object({}),
        upstreamRes: z.object({}),
        output: z.object({}),
        take: () => ({ method: 'GET' as const, path: '/' }),
      }),
    ).toThrow(RegistrationError);
  });
});
