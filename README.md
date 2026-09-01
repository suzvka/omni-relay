# omni-relay

将任意**源站 API**(对方控制契约)包装并绑定到**商品 API**(我方控制契约)的 npm 库。
一等公民有两种:**源站卡片**(对接侧插件,声明"能连接哪个源站、提供哪些原子字段")与**商品卡片**(业务侧,引用源站卡片并计算派生出参);中介**总线**是框架按字段审计/注入/屏蔽的介入面;框架分为**服务面**(执行数据管道)与**控制面**(卡片生命周期,二次开发者责任域)。

```txt
┌─ 控制面(二次开发者)───────────────────────────────────────────┐
│  registerSource(ref → 物理绑定)                                  │
│  registerSourceCard(源站卡片) ──校验链──→ 源站注册表(中心化)      │
│  registerCard(商品卡片)       ──校验链──→ 服务目录                │
│  setRuntimeConfig / setPolicy                                    │
└──────────────┬─────────────────────────────────────────────────┘
               │ 注册产物(版本化,原子切换)
┌─ 服务面 ─────▼─────────────────────────────────────────────────┐
│ relay.handle → [in → toGlue → glue → 钩子req                    │
│                 → per-source: bind → input校验 → take → request校验│
│                   → transport → upstreamRes校验 → put → output校验│
│                   → 钩子res → res.<id>]                         │
│                 → fromGlue → out]                               │
│              共享总线:req / res.<srcId> / out / err              │
└────────────────────────────────────────────────────────────────┘
```

## 安装

```bash
npm i omni-relay zod   # zod ^4 为 peer dependency
```

要求 Node ≥ 18(标准 fetch,天然兼容 Edge/Bun/Workers)。

## 快速开始

### 1. 定义源站卡片(对接侧插件)

对接者声明"需要什么入参、能提供哪些原子字段",不知道谁消费:

```ts
// examples/sku-detail/index.ts
import { z } from 'zod';
import { defineSource } from 'omni-relay';

export const jdItemDetail = defineSource({
  meta: { name: 'jd.item-detail', version: '1.0.0' },
  ref: 'jd/items/detail',                 // 物理绑定引用(控制面注入)

  input:  z.object({ skuId: z.string() }), // 入参契约(可含分支字段)
  output: z.object({                       // 原子字段契约(对接者承诺)
    title: z.string(), priceCents: z.number(), inStock: z.boolean(),
  }),
  upstreamRes: z.object({ item_name: z.string(), price: z.number(), stock: z.number() }),

  take: ({ skuId }) => ({ method: 'GET', path: '/v2/items/:skuId', params: { skuId } }),
  put:  (raw) => ({ title: raw.item_name, priceCents: Math.round(raw.price * 100), inStock: raw.stock > 0 }),
  errorMap: {
    extract: (b) => b?.error?.code,
    map: { ITEM_NOT_FOUND: 'PRODUCT_NOT_FOUND', 'HTTP:404': 'PRODUCT_NOT_FOUND' },
    fallback: 'UPSTREAM_UNKNOWN',
  },
});
```

### 2. 定义商品卡片(引用源站卡片,计算派生)

```ts
import { defineCard, inject, redact } from 'omni-relay';

const skuDetail = defineCard({
  meta: { name: 'product.detail', version: '1.0.0' },

  in:  z.object({ sku: z.string(), count: z.number().int().positive().default(1) }),
  out: z.object({ name: z.string(), cents: z.number(), available: z.boolean() }),

  // 总线 req 区 schema(显式声明,框架按字段操作的事实来源)
  glue: z.object({
    skuId: z.string(),
    quantity: z.number(),
    tenantId: inject(z.string()),    // extension:控制面注册期注入
    internalTag: redact(z.string()), // core:审计摘要自动脱敏
  }),

  // 入参 → 总线(只写 core 字段;inject 字段由框架合成,类型上被排除)
  toGlue: ({ sku, count }) => ({ skuId: sku, quantity: count ?? 1, internalTag: `tag:${sku}` }),

  // 源站卡片引用:bind 把总线数据映射为源站入参
  sources: [{ source: jdItemDetail, id: 'jd', bind: (g) => ({ skuId: g.skuId }) }],

  // 总线 → 出参(读取源站原子字段,计算派生;多源站聚合时在此显式合并)
  fromGlue: (_g, res) => ({ name: res.jd.title, cents: res.jd.priceCents, available: res.jd.inStock }),
});

export default skuDetail;
```

`bind` 的返回值由源站卡片 `input` 推导,`fromGlue` 的 `res.<id>` 由源站卡片 `output` 推导——"对不上"在编译期就报错。

### 3. manifest(强制配置文件)

