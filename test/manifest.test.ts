import { describe, expect, it } from 'vitest';
import { ManifestSchema, parseManifest } from '../src/index';

describe('manifest', () => {
  it('解析合法 manifest 并填充默认值', () => {
    const m = parseManifest({
      name: 'product.detail',
      version: '1.0.0',
      entry: './index.js',
      requires: { sources: ['jd/items/detail'], injections: ['tenantId'] },
    });
    expect(m.requires).toEqual({ sources: ['jd/items/detail'], injections: ['tenantId'] });
    expect(m.suggests).toBeUndefined();
  });

  it('拒绝非法卡片名', () => {
    expect(() =>
      parseManifest({ name: 'Bad Name', version: '1.0.0', entry: 'x.js' }),
    ).toThrow();
  });

  it('拒绝非 semver 版本', () => {
    expect(() =>
      parseManifest({ name: 'a', version: 'latest', entry: 'x.js' }),
    ).toThrow();
  });

  it('retry.max 必须 >= 0', () => {
    expect(
      ManifestSchema.safeParse({
        name: 'a',
        version: '1.0.0',
        entry: 'x.js',
        suggests: { retry: { max: -1, backoff: 'expo' } },
      }).success,
    ).toBe(false);
  });
});
