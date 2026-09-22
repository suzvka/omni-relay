import type * as z from 'zod';
import { RegistrationError } from './errors';
import type { CardMeta, ErrorMapDef, RawSourceCardDef, SourceCard } from './types';

/**
 * 定义一张源站卡片(API 卡片 / 对接侧插件):封装"连接一个源站 + 清洗为原子字段"。
 * 声明期即做自洽校验,"对不上"在这里就地报错。
 * 对接者只声明能力契约(input:invoke 从 IR 读取的键;output:写回 IR 的原子字段),不知道谁消费;
 * 业务卡片 collect 经 ctx.invoke 按名调用,须先经中心化注册表 registerSourceCard 注册。
 */
export function defineSource<
  TIn extends z.ZodType,
  TOut extends z.ZodType,
  TUpRes extends z.ZodType,
>(def: RawSourceCardDef<TIn, TOut, TUpRes>): SourceCard<RawSourceCardDef<TIn, TOut, TUpRes>> {
  assertZod(def.input, 'input');
  assertZod(def.output, 'output');
  assertZod(def.upstreamRes, 'upstreamRes');
  if (typeof def.ref !== 'string' || !def.ref) {
    throw new RegistrationError('ref 必填(物理绑定引用)', 'source:ref');
  }
  if (typeof def.take !== 'function') {
    throw new RegistrationError('take 必须是函数', 'source:take');
  }
  if (typeof def.put !== 'function' && !def.stream) {
    throw new RegistrationError(
      'put 必须是函数(声明 stream 的源站可省略)',
      'source:put',
    );
  }
  const safety = def.retrySafety as unknown;
  if (safety !== undefined && safety !== 'auto' && safety !== 'idempotent' && safety !== 'unsafe') {
    throw new RegistrationError(
      `retrySafety 必须是 'auto' | 'idempotent' | 'unsafe'(收到 ${String(safety)})`,
      'source:retrySafety',
    );
  }
  assertErrorMap(def.errorMap);
  const meta: CardMeta = {
    name: def.meta?.name ?? '',
    version: def.meta?.version ?? '0.0.0',
  };
  if (!meta.name) {
    throw new RegistrationError('meta.name 必填', 'source:meta');
  }
  return Object.freeze({
    def,
    meta,
  }) as unknown as SourceCard<RawSourceCardDef<TIn, TOut, TUpRes>>;
}

function assertZod(schema: unknown, where: string): void {
  const s = schema as { safeParse?: unknown } | null | undefined;
  if (!s || typeof s.safeParse !== 'function') {
    throw new RegistrationError(`${where} 必须是 Zod schema`, `source:${where}`);
  }
}

/** errorMap 形状校验:条目为非空业务码字符串,或 { code, status?(100–599), retryable? } 对象 */
function assertErrorMap(em: ErrorMapDef | undefined): void {
  if (em === undefined) return;
  const check = (value: unknown, where: string): void => {
    if (typeof value === 'string') {
      if (!value) throw new RegistrationError(`${where} 的业务码不能为空`, 'source:errorMap');
      return;
    }
    const entry = value as { code?: unknown; status?: unknown; retryable?: unknown } | null;
    if (!entry || typeof entry !== 'object' || typeof entry.code !== 'string' || !entry.code) {
      throw new RegistrationError(
        `${where} 必须是业务码字符串或 { code, status?, retryable? } 对象`,
        'source:errorMap',
      );
    }
    if (
      entry.status !== undefined &&
      (!Number.isInteger(entry.status) ||
        (entry.status as number) < 100 ||
        (entry.status as number) > 599)
    ) {
      throw new RegistrationError(`${where}.status 必须是 100–599 的整数`, 'source:errorMap');
    }
    if (entry.retryable !== undefined && typeof entry.retryable !== 'boolean') {
      throw new RegistrationError(`${where}.retryable 必须是布尔值`, 'source:errorMap');
    }
  };
  for (const [key, value] of Object.entries(em.map ?? {})) check(value, `errorMap.map.${key}`);
  if (em.fallback !== undefined) check(em.fallback, 'errorMap.fallback');
}
