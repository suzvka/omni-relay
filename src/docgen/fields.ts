import * as z from 'zod';
import type { FieldDoc } from './types';

/** 宽松的 JSON Schema 节点视图(仅取本模块关心的键) */
interface JsonSchemaNode {
  $ref?: string;
  $defs?: Record<string, JsonSchemaNode>;
  type?: string | string[];
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  items?: JsonSchemaNode | JsonSchemaNode[];
  enum?: unknown[];
  const?: unknown;
  description?: string;
  examples?: unknown[];
  anyOf?: JsonSchemaNode[];
  oneOf?: JsonSchemaNode[];
  allOf?: JsonSchemaNode[];
}

export interface SchemaToFieldsOptions {
  /** 反射方向:请求体用 'input',响应体用 'output'(默认 'output') */
  io?: 'input' | 'output';
}

/**
 * 把一个 Zod schema 展平为字段行列表:容器自身也出一行(type=object / object[]),
 * 子字段以 `a.b` / `items[].sku` 路径跟进,深度递进。
 * 说明取自 `.describe()`,示例取自 `.meta({ examples })`(经 toJSONSchema 原生透出)。
 * 复用/递归 schema 的 `$ref` 按 `$defs` 解析,并以分支级 visited 集合防止无限展开。
 */
export function schemaToFields(
  schema: z.ZodType,
  opts: SchemaToFieldsOptions = {},
): FieldDoc[] {
  const root = z.toJSONSchema(schema, {
    io: opts.io ?? 'output',
    unrepresentable: 'any',
  }) as JsonSchemaNode;
  const defs = root.$defs ?? {};
  const fields: FieldDoc[] = [];
  emitObject(root, '', 0, fields, defs, new Set());
  return fields;
}

/** 展开一个 object 节点的 properties */
function emitObject(
  node: JsonSchemaNode,
  prefix: string,
  depth: number,
  fields: FieldDoc[],
  defs: Record<string, JsonSchemaNode>,
  visited: Set<string>,
): void {
  const required = new Set(node.required ?? []);
  for (const [key, raw] of Object.entries(node.properties ?? {})) {
    const path = prefix ? `${prefix}.${key}` : key;
    emitField(key, path, raw, depth, required.has(key), fields, defs, visited);
  }
}

/** 落一个字段行;若为对象/对象数组,继续展开其子字段 */
function emitField(
  name: string,
  path: string,
  raw: JsonSchemaNode,
  depth: number,
  required: boolean,
  fields: FieldDoc[],
  defs: Record<string, JsonSchemaNode>,
  visited: Set<string>,
): void {
  const { node, cyclic } = resolveRef(raw, defs, visited);

  fields.push({
    path,
    name,
    type: typeLabel(node),
    required,
    ...(node.description ? { description: node.description } : {}),
    ...(node.enum ? { enumValues: node.enum.map(String) } : {}),
    ...(node.examples && node.examples.length > 0 ? { example: node.examples[0] } : {}),
    depth,
  });

  // 递归引用命中:只保留容器行,不再展开(避免无限)
  if (cyclic) return;

  const isObject = node.type === 'object' && !!node.properties;
  if (isObject) {
    emitObject(node, path, depth + 1, fields, defs, visited);
    return;
  }

  if (node.type === 'array' && node.items && !Array.isArray(node.items)) {
    const item = resolveRef(node.items as JsonSchemaNode, defs, visited);
    if (item.node.type === 'object' && item.node.properties) {
      emitObject(item.node, `${path}[]`, depth + 1, fields, defs, item.visitedAfter ?? visited);
    }
  }
}

/** 解析 $ref 链;命中分支内已访问的 ref 视为递归,返回占位节点并置 cyclic */
function resolveRef(
  node: JsonSchemaNode,
  defs: Record<string, JsonSchemaNode>,
  visited: Set<string>,
): { node: JsonSchemaNode; cyclic: boolean; visitedAfter?: Set<string> } {
  let cur: JsonSchemaNode = node;
  let seen = visited;
  let cyclic = false;
  while (cur && typeof cur.$ref === 'string') {
    if (seen.has(cur.$ref)) {
      cyclic = true;
      cur = { type: 'object', description: '（递归引用）' };
      break;
    }
    seen = new Set(seen);
    seen.add(cur.$ref);
    const key = cur.$ref.replace(/^#\/\$defs\//, '');
    const next = defs[key];
    if (!next) {
      cur = {};
      break;
    }
    // 合并引用目标与其上的 description(引用点常带描述)
    cur = { ...next, ...(cur.description && !next.description ? { description: cur.description } : {}) };
  }
  return { node: cur ?? {}, cyclic, visitedAfter: seen };
}

/** 由 JSON Schema 节点推导紧凑类型标签(不含 `|`,避免破坏表格) */
function typeLabel(node: JsonSchemaNode): string {
  if (node.const !== undefined) return String(node.const);
  if (node.enum) return node.enum.map(String).join(' / ');
  if (node.type === 'array') {
    const it = node.items;
    if (it && !Array.isArray(it)) return `${typeLabel(it)}[]`;
    return 'array';
  }
  if (Array.isArray(node.type)) return node.type.join(' / ');
  if (node.type === 'object') return 'object';
  if (node.anyOf) return joinLabels(node.anyOf, node);
  if (node.oneOf) return joinLabels(node.oneOf, node);
  if (node.type) return node.type;
  return 'any';
}

function joinLabels(branches: JsonSchemaNode[], parent: JsonSchemaNode): string {
  // 分支里的 {type:null} 归一为 null,其余递归;去重后以 / 连接
  const labels = branches.map((b) => (b.type === 'null' ? 'null' : typeLabel(b)));
  return [...new Set(labels)].join(' / ') || (parent.type ? String(parent.type) : 'any');
}
