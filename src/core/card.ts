import * as z from 'zod';
import { RegistrationError } from './errors';
import { scanGlueMeta } from './markers';
import type {
  CardMeta,
  RawCardDef,
  RelayCard,
  RelayMiddleware,
  Seam,
  SourceCard,
} from './types';

const VALID_SEAMS: readonly Seam[] = ['toGlue', 'bind', 'take', 'put', 'fromGlue'];

/**
 * 定义一张商品卡片:5 件套(in/out/glue/toGlue+fromGlue/sources)。
 * 声明期即做自洽校验,"对不上"在这里就地报错。
 * sources 是对源站卡片的引用:对接逻辑住在源站卡片里,卡片只做参数映射与计算派生。
 */
export function defineCard<
  TIn extends z.ZodType,
  TOut extends z.ZodType,
  TGlue extends z.ZodObject<any>,
>(def: RawCardDef<TIn, TOut, TGlue>): RelayCard<RawCardDef<TIn, TOut, TGlue>> {
  assertZod(def.in, 'in');
  assertZod(def.out, 'out');
  if (!(def.glue instanceof z.ZodObject) && typeof (def.glue as any)?.shape !== 'object') {
    throw new RegistrationError('glue 必须是 z.object(...)', 'card:glue');
  }
  if (typeof def.toGlue !== 'function') {
    throw new RegistrationError('toGlue 必须是函数', 'card:toGlue');
  }
  if (typeof def.fromGlue !== 'function') {
    throw new RegistrationError('fromGlue 必须是函数', 'card:fromGlue');
  }
  if (!Array.isArray(def.sources) || def.sources.length === 0) {
    throw new RegistrationError('sources 至少声明一个源站卡片', 'card:sources');
  }
  const ids = new Set<string>();
  const sourceCardNames: string[] = [];
  for (const srcRef of def.sources) {
    const sc = srcRef?.source as SourceCard | undefined;
    if (!sc || typeof sc.def !== 'object' || typeof sc.meta?.name !== 'string' || !sc.meta.name) {
      throw new RegistrationError(
        '每个 source 必须引用 defineSource 定义的源站卡片',
        'source:card',
      );
    }
    if (typeof srcRef?.id !== 'string' || !srcRef.id) {
      throw new RegistrationError(
        `source(${sc.meta.name}) 必须声明 id(总线 res 命名空间键)`,
        'source:id',
      );
    }
    if (ids.has(srcRef.id)) {
      throw new RegistrationError(`source id 重复: ${srcRef.id}`, 'source:id');
    }
    ids.add(srcRef.id);
    sourceCardNames.push(sc.meta.name);
    if (typeof srcRef.bind !== 'function') {
      throw new RegistrationError(`source(${srcRef.id}).bind 必须是函数`, 'source:bind');
    }
  }
  for (const mw of def.middlewares ?? []) {
    if (!mw || !VALID_SEAMS.includes(mw.seam) || typeof mw.run !== 'function') {
      throw new RegistrationError(
        `中间件非法:需声明 seam(${VALID_SEAMS.join('/')}) 与 run 函数`,
        'middleware',
      );
    }
  }

  const { injectKeys, redactKeys } = scanGlueMeta(def.glue);
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
    injectKeys: Object.freeze(injectKeys),
    redactKeys: Object.freeze(redactKeys),
    sourceCardNames: Object.freeze(sourceCardNames),
  }) as unknown as RelayCard<RawCardDef<TIn, TOut, TGlue>>;
}

function assertZod(schema: unknown, where: string): void {
  const s = schema as { safeParse?: unknown } | null | undefined;
  if (!s || typeof s.safeParse !== 'function') {
    throw new RegistrationError(`${where} 必须是 Zod schema`, `card:${where}`);
  }
}

/** 收集某接缝的卡片中间件(保持声明顺序) */
export function seamMiddlewares(def: RawCardDef<any, any, any>, seam: Seam): RelayMiddleware[] {
  return (def.middlewares ?? []).filter((m: RelayMiddleware) => m.seam === seam);
}
