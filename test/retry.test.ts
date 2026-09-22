import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defineCard, defineSource, RelayController } from '../src/index';
import type {
  ErrorMapDef,
  Logger,
  PolicyInput,
  RelayCard,
  RetrySafety,
  SourceCard,
} from '../src/index';
import { mockSource } from '../src/testing';
import type { MockedSource, MockResponder } from '../src/testing';

// ---------------------------------------------------------------------------
// fixtures:按 HTTP 方法参数化的源站卡片(默认 retrySafety: 'auto')
// ---------------------------------------------------------------------------

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

function makeMethodSourceCard(
  method: Method,
  opts: { retrySafety?: RetrySafety; errorMap?: ErrorMapDef } = {},
): SourceCard {
  return defineSource({
    meta: { name: `svc.${method.toLowerCase()}`, version: '1.0.0' },
    ref: `svc/${method.toLowerCase()}`,
    input: z.object({ n: z.number() }),
    upstreamRes: z.object({ v: z.number() }),
    output: z.object({ v: z.number() }),
    take: ({ n }) =>
      method === 'GET'
        ? { method, path: '/op', query: { n } }
        : { method, path: '/op', body: { n } },
    put: (raw) => raw,
    errorMap: opts.errorMap,
    retrySafety: opts.retrySafety,
  });
}

function makeCard(sc: SourceCard): RelayCard {
  return defineCard({
    meta: { name: 're.exec', version: '1.0.0' },
    in: z.object({}),
    out: z.object({ v: z.number() }),
    uses: [sc.meta.name],
    collect: async (ctx) => {
      await ctx.invoke(sc.meta.name, { n: 1 });
    },
    respond: (ctx) => ({ v: (ctx.ir[sc.meta.name] as { v: number }).v }),
  });
}

function setupRetry(
  sc: SourceCard,
  responder: MockResponder,
  policy?: PolicyInput,
  logger?: Logger,
): { relay: ReturnType<RelayController['buildRelay']>; src: MockedSource } {
  const src = mockSource(sc.def.ref, responder);
  const controller = new RelayController(logger ? { logger } : {});
  controller.registerSource(src.ref, src.binding);
  controller.registerSourceCard(sc);
  const card = makeCard(sc);
  controller.registerCard(card);
  if (policy) controller.setPolicy(card.meta.name, policy);
  return { relay: controller.buildRelay(), src };
}

/** 恒定网络错误:模拟回包丢失/连接中断(结果不确定) */
const NETWORK_DOWN: MockResponder = () => {
  throw new Error('network down');
};

/** 单次重试(指数退避 200ms,控制测试耗时) */
const RETRY1: PolicyInput = { retry: { max: 1, backoff: 'expo' } };

function spyLogger(): { logger: Logger; warn: ReturnType<typeof vi.fn> } {
  const warn = vi.fn();
  return { warn, logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() } };
}

// ---------------------------------------------------------------------------

describe('重试安全门禁(传输层歧义错误按方法幂等性放行)', () => {
  it('POST + NETWORK:默认不自动重试(仅 1 次调用,warn 告警)', async () => {
    const { logger, warn } = spyLogger();
    const { relay, src } = setupRetry(
      makeMethodSourceCard('POST'),
      NETWORK_DOWN,
      { retry: { max: 2, backoff: 'expo' } },
      logger,
    );
    const e = await relay.handle('re.exec', {}).catch((x: unknown) => x);
    expect(e).toMatchObject({ code: 'GLUE.TRANSPORT.NETWORK', retryable: true });
    expect(src.mock.calls).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('跳过自动重试');
  });

  it('POST + retrySafety:idempotent:显式放行后重试(首次网络错,二次成功)', async () => {
    const { relay, src } = setupRetry(
      makeMethodSourceCard('POST', { retrySafety: 'idempotent' }),
      (_req, i) => {
        if (i === 0) throw new Error('network down');
        return { body: { v: 7 } };
      },
      RETRY1,
    );
    const out = await relay.handle('re.exec', {});
    expect(out).toEqual({ v: 7 });
    expect(src.mock.calls).toHaveLength(2);
  });

  it('GET 默认安全:NETWORK 重试至耗尽', async () => {
    const { relay, src } = setupRetry(makeMethodSourceCard('GET'), NETWORK_DOWN, RETRY1);
    const e = await relay.handle('re.exec', {}).catch((x: unknown) => x);
    expect(e).toMatchObject({ code: 'GLUE.TRANSPORT.NETWORK' });
    expect(src.mock.calls).toHaveLength(2);
  });

  it('PUT 默认安全(DELETE 同集):NETWORK 重试至耗尽', async () => {
    const { relay, src } = setupRetry(makeMethodSourceCard('PUT'), NETWORK_DOWN, RETRY1);
    const e = await relay.handle('re.exec', {}).catch((x: unknown) => x);
    expect(e).toMatchObject({ code: 'GLUE.TRANSPORT.NETWORK' });
    expect(src.mock.calls).toHaveLength(2);
  });

  it('PATCH 默认不安全:max 2 也不重试', async () => {
    const { relay, src } = setupRetry(makeMethodSourceCard('PATCH'), NETWORK_DOWN, {
      retry: { max: 2, backoff: 'expo' },
    });
    const e = await relay.handle('re.exec', {}).catch((x: unknown) => x);
    expect(e).toMatchObject({ code: 'GLUE.TRANSPORT.NETWORK' });
    expect(src.mock.calls).toHaveLength(1);
  });

  it('retrySafety:unsafe:GET 也不自动重试', async () => {
    const { relay, src } = setupRetry(
      makeMethodSourceCard('GET', { retrySafety: 'unsafe' }),
      NETWORK_DOWN,
      { retry: { max: 2, backoff: 'expo' } },
    );
    const e = await relay.handle('re.exec', {}).catch((x: unknown) => x);
    expect(e).toMatchObject({ code: 'GLUE.TRANSPORT.NETWORK' });
    expect(src.mock.calls).toHaveLength(1);
  });
});

describe('业务错误码重试不受方法门禁(响应已到达,源站已拒绝请求)', () => {
  const codeOf = (b: unknown) => (b as { error?: { code?: string } } | null)?.error?.code;

  it('POST + RATE_LIMITED(retryableCodes):仍重试', async () => {
    const sc = makeMethodSourceCard('POST', {
      errorMap: {
        extract: codeOf,
        map: { RATE_LIMITED: 'UPSTREAM_RATE_LIMITED' },
        retryableCodes: ['UPSTREAM_RATE_LIMITED'],
      },
    });
    const { relay, src } = setupRetry(
      sc,
      (_req, i) => (i === 0 ? { body: { error: { code: 'RATE_LIMITED' } } } : { body: { v: 3 } }),
      RETRY1,
    );
    const out = await relay.handle('re.exec', {});
    expect(out).toEqual({ v: 3 });
    expect(src.mock.calls).toHaveLength(2);
  });

  it('POST + 映射项 retryable:true(新形状):同等放行', async () => {
    const sc = makeMethodSourceCard('POST', {
      errorMap: {
        extract: codeOf,
        map: { RATE_LIMITED: { code: 'UPSTREAM_RATE_LIMITED', retryable: true } },
      },
    });
    const { relay, src } = setupRetry(
      sc,
      (_req, i) => (i === 0 ? { body: { error: { code: 'RATE_LIMITED' } } } : { body: { v: 4 } }),
      RETRY1,
    );
    const out = await relay.handle('re.exec', {});
    expect(out).toEqual({ v: 4 });
    expect(src.mock.calls).toHaveLength(2);
  });
});
