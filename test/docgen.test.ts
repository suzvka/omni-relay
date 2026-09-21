import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineCard } from '../src/index';
import {
  renderEndpoint,
  renderEndpoints,
  renderFieldTable,
  renderJsonExample,
  schemaToFields,
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
