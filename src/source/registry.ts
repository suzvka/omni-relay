import { RegistrationError } from '../core/errors';
import type { SourceBinding } from '../core/types';

/** 源站注册表:逻辑 ref → 物理绑定(地址/认证/超时),由控制面专用接口注入 */
export class SourceRegistry {
  readonly #map = new Map<string, SourceBinding>();

  register(ref: string, binding: SourceBinding): this {
    if (!ref) throw new RegistrationError('源站 ref 不能为空', 'source:ref');
    if (!binding || typeof binding.baseURL !== 'string' || !/^https?:\/\//.test(binding.baseURL)) {
      throw new RegistrationError(`源站 ${ref} 的 baseURL 必须是 http(s) URL`, 'source:baseURL');
    }
    this.#map.set(ref, binding);
    return this;
  }

  resolve(ref: string): SourceBinding | undefined {
    return this.#map.get(ref);
  }

  has(ref: string): boolean {
    return this.#map.has(ref);
  }

  list(): ReadonlyMap<string, SourceBinding> {
    return this.#map;
  }
}
