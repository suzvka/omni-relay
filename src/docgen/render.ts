import type * as z from 'zod';
import type { RelayCard } from '../core/types';
import { schemaToFields } from './fields';
import type {
  CardDoc,
  EndpointDoc,
  EndpointFacts,
  FieldDoc,
  FieldTableOptions,
  RenderOptions,
} from './types';

/** 从卡片产物鸭子类型取请求/响应 schema:业务卡 in/out,源站卡 input/output */
function cardSchema(card: unknown, kind: 'request' | 'response'): z.ZodType | undefined {
  const def = (card as { def?: Record<string, unknown> } | undefined)?.def;
  if (!def) return undefined;
  const pick = kind === 'request' ? (def.in ?? def.input) : (def.out ?? def.output);
  return pick && typeof (pick as { safeParse?: unknown }).safeParse === 'function'
    ? (pick as z.ZodType)
    : undefined;
}

/** 转义表格单元格里的竖线与换行,避免破坏 Markdown 表格 */
function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/** 内联示例的紧凑序列化 */
function inline(value: unknown): string {
  if (typeof value === 'string') return `"${value}"`;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * 字段行列表 → Markdown 表格。空列表返回空串。
 * 列:字段 | 类型 | 必填 | 说明(示例默认内联进说明列)。
 */
export function renderFieldTable(
  fields: FieldDoc[],
  opts: FieldTableOptions & { hideFields?: string[] } = {},
): string {
  if (fields.length === 0) return '';
  const h = opts.headers ?? {};
  const colField = h.field ?? '字段';
  const colType = h.type ?? '类型';
  const colReq = h.required ?? '必填';
  const colDesc = h.description ?? '说明';
  const reqMark = opts.requiredMark ?? '✅';
  const optMark = opts.optionalMark ?? '—';
  const showExamples = opts.showExamples ?? true;
  const hidden = new Set(opts.hideFields ?? []);

  const lines: string[] = [
    `| ${colField} | ${colType} | ${colReq} | ${colDesc} |`,
    '|---|---|---|---|',
  ];
  for (const f of fields) {
    const isHidden = hidden.has(f.name);
    const indent = f.depth > 0 ? '&nbsp;'.repeat(f.depth * 2) : '';
    const descParts: string[] = [];
    if (isHidden) descParts.push('（敏感字段，示例中打码）');
    else if (f.description) descParts.push(f.description);
    if (showExamples && !isHidden && f.example !== undefined) {
      descParts.push(`示例：\`${cell(inline(f.example))}\``);
    }
    lines.push(
      `| ${indent}\`${cell(f.path)}\` | ${cell(f.type)} | ${f.required ? reqMark : optMark} | ${cell(descParts.join(' '))} |`,
    );
  }
  return lines.join('\n');
}

/** 递归打码:命中叶子名(在 hidden 集合内)的值替换为 `***` */
function redact(value: unknown, hidden: Set<string>): unknown {
  if (Array.isArray(value)) return value.map((v) => redact(v, hidden));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = hidden.has(k) ? '***' : redact(v, hidden);
    }
    return out;
  }
  return value;
}

/** 值 → ```json 代码块 */
export function renderJsonExample(value: unknown, opts: { hideFields?: string[] } = {}): string {
  const hidden = new Set(opts.hideFields ?? []);
  const shown = hidden.size > 0 ? redact(value, hidden) : value;
  return '```json\n' + JSON.stringify(shown, null, 2) + '\n```';
}

function heading(level: number, text: string): string {
  return '#'.repeat(level) + ' ' + text;
}

/**
 * 单个端点 → 一段 Markdown(默认 `##` 小节)。
 * 结构:标题 → 请求(方式/端点/鉴权表 + 说明 + 字段表 + 示例) → 响应(字段表 + 示例) → 备注 → 错误速查。
 * 只产字符串,不写盘、不拼页面。
 */
