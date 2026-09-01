import { z } from 'zod';
import type { Injected, Redacted } from './types';

/** omni-relay 字段标记注册表(独立于 zod 全局 meta,避免污染) */
export const relayMeta = z.core.registry<{
  'x-omni-inject'?: boolean;
  'x-omni-redact'?: boolean;
}>();

/**
 * 声明一个 extension 字段:值由控制面运行时配置在注册期注入,
 * toGlue 不负责此字段(类型上被排除),take/fromGlue 可信任其存在。
 */
export function inject<T extends z.ZodType>(schema: T): Injected<T> {
  relayMeta.add(schema, { ...relayMeta.get(schema), 'x-omni-inject': true });
  return schema as Injected<T>;
}

/** 标记一个 core 字段在总线摘要/审计中脱敏 */
export function redact<T extends z.ZodType>(schema: T): Redacted<T> {
  relayMeta.add(schema, { ...relayMeta.get(schema), 'x-omni-redact': true });
  return schema as Redacted<T>;
}

export interface GlueFieldMeta {
  injectKeys: string[];
  redactKeys: string[];
}

/** 扫描 glue object 一级字段的标记(框架按字段操作的数据来源) */
export function scanGlueMeta(glue: z.ZodObject<any>): GlueFieldMeta {
  const injectKeys: string[] = [];
  const redactKeys: string[] = [];
  for (const [key, field] of Object.entries(glue.shape)) {
    const meta = relayMeta.get(field as z.ZodType);
    if (meta?.['x-omni-inject']) injectKeys.push(key);
    if (meta?.['x-omni-redact']) redactKeys.push(key);
  }
  return { injectKeys, redactKeys };
}
