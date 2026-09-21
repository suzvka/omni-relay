import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineCard } from '../src/index';
import {
  renderEndpoint,
  renderEndpoints,
  renderFieldTable,
  renderJsonExample,
  schemaToFields,
  cardDocOf,
  hasCardDoc,
  endpointDocWithCard,
  renderCardDoc,
} from '../src/docgen';

describe('schemaToFields', () => {
  it('展平必填/可选并读取 describe 与 meta 示例', () => {
    const schema = z.object({
      sku: z.string().describe('档位 skuId').meta({ examples: ['A1'] }),
      count: z.number().int().optional().describe('数量'),
    });
    const fields = schemaToFields(schema, { io: 'input' });
    expect(fields).toEqual([
      { path: 'sku', name: 'sku', type: 'string', required: true, description: '档位 skuId', example: 'A1', depth: 0 },
      { path: 'count', name: 'count', type: 'integer', required: false, description: '数量', depth: 0 },
    ]);
  });

  it('容器与嵌套对象/对象数组按路径展开,枚举并入类型标签', () => {
    const schema = z.object({
      order: z.object({
        no: z.string().describe('订单号'),
        status: z.enum(['PENDING', 'PAID']).describe('状态'),
      }).describe('订单'),
      items: z.array(z.object({ sku: z.string().describe('子 sku') })).describe('明细'),
    });
    const rows = schemaToFields(schema).map((f) => `${f.path}:${f.type}@${f.depth}`);
    expect(rows).toEqual([
      'order:object@0',
      'order.no:string@1',
      'order.status:PENDING / PAID@1',
      'items:object[]@0',
      'items[].sku:string@1',
    ]);
  });

  it('未知/自定义类型退化为 any,nullable 归一为 any / null', () => {
    const schema = z.object({ u: z.unknown().nullable(), c: z.custom() });
    const fields = schemaToFields(schema);
    expect(fields.find((f) => f.name === 'u')?.type).toBe('any / null');
    expect(fields.find((f) => f.name === 'c')?.type).toBe('any');
  });
});

describe('renderFieldTable', () => {
  it('输出四列表格,可选空说明列留空', () => {
    const fields = schemaToFields(
      z.object({ a: z.string().describe('甲'), b: z.number().optional() }),
      { io: 'input' },
    );
    expect(renderFieldTable(fields).split('\n')).toEqual([
      '| 字段 | 类型 | 必填 | 说明 |',
      '|---|---|---|---|',
      '| `a` | string | ✅ | 甲 |',
      '| `b` | number | — |  |',
    ]);
  });

  it('空字段列表返回空串', () => {
    expect(renderFieldTable([])).toBe('');
  });
});

describe('renderJsonExample', () => {
  it('命中的敏感叶子值打码', () => {
    const md = renderJsonExample(
      { name: 'x', oldPassword: 'secret', nest: { newPassword: 'p2' } },
      { hideFields: ['oldPassword', 'newPassword'] },
    );
    expect(md).toContain('"oldPassword": "***"');
    expect(md).toContain('"newPassword": "***"');
    expect(md).toContain('"name": "x"');
  });
});

