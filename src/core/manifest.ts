import { z } from 'zod';

/**
 * manifest:框架级卡片契约(配置文件,部署唯一事实)。
 * schema 是类型唯一事实;两者在注册期交叉校验防漂移。
 */
export const ManifestSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/, '卡片名只允许小写字母、数字与 . _ -'),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/, '版本需为 semver 形态'),
  entry: z.string().min(1),
  requires: z
    .object({
      sources: z.array(z.string()).default([]),
      injections: z.array(z.string()).default([]),
    })
    .default({ sources: [], injections: [] }),
  suggests: z
    .object({
      timeoutMs: z.number().int().positive().optional(),
      retry: z
        .object({
          max: z.number().int().min(0).default(0),
          backoff: z.enum(['fixed', 'expo']).default('expo'),
        })
        .optional(),
      strategy: z.enum(['firstSuccess', 'race', 'all']).optional(),
    })
    .optional(),
});

export type Manifest = z.output<typeof ManifestSchema>;
export type ManifestInput = z.input<typeof ManifestSchema>;

export function parseManifest(input: unknown): Manifest {
  return ManifestSchema.parse(input);
}

/** 从文件系统读取 manifest(Node 专用;跨运行时场景直接传对象) */
export async function readManifest(manifestPath: string): Promise<{ manifest: Manifest; dir: string }> {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const abs = path.resolve(manifestPath);
  const raw = JSON.parse(await fs.readFile(abs, 'utf8')) as unknown;
  return { manifest: parseManifest(raw), dir: path.dirname(abs) };
}
