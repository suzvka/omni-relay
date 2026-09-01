import { GlueError } from './errors';
import { runCard } from './pipeline';
import type { PipelineDeps, RegisteredCard } from './pipeline';
import { isReadableStream } from './stream';
import type { FetchHandler, FetchHandlerOptions, HandleOptions } from './types';

/** 服务目录提供者:每次 handle 实时解析当前目录(原子切换),in-flight 请求持旧引用跑完 */
export type CatalogProvider = () => ReadonlyMap<string, RegisteredCard>;

export class Relay {
  constructor(
    private readonly catalog: CatalogProvider,
    private readonly deps: PipelineDeps,
  ) {}

  /** 程序化调用:成功返回 out,失败抛 GlueError */
  async handle<T = unknown>(
    name: string,
    input: unknown,
    opts: HandleOptions = {},
  ): Promise<T> {
    const entry = this.catalog().get(name);
    if (!entry) throw GlueError.cardNotFound(name);
    return (await runCard(this.deps, entry, input, opts)) as T;
  }

  /** 暴露为框架无关的 fetch handler(网关/直通场景) */
  toFetchHandler(opts: FetchHandlerOptions = {}): FetchHandler {
    return async (req) => {
      let name: string | null | undefined;
      try {
        name = opts.route ? await opts.route(req) : defaultRoute(req);
      } catch {
        name = undefined;
      }
      if (!name) {
        return jsonResponse({ error: { code: 'GLUE.CARD.NOT_FOUND' } }, 404);
      }

      let input: unknown;
      if (req.method === 'GET' || req.method === 'HEAD') {
        input = Object.fromEntries(new URL(req.url).searchParams);
      } else {
        try {
          input = await req.json();
        } catch {
          return jsonResponse({ error: { code: 'GLUE.SCHEMA.IN' } }, 400);
        }
      }

      try {
        const out = await this.handle(name, input, { signal: req.signal });
        // 流式出参:out 为 ReadableStream → SSE 直通(不 JSON 序列化)
        if (isReadableStream(out)) {
          return new Response(out, {
            status: 200,
            headers: {
              'content-type': 'text/event-stream',
              'cache-control': 'no-cache',
              connection: 'keep-alive',
            },
          });
        }
        return jsonResponse(out ?? {}, 200);
      } catch (e) {
        if (e instanceof GlueError) {
          // raw 与内部 message 均不透出
          return jsonResponse({ error: { code: e.code, sourceId: e.sourceId } }, e.status);
        }
        const unknown = GlueError.unknown(e);
        return jsonResponse({ error: { code: unknown.code } }, unknown.status);
      }
    };
  }
}

function defaultRoute(req: Request): string | undefined {
  const p = new URL(req.url).pathname.replace(/^\/+|\/+$/g, '');
  if (!p) return undefined;
  try {
    return decodeURIComponent(p);
  } catch {
    return p;
  }
}

function jsonResponse(data: unknown, status: number): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