describe('renderEndpoint', () => {
  const card = defineCard({
    meta: { name: 'demo.echo', version: '1.0.0' },
    in: z.object({ sku: z.string().describe('档位 skuId').meta({ examples: ['A1'] }) }),
    out: z.object({ order_no: z.string().describe('订单号') }),
    collect: () => {},
    respond: (ctx) => ({ order_no: 'X' }) as never,
  });

  it('最小端点:标题 + 请求表 + 响应标题', () => {
    const md = renderEndpoint({
      title: 'T',
      method: 'POST',
      path: '/p',
      request: z.object({ name: z.string().describe('名字') }),
    });
    expect(md).toBe(
      [
        '## T',
        '',
        '### 请求',
        '| 请求方式 | 端点 |',
        '|---|---|',
        '| POST | /p |',
        '',
        '| 字段 | 类型 | 必填 | 说明 |',
        '|---|---|---|---|',
        '| `name` | string | ✅ | 名字 |',
        '',
        '### 响应',
      ].join('\n'),
    );
  });

  it('传 card 自动反射 in/out,auth 列与备注、错误表按序出现', () => {
    const md = renderEndpoint({
      method: 'POST',
      path: '/api/demo/echo',
      auth: 'session',
      card,
      description: '回显档位。',
      responseExample: { order_no: 'A1' },
      notes: ['鉴权：需登录。'],
      errors: [{ status: 400, scenario: '参数无效' }],
    });
    // 卡片名兜底为标题
    expect(md.startsWith('## demo.echo\n')).toBe(true);
    expect(md).toContain('| 请求方式 | 端点 | 鉴权 |');
    expect(md).toContain('| POST | /api/demo/echo | session |');
    expect(md).toContain('回显档位。');
    expect(md).toContain('| `sku` | string | ✅ | 档位 skuId 示例：`"A1"` |');
    expect(md).toContain('| `order_no` | string | ✅ | 订单号 |');
    expect(md).toContain('```json\n{\n  "order_no": "A1"\n}\n```');
    expect(md).toContain('> 鉴权：需登录。');
    expect(md).toContain('### 错误速查');
    expect(md).toContain('| 400 | 参数无效 |');
  });

  it('renderEndpoints 以空行拼接多段', () => {
    const one = { title: 'A', method: 'GET', path: '/a' };
    const two = { title: 'B', method: 'GET', path: '/b' };
    const md = renderEndpoints([one, two]);
    expect(md).toContain('## A');
    expect(md).toContain('\n\n## B');
  });
});

describe('CardDoc 散文驱动（端点事实来自宿主）', () => {
  const card = defineCard({
    meta: { name: 'demo.echo', version: '1.0.0' },
    in: z.object({ q: z.string().describe('查询词').meta({ examples: ['hi'] }) }),
    out: z.object({ ok: z.boolean().describe('是否成功') }),
    doc: {
      signature: '把查询词原样回显。',
      requestNotes: 'q 不可为空。',
      responseNotes: '恒返回 200。',
    },
    collect: () => {},
    respond: () => ({}) as never,
  });

  it('cardDocOf / hasCardDoc（散文 doc）', () => {
    expect(hasCardDoc(card)).toBe(true);
    expect(cardDocOf(card)?.signature).toBe('把查询词原样回显。');
    const bare = defineCard({
      meta: { name: 'demo.bare', version: '1.0.0' },
      in: z.object({}),
      out: z.object({}),
      collect: () => {},
      respond: () => ({}) as never,
    });
    expect(hasCardDoc(bare)).toBe(false);
  });

  it('endpointDocWithCard 合并端点事实 + 卡片散文 + 契约', () => {
    const ep = endpointDocWithCard(card, {
      method: 'GET',
      path: '/api/demo/echo',
      title: '回显',
      auth: 'public',
    });
    expect(ep).toMatchObject({
      method: 'GET',
      path: '/api/demo/echo',
      title: '回显',
      auth: 'public',
      signature: '把查询词原样回显。',
    });
    expect(ep.card).toBe(card);
  });

  it('renderCardDoc 含签名/参数释义/返回值释义段落', () => {
    const md = renderCardDoc(card, {
      method: 'GET',
      path: '/api/demo/echo',
      title: '回显',
      auth: 'public',
    });
    expect(md.startsWith('## 回显\n')).toBe(true);
    expect(md).toContain('把查询词原样回显。');
    expect(md).toContain('| GET | /api/demo/echo | public |');
    expect(md).toContain('q 不可为空。');
    expect(md).toContain('恒返回 200。');
    expect(md).toContain('| `q` | string | ✅ | 查询词 示例：`"hi"` |');
  });

  it('未填的可选段落不出现；标题缺省取卡片名', () => {
    const min = defineCard({
      meta: { name: 'demo.min', version: '1.0.0' },
      in: z.object({}),
      out: z.object({}),
      collect: () => {},
      respond: () => ({}) as never,
    });
    const md = renderCardDoc(min, { method: 'POST', path: '/api/demo/min' });
    expect(md.startsWith('## demo.min\n')).toBe(true);
    expect(md).toContain('| POST | /api/demo/min |');
    expect(md).not.toContain('鉴权');
    expect(md).not.toContain('**成功响应');
  });
});
