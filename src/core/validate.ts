import type * as z from 'zod';
import { GlueError } from './errors';
import type { CheckSeam } from './errors';

/**
 * 校验点执行器:Zod 失败 → 规范化 GlueError。
 * strict=false 时由管道整体跳过校验(数据不经过清洗)。
 */
export function checkAt(
  seam: CheckSeam,
  schema: z.ZodType,
  data: unknown,
  sourceId?: string,
): unknown {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw GlueError.schema(seam, formatIssues(result.error.issues), sourceId);
  }
  return result.data;
}

export function formatIssues(issues: readonly { path: PropertyKey[]; message: string }[]): string {
  if (issues.length === 0) return '(无 issue)';
  return issues
    .map((i) => `${i.path.length ? i.path.map(String).join('.') : '(root)'}: ${i.message}`)
    .join('; ');
}
