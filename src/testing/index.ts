import { MockSource } from '../source/transport';
import type { MockResponse, MockResponder } from '../source/transport';
import type { SourceBinding, UpstreamRequest } from '../core/types';

export { MockSource } from '../source/transport';
export type { MockResponse, MockResponder } from '../source/transport';

export interface MockedSource {
  ref: string;
  binding: SourceBinding;
  mock: MockSource;
}

/**
 * 构造一个可注册的 mock 源站:回放规则支持
 * - 单个响应 / 响应序列(超出后取最后一个,便于测试重试耗尽)/ 自定义函数;
 * - mock.calls 记录每次请求,便于断言 take 产物。
 */
export function mockSource(ref: string, responder: MockResponder): MockedSource {
  const mock = new MockSource(responder);
  return {
    ref,
    mock,
    binding: { baseURL: `https://mock.local/${ref}`, fetch: mock.fetch },
  };
}

/** 便捷:断言第 n 次调用的请求体(take 产物经 transport 序列化后) */
export function lastBody(mock: MockSource): unknown {
  const last = mock.calls[mock.calls.length - 1];
  const body = last?.init?.body;
  if (typeof body !== 'string') return body;
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

export type { SourceBinding, UpstreamRequest };