```jsonc
// examples/sku-detail/card.json
{
  "name": "product.detail",
  "version": "1.0.0",
  "entry": "./index.js",
  // 商品卡片 requires.sources = 引用的源站卡片名(源站卡片的则是物理 ref)
  "requires": { "sources": ["jd.item-detail"], "injections": ["tenantId"] },
  "suggests": { "timeoutMs": 3000, "retry": { "max": 2, "backoff": "expo" }, "strategy": "firstSuccess" }
}
```

manifest 只放 schema 表达不了的四类信息(identity / entry / requires / suggests)。schema 是类型唯一事实,manifest 是部署唯一事实,注册期交叉校验防漂移。

### 4. 控制面组装

```ts
import { RelayController } from 'omni-relay';

const controller = new RelayController({
  // 框架特权钩子:审计/注入/屏蔽的执行点(卡片不可覆盖)
  hooks: {
    onBusReq: (ctx) => { /* ctx.bus.req 已就绪:可审计/屏蔽 */ },
    onBusRes: (ctx) => { /* ctx.bus.res 已就绪 */ },
  },
});

// 物理绑定(环境配置)
controller.registerSource('jd/items/detail', {
  baseURL: 'https://jd.example.com',
  auth: () => secrets.jd,     // 惰性取用,永不进总线
  timeoutMs: 5000,
});
// 源站卡片向中心化注册表注册自己(商品卡片引用的前置条件)
controller.registerSourceCard(jdItemDetail);
controller.registerCard(skuDetail /* , manifest 对象可选 */);
controller.setRuntimeConfig('product.detail', { tenantId: 'T-01' }); // 注册期静态注入
controller.setPolicy('product.detail', { timeoutMs: 2000 });         // 覆盖 suggests
```

### 5. 服务面调用

```ts
const relay = controller.buildRelay(); // 上线门:inject 可满足才放行

// 程序化(商品 API 主形态)
const out = await relay.handle('product.detail', { sku: 'A1' });

// 或暴露为框架无关 fetch handler(网关/直通)
export default relay.toFetchHandler({
  route: (req) => new URL(req.url).pathname.split('/')[1],
});
```

## 核心机制

### 七个校验点(默认全开,`handle` 的 `strict: false` 可降级)

| 位置 | 错误码 | 状态 |
|------|--------|------|
| 商品入参 | `GLUE.SCHEMA.IN` | 400 |
| toGlue 产物 vs `glue` | `GLUE.SCHEMA.GLUE` | 502 |
| bind 产物 vs 源站卡片 `input` | `GLUE.SCHEMA.INPUT` | 502 |
| take 产物 vs 源站卡片 `request`(可选,子集校验不重建) | `GLUE.SCHEMA.REQUEST` | 502 |
| 源站原始响应 vs 源站卡片 `upstreamRes` | `GLUE.SCHEMA.UPSTREAM_RES` | 502 |
| put 产物 vs 源站卡片 `output` | `GLUE.SCHEMA.OUTPUT` | 502 |
| fromGlue 产物 vs `out` | `GLUE.SCHEMA.OUT` | 502 |

### 错误模型(三层,raw 永不透出)

```
UpstreamError(原始) → GlueError(规范化: code / retryable / status / seam / sourceId) → 商品侧
```

- 传输层:`GLUE.TRANSPORT.TIMEOUT`(504)/ `NETWORK`(502)/ `CANCELLED`(499);
- 业务层:经 `errorMap` 翻译为 `GLUE.BUSINESS.<映射码>`(2xx 响应携带错误码同样命中);
- **`retryable` 是重试与多源站切换的唯一信号**;`raw` 只进日志,不进响应。

### 字段两分区与权限模型

| 分区 | 声明 | 类型 | 框架可做 |
|------|------|------|----------|
| core | 卡片转换函数保证 | 必选 | 审计、redact 脱敏;**不可 deny** |
| extension(`inject()`) | 控制面运行时配置(注册期校验可满足) | 必选(源站卡片与 take 可信任存在) | 审计、注入、deny |

审计/屏蔽/注入是框架主权(卡片不可覆盖);超时/重试/策略是卡片建议(框架可覆盖)。
源站卡片不支持注入字段(运行时差异由业务卡片 `glue` 经 `bind` 传入)。

### 多源站策略

```ts
controller.setPolicy('product.detail', { strategy: 'firstSuccess' });
```

- `firstSuccess`(默认):顺序执行,仅 `retryable` 错误切换下一个源站,业务性失败直接抛出;
- `race`:并发,首个成功者胜出;
- `all`:全部执行,`fromGlue` 显式聚合各 `res.<id>` 命名空间。

多卡片可引用同一张源站卡片,各自独立执行、`res.<id>` 写隔离互不污染。

### 流式透传(声明制)

源站返回 `text/event-stream` 时,响应体以 `ReadableStream<Uint8Array>` 直通,不整包缓冲:

