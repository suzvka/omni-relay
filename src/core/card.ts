import * as z from 'zod';
import { RegistrationError } from './errors';
import type { CardMeta, RawCardDef, RelayCard } from './types';

/**
 * 定义一张商品卡片(v2 命令式双钩子:collect / respond)。
 * 卡片是 IR 的编排者:collect 直读直写 IR、按需 invoke API 卡片把数据收集进来,
 * respond 只读 IR 构筑出参;它只对 IR 契约负责,不接触源站细节——对接逻辑住在被 invoke 的源站卡片里。
 * 声明期即做自洽校验,"对不上"在这里就地报错。
 */
export function defineCard<
  TIn extends z.ZodType,
  TOut extends z.ZodType,
>(def: RawCardDef<TIn, TOut>): RelayCard<RawCardDef<TIn, TOut>> {
  assertZod(def.in, 'in');
  assertZod(def.out, 'out');
  if (typeof def.collect !== 'function') {
    throw new RegistrationError('collect 必须是函数', 'card:collect');
  }
  if (typeof def.respond !== 'function') {
    throw new RegistrationError('respond 必须是函数', 'card:respond');
  }

  // seeds:宿主注册期注入的 IR 初始键,每个值须为 Zod schema(buildRelay 上线门据此校验存在+类型)
  const seedKeys: string[] = [];
  for (const [key, schema] of Object.entries(def.seeds ?? {})) {
    if (!schema || typeof (schema as { safeParse?: unknown }).safeParse !== 'function') {
      throw new RegistrationError(`seeds.${key} 必须是 Zod schema`, 'card:seeds');
    }
    seedKeys.push(key);
  }

  // uses:可选,声明可能 invoke 的源站卡片名(非空字符串数组;仅供 manifest 交叉校验与 inspect)
  if (def.uses !== undefined) {
    if (!Array.isArray(def.uses) || def.uses.some((u) => typeof u !== 'string' || !u)) {
      throw new RegistrationError('uses 必须是非空字符串数组', 'card:uses');
    }
  }

  const meta: CardMeta = {
    name: def.meta?.name ?? '',
    version: def.meta?.version ?? '0.0.0',
  };
  if (!meta.name) {
    throw new RegistrationError('meta.name 必填', 'card:meta');
  }

  return Object.freeze({
    def,
    meta,
    seedKeys: Object.freeze(seedKeys),
    uses: Object.freeze([...(def.uses ?? [])]),
  }) as unknown as RelayCard<RawCardDef<TIn, TOut>>;
}

function assertZod(schema: unknown, where: string): void {
  const s = schema as { safeParse?: unknown } | null | undefined;
  if (!s || typeof s.safeParse !== 'function') {
    throw new RegistrationError(`${where} 必须是 Zod schema`, `card:${where}`);
  }
}
