import { GlueError } from '../core/errors';
import type {
  AuthInput,
  FetchLike,
  SourceBinding,
  TransportResult,
  UpstreamRequest,
} from '../core/types';

export type TransportFn = (
  binding: SourceBinding,
  req: UpstreamRequest,
  opts: { signal?: AbortSignal; timeoutMs?: number },
) => Promise<TransportResult>;

/** 组装最终 URL:baseURL + path(:param 替换)+ query(过滤 undefined) */
export function buildUrl(binding: SourceBinding, req: UpstreamRequest): string {
  let path = req.path;
  for (const [key, value] of Object.entries(req.params ?? {})) {
    path = path.split(`:${key}`).join(encodeURIComponent(String(value)));
  }
  const base = binding.baseURL.replace(/\/+$/, '');
  const suffix = path.replace(/^\/+/, '');
  let url = suffix ? `${base}/${suffix}` : base;
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(req.query ?? {})) {
    if (value !== undefined) search.set(key, String(value));
  }
  const qs = search.toString();
  if (qs) url += `?${qs}`;
  return url;
}

export interface BuiltRequest {
  method: string;
  headers: Record<string, string>;
  body?: string;
}

export async function buildInit(
  binding: SourceBinding,
  req: UpstreamRequest,
): Promise<BuiltRequest> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    ...binding.headers,
    ...req.headers,
  };
  if (req.body !== undefined) {
    headers['content-type'] = headers['content-type'] ?? 'application/json';
  }
  if (binding.auth) {
    const auth: AuthInput = await binding.auth();
    if (typeof auth === 'string') {
      headers.authorization = auth.toLowerCase().startsWith('bearer ')
        ? auth
        : `Bearer ${auth}`;
    } else if (auth && typeof auth === 'object') {
      Object.assign(headers, auth.headers);
    }
  }
  return {
    method: req.method,
    headers,
    body: req.body === undefined ? undefined : JSON.stringify(req.body),
  };
}
function isAbortLike(e: unknown): boolean {
  return e instanceof Error && e.name === 'AbortError';
}

async function readBody(res: Response): Promise<unknown> {
  const contentType = res.headers.get('content-type') ?? '';
  try {
    if (contentType.includes('json')) return await res.json();
    const text = await res.text();
    if (text && (text.startsWith('{') || text.startsWith('['))) {
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }
    return text;
  } catch {
    return undefined;
  }
}

/**
 * 标准实现:fetch + 惰性 auth + 超时(AbortSignal 手动组合,兼容 Node 18)。
 * 传输层错误统一收敛为 GlueError(TIMEOUT/CANCELLED/NETWORK)。
 */
export const defaultTransport: TransportFn = async (binding, req, opts) => {
  const url = buildUrl(binding, req);
  const init = await buildInit(binding, req);

  const timeoutMs = opts.timeoutMs ?? binding.timeoutMs;
  const external = opts.signal;
  const externalAborted = external?.aborted ?? false;
  if (externalAborted) throw GlueError.transport('CANCELLED', undefined, external?.reason);

  const ac = new AbortController();
  let timedOut = false;
  const timer =
    timeoutMs && timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          ac.abort();
        }, timeoutMs)
      : undefined;
  const onExternalAbort = () => ac.abort();
  external?.addEventListener('abort', onExternalAbort, { once: true });

  const doFetch: FetchLike = binding.fetch ?? ((input, i) => fetch(input, i));
  // 流式响应:外部 abort 监听不随 finally 解除,保持"客户端断开 → 上游流终止"的传播
  let keepAbortListener = false;
  try {
    const res = await doFetch(url, { ...init, signal: ac.signal });
    const headers = Object.fromEntries(res.headers.entries());
    // event-stream → body 直通(ReadableStream);超时定时器随 finally 释放,只覆盖到流建立
    if (res.body !== null && (res.headers.get('content-type') ?? '').includes('text/event-stream')) {
      keepAbortListener = true;
      return { status: res.status, body: res.body, headers, stream: true };
    }
    return {
      status: res.status,
      body: await readBody(res),
      headers,
    };
  } catch (e) {
    if (timedOut) throw GlueError.transport('TIMEOUT', undefined, e);
    if (isAbortLike(e) && external?.aborted) throw GlueError.transport('CANCELLED', undefined, e);
    throw GlueError.transport('NETWORK', undefined, e);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (!keepAbortListener) external?.removeEventListener('abort', onExternalAbort);
  }
};

// ---------------------------------------------------------------------------
// MockTransport(测试投影的底层;testing 子入口提供更便捷的封装)
// ---------------------------------------------------------------------------

export interface MockResponse {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** 流式回放:SSE 文本或现成 ReadableStream(以 text/event-stream 返回,供流式透传测试) */
  sse?: string | ReadableStream<Uint8Array>;
}

export type MockResponder =
  | MockResponse
  | readonly MockResponse[]
  | ((req: UpstreamRequest, call: number) => MockResponse | Promise<MockResponse>);

/** 可观测的 mock fetch:记录每次调用,按函数/单值/序列回放;尊重 AbortSignal */
export class MockSource {
  readonly calls: Array<{ url: string; init?: RequestInit }> = [];
  private readonly responder: MockResponder;

  constructor(responder: MockResponder) {
    this.responder = responder;
  }

  readonly fetch: FetchLike = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    this.calls.push({ url, init });
    const call = this.calls.length - 1;
    const picked = Promise.resolve().then(() => this.pick(call));
    const signal = init?.signal;
    if (!signal) return picked.then((p) => toResponse(p));
    const abortP = new Promise<never>((_, reject) => {
      const abortError = () =>
        reject(new DOMException('This operation was aborted', 'AbortError'));
      if (signal.aborted) {
        abortError();
        return;
      }
      signal.addEventListener('abort', abortError, { once: true });
    });
    return Promise.race([picked, abortP]).then((p) => toResponse(p));
  };

  private async pick(call: number): Promise<MockResponse> {
    if (typeof this.responder === 'function') {
      return await (
        this.responder as (
          req: UpstreamRequest & Record<string, unknown>,
          call: number,
        ) => MockResponse | Promise<MockResponse>
      )({ body: undefined } as UpstreamRequest & Record<string, unknown>, call);
    }
    if (Array.isArray(this.responder)) {
      const idx = Math.min(call, this.responder.length - 1);
      return this.responder[idx] ?? {};
    }
    return this.responder as MockResponse;
  }
}

function toResponse(picked: MockResponse): Response {
  const status = picked.status ?? 200;
  if (picked.sse !== undefined) {
    const stream = typeof picked.sse === 'string' ? stringStream(picked.sse) : picked.sse;
    return new Response(stream, {
      status,
      headers: { 'content-type': 'text/event-stream', ...picked.headers },
    });
  }
  const headers = { 'content-type': 'application/json', ...picked.headers };
  return new Response(JSON.stringify(picked.body ?? {}), { status, headers });
}

/** 文本 → 单 chunk ReadableStream(测试回放用) */
function stringStream(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}
