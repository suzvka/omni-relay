import type * as z from 'zod';
import { RegistrationError } from './errors';
import type { CardMeta, RawSourceCardDef, SourceCard } from './types';

/**
 * 定义一张源站卡片(对接侧插件):封装"连接一个源站 + 清洗为原子字段"。
 * 声明期即做自洽校验,"对不上"在这里就地报错。
 * 对接者只声明能力契约(需要什么入参、能提供哪些原子字段),不知道谁消费;
 * 业务卡片经 SourceCardRef 引用,经中心化注册表注册后方可使用。
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