```ts
const llmStream = defineSource({
  meta: { name: 'openai.chat', version: '1.0.0' },
  ref: 'openai/chat',
  stream: true,                                        // 声明:响应旁路校验,put 可省略
  input: z.object({ prompt: z.string() }),
  upstreamRes: z.custom<ReadableStream<Uint8Array>>(), // 仅类型留档
  output: z.custom<ReadableStream<Uint8Array>>(),
  take: ({ prompt }) => ({ method: 'POST', path: '/v1/chat/completions',
                           body: { prompt, stream: true } }),
});

const llmChat = defineCard({
  meta: { name: 'llm.chat', version: '1.0.0' },
  in:  z.object({ prompt: z.string() }),
  out: z.custom<ReadableStream<Uint8Array>>(),          // 出参 = 流
  glue: z.object({ prompt: z.string() }),
  toGlue: ({ prompt }) => ({ prompt }),
  sources: [{ source: llmStream, id: 'up', bind: (g) => ({ prompt: g.prompt }) }],
  fromGlue: (_g, res) => res.up,                        // out = 流,直通给商品侧
});
```

- **声明制旁路**:校验链对流不可执行(物理约束),以 `stream: true` 显式授予;未声明的源站收到流式响应 → `GLUE.BUSINESS.UPSTREAM_STREAM_UNDECLARED`,拒绝静默降级;
- **错误边界**:流建立前的错误(HTTP 状态 / 传输层 / errorMap)完全走现有 GlueError 规范化;流建立后的中断(响应头已发出)无法再收敛为错误响应,由宿主按流中断处理;
- **超时语义**:`timeoutMs` 只覆盖到流建立,不掐长流;外部 `signal`(客户端断开)传播终止上游流;管线失败路径会 cancel 已建立未消费的流(防连接悬挂);
- **策略边界**:多源站切换建议 `firstSuccess`(切换发生在流建立前);`race`/`all` 与流式组合存在败者流悬挂,不建议使用;
- **直通形态**:`relay.toFetchHandler` 对流式出参返回 SSE Response(`text/event-stream` / `no-cache` / `keep-alive`);程序化 `handle` 场景由宿主自行组装 Response。

### 测试投影

```ts
import { mockSource } from 'omni-relay/testing';

const src = mockSource('jd/items/detail', (_req, i) =>
  i < 2 ? { status: 500, body: { error: { code: 'RATE_LIMITED' } } } : { body: GOOD });
controller.registerSource(src.ref, src.binding);
controller.registerSourceCard(jdItemDetail);
// src.mock.calls 记录每次请求;序列回放/函数回放均可;流式回放:{ sse: 'data: ...\n\n' }
```

卡片是代码里最小完备单元——mock 源站 + fixture 即可全链路测试,无需起任何服务。

## 设计决策记录

1. 双层卡片:源站卡片(对接者定义能力契约 `input`/`output`,向中心化注册表注册)与商品卡片(业务者引用 + `bind` 参数映射 + `fromGlue` 计算派生);
2. 商品卡片 5 件套 + 强制 manifest(框架级契约);
3. 总线三分区 `req` / `res.<srcId>` / `out`(错误挂 `err`),写隔离由内核强制;
4. 请求/响应对称(`toGlue`↔`fromGlue`、`bind`+`take`↔`put`),框架钩子成对出现,操作权对等;
5. 注入 = 注册期静态(请求期动态数据一律由 toGlue 写入);
6. 物理绑定 `ref` + 控制面专用接口注入,源站卡片可移植、密钥不进代码;
7. 服务目录与源站注册表均版本化 + 原子切换(in-flight 请求由旧版本跑完);
8. 控制面全部操作进入审计日志(不记录认证材料);
9. 中间件按接缝声明(`toGlue` / `bind` / `take` / `put` / `fromGlue`),洋葱模型,next 后产物就绪;
10. 流式透传是声明制的校验旁路:`stream: true` 显式授予,未声明收到流式响应直接拒绝;流建立前错误全程 GlueError 规范化。
11. 回滚语义:框架只留 current,不留存版本史(历史是卡片开发者/宿主制品层的责任);注册链以版本比较做门禁——同名同版本拒绝,低于 current 默认拒绝(防误发旧版),显式回滚意图(`opts.rollback`)方可重发旧版制品,原子替换无下线窗口;`deregisterCard`/`deregisterSourceCard` = 退役(移除 current 退出服务目录,退役后重注册同版本不受限)。契约类变更只切换控制面状态:业务卡片内嵌源站卡片对象,服务面须下游重新注册方生效——控制面只治理,不代跑部署;绑定类变更(`registerSource` 覆盖)则活生效。

## Roadmap(第一版未含)

- cache / breaker / otel 内置中间件(接缝机制即预留点);
- 分页归一、流式归一(chunk 级 schema 校验/转换;当前流式为整流透传);
- 卡片编排、源站 webhook 反向绑定。

## 开发

```bash
npm test            # vitest 全量
npm run test:coverage
npm run typecheck
npm run build       # tsdown → esm + cjs + dts
```

MIT