export function renderEndpoint(spec: EndpointDoc, opts: RenderOptions = {}): string {
  const level = opts.headingLevel ?? 2;
  const sub = level + 1;
  const successStatus = opts.successStatus ?? 200;
  const hideFields = spec.hideFields ?? [];
  const hidden = new Set(hideFields);

  const reqSchema = spec.request ?? cardSchema(spec.card, 'request');
  const resSchema = spec.response ?? cardSchema(spec.card, 'response');
  const cardName = (spec.card as { meta?: { name?: string } } | undefined)?.meta?.name;
  const title = spec.title ?? cardName ?? spec.path;

  const blocks: string[] = [];
  blocks.push(heading(level, title));

  if (spec.signature) blocks.push(spec.signature);

  // 请求:方式/端点/鉴权 表
  const withAuth = !!spec.auth;
  const reqHeader = withAuth
    ? '| 请求方式 | 端点 | 鉴权 |\n|---|---|---|'
    : '| 请求方式 | 端点 |\n|---|---|';
  const reqRow = withAuth
    ? `| ${spec.method} | ${spec.path} | ${spec.auth} |`
    : `| ${spec.method} | ${spec.path} |`;
  const requestSection: string[] = [heading(sub, '请求'), reqHeader, reqRow];

  if (spec.description) {
    requestSection.push('');
    requestSection.push(spec.description);
  }

  if (reqSchema) {
    const table = renderFieldTable(schemaToFields(reqSchema, { io: 'input' }), {
      ...(opts.fieldTable ?? {}),
      hideFields,
    });
    if (table) {
      requestSection.push('');
      requestSection.push(table);
    }
  }
  if (spec.requestExample !== undefined) {
    requestSection.push('');
    requestSection.push(renderJsonExample(spec.requestExample, { hideFields }));
  }
  if (spec.requestNotes) {
    requestSection.push('');
    requestSection.push(spec.requestNotes);
  }
  blocks.push(requestSection.join('\n'));

  // 响应
  const responseSection: string[] = [heading(sub, '响应')];
  if (resSchema) {
    const table = renderFieldTable(schemaToFields(resSchema, { io: 'output' }), {
      ...(opts.fieldTable ?? {}),
      hideFields,
    });
    if (table) {
      responseSection.push(`**成功响应 (${successStatus})：**`);
      responseSection.push('');
      responseSection.push(table);
    }
  }
  if (spec.responseExample !== undefined) {
    if (responseSection.length > 1) responseSection.push('');
    if (!resSchema) responseSection.push(`**成功响应 (${successStatus})：**`, '');
    responseSection.push(renderJsonExample(spec.responseExample, { hideFields }));
  }
  if (spec.responseNotes) {
    responseSection.push('');
    responseSection.push(spec.responseNotes);
  }
  blocks.push(responseSection.join('\n'));

  // 备注(引用块)
  if (spec.notes && spec.notes.length > 0) {
    blocks.push(spec.notes.map((n) => `> ${n}`).join('\n'));
  }

  // 错误速查
  if (spec.errors && spec.errors.length > 0) {
    const errLines = [heading(sub, '错误速查'), '| HTTP | 场景 |', '|---|---|'];
    for (const e of spec.errors) errLines.push(`| ${e.status} | ${cell(e.scenario)} |`);
    blocks.push(errLines.join('\n'));
  }

  return blocks.join('\n\n');
}

/** 多个端点顺序拼接(以空行分隔) */
export function renderEndpoints(specs: EndpointDoc[], opts: RenderOptions = {}): string {
  return specs.map((s) => renderEndpoint(s, opts)).join('\n\n');
}

// ---------------------------------------------------------------------------
// 卡片驱动:doc 是卡片上的"散文";端点事实由宿主发布面注册表提供
// ---------------------------------------------------------------------------

/** 取卡片上作者填写的散文 doc(未填返回 undefined) */
export function cardDocOf(card: unknown): CardDoc | undefined {
  const doc = (card as { def?: { doc?: unknown } } | undefined)?.def?.doc;
  return doc && typeof doc === 'object' ? (doc as CardDoc) : undefined;
}

/** 卡片是否带散文 doc */
export function hasCardDoc(card: unknown): boolean {
  return cardDocOf(card) !== undefined;
}

/**
 * 把"卡片(契约 + 散文)"与宿主给的端点事实合成 renderEndpoint 所需的 EndpointDoc。
 * 端点事实(method/path/title/auth)来自宿主的发布面注册表(如 surface),docgen 不推断;
 * 字段表由 card 的 in/out 反射;散文由 card.doc 提供。
 */
export function endpointDocWithCard(card: RelayCard, facts: EndpointFacts): EndpointDoc {
  const doc = cardDocOf(card) ?? {};
  return {
    method: facts.method,
    path: facts.path,
    title: facts.title,
    auth: facts.auth,
    card,
    signature: doc.signature,
    description: doc.description,
    requestNotes: doc.requestNotes,
    responseNotes: doc.responseNotes,
    requestExample: doc.requestExample,
    responseExample: doc.responseExample,
    errors: doc.errors,
    notes: doc.notes,
    hideFields: doc.hideFields,
  };
}

/** 渲染单张卡片(契约 + 散文 + 端点事实) → 一段 Markdown */
export function renderCardDoc(
  card: RelayCard,
  facts: EndpointFacts,
  opts: RenderOptions = {},
): string {
  return renderEndpoint(endpointDocWithCard(card, facts), opts);
}
