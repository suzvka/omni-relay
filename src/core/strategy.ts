import { GlueError } from './errors';

/**
 * 多源站编排:
 * - firstSuccess(默认):顺序执行;仅 retryable 错误切换下一个源站,业务性失败直接抛出;
 * - race:并发执行,首个成功者胜出(失败聚合后抛第一个错误);
 * - all:全部执行(聚合场景)。
 */
export async function runWithStrategy<T>(
  strategy: 'firstSuccess' | 'race' | 'all',
  sources: readonly T[],
  runner: (source: T) => Promise<void>,
): Promise<void> {
  if (strategy === 'all') {
    await Promise.all(sources.map((s) => runner(s)));
    return;
  }
  if (strategy === 'race') {
    try {
      await Promise.any(sources.map((s) => runner(s)));
      return;
    } catch (e) {
      if (e instanceof AggregateError && e.errors.length > 0) {
        throw e.errors[0];
      }
      throw e;
    }
  }
  // firstSuccess
  let lastError: unknown;
  for (const source of sources) {
    try {
      await runner(source);
      return;
    } catch (e) {
      lastError = e;
      if (e instanceof GlueError && e.retryable) continue;
      throw e;
    }
  }
  throw lastError;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
