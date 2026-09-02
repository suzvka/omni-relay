# omni-relay 应转尽转·业务管线编排器

> 以**商品卡片**为一等公民的 API 绑定框架：把任意源站 API 包装、绑定为对外稳定的商品 API；**中介总线**是框架按字段审计 / 注入 / 屏蔽的介入面。

![license](https://img.shields.io/badge/license-MIT-blue)
![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)
![zod](https://img.shields.io/badge/peer-zod%20%5E4-3178c6)
![module](https://img.shields.io/badge/module-ESM%20%2B%20CJS-orange)

---

## 目录

- [为什么需要它](#为什么需要它)
- [核心概念](#核心概念)
- [数据流：一次 handle 发生了什么](#数据流一次-handle-发生了什么)
- [快速开始](#快速开始)
- [指南](#指南)
  - [源站卡片（对接侧插件）](#源站卡片对接侧插件)
  - [商品卡片（业务侧）](#商品卡片业务侧)
  - [注入与脱敏](#注入与脱敏)
  - [多源站策略与重试](#多源站策略与重试)
  - [流式透传（SSE）](#流式透传sse)
  - [manifest 与版本治理](#manifest-与版本治理)
  - [框架钩子与接缝中间件](#框架钩子与接缝中间件)
  - [暴露为 fetch handler](#暴露为-fetch-handler)
  - [测试](#测试)
- [校验点与错误码](#校验点与错误码)
- [API 参考](#api-参考)
- [设计原则](#设计原则)
- [项目结构](#项目结构)
- [开发](#开发)
- [License](#license)

---

## 为什么需要它

当你需要把**多个异构上游源站**聚合成一套**对外稳定的商品 API** 时，会反复遇到同一批问题：

- 每个上游的入参、鉴权、字段命名、错误码都不一样，脏字段容易泄漏到对外契约里；
- 需要在转发链路里做**审计、脱敏、注入**，但这些治理动作不该和业务逻辑缠在一起；
- 上游会超时、限流、宕机，需要**重试与容灾切换**，且要能区分「可重试」与「业务性失败」；
- 对接侧和业务侧往往是不同的人，**对接逻辑**（怎么连一个源站）和**业务逻辑**（怎么组合成商品）需要解耦、独立演进与版本化。

omni-relay 的回答是**卡片化 + 总线介入 + 双平面分离**：

- 每个能力都是一张可独立声明、注册、版本化、退役的**卡片**；
- 转发链路收敛为一条**中介总线**，框架主权（审计/注入/屏蔽）住在总线上；
- **控制面**负责治理（注册/绑定/注入/策略/审计），**服务面**负责执行（`handle` / `fetch`），两者分离，原子切换不断服。

---

## 核心概念

| 概念 | 说明 | 定义方式 |
| --- | --- | --- |
| **源站卡片** | 对接侧插件：封装「连接一个源站 + 清洗为原子字段」。声明能力契约（需要什么入参、能提供哪些原子字段），**不知道谁消费**。 | `defineSource()` |
| **商品卡片** | 业务侧：对外稳定的商品 API 契约。经 `sources` **引用**源站卡片，只做参数映射与计算派生，**不接触源站细节**。 | `defineCard()` |
| **中介总线（Bus）** | 贯穿一次执行的三分区数据结构：`req`（商品入参）/ `res.<id>`（各源站命名空间）/ `out`（商品出参），外加 `err`。框架按字段审计/注入/屏蔽的介入面。 | 框架内部构造 |
| **字段标记** | `inject()` 声明 extension 字段（注册期由控制面注入）；`redact()` 声明 core 字段在审计摘要中脱敏。 | `inject` / `redact` |
| **管道接缝（Seam）** | `toGlue` / `bind` / `take` / `put` / `fromGlue` 五个接缝，中间件声明作用于哪个接缝。 | `middlewares` |
| **控制面** | 卡片生命周期、源站绑定、配置注入、策略覆盖、审计、版本门禁。 | `RelayController` |
| **服务面** | 程序化调用 `handle`，或暴露为框架无关的 `fetch` handler。 | `Relay` |

**双层卡片**是理解 omni-relay 的关键：源站卡片是「标准化的对接模块」，商品卡片是「顶层业务」；对接者向中心化注册表注册自己的能力，业务卡片按名引用，两侧解耦、各自演进。

---

## 数据流：一次 handle 发生了什么

```
商品入参
  │  ▸ 校验点 in
  ▼
toGlue  →  合成 inject 字段  →  ▸ 校验点 glue  →  bus.req
  │        [钩子 onBusReq、toGlue 中间件：审计 / 注入 / 屏蔽]
  ▼
per-source 段（策略：firstSuccess / race / all / scripted）
  bind → ▸input → take → ▸request → transport（超时 / 重试 / 业务错误映射）
       → ▸upstreamRes → put → ▸output → bus.res.<id>
  │        [钩子 onBusRes、bind / take / put 中间件]
  ▼
fromGlue（聚合 res 各命名空间）  →  ▸out  →  bus.out  →  商品出参
```

- **总线贯穿全程**：任何一跳失败都收敛为 `GlueError`，挂到 `bus.err` 后抛出；
- **校验点默认全开**：`handle(name, input, { strict: false })` 可整体跳过（脏数据直通）；
- **框架钩子置于接缝最外层**：`next()` 后可审计/屏蔽产物，卡片中间件无法覆盖框架主权。

---

## 快速开始

### 安装

```bash
pnpm add omni-relay zod      # zod 是 peer 依赖（^4.0.0），需一并安装
# 或 npm i omni-relay zod
```

要求 Node >= 18。产物同时提供 ESM / CJS / 类型声明。

### 最小示例

```ts
import { z } from 'zod';
import { defineCard, defineSource, inject, redact, RelayController } from 'omni-relay';

// 1) 源站卡片：封装「连接一个源站 + 清洗为原子字段」（对接侧插件）
const jdItemDetail = defineSource({
  meta: { name: 'jd.item-detail', version: '1.0.0' },
  ref: 'jd/items/detail',                    // 逻辑 ref，控制面据此绑定物理地址

  input: z.object({ skuId: z.string() }),    // 我需要什么入参
  output: z.object({                         // 我能提供哪些原子字段
    title: z.string(),
    priceCents: z.number(),
    inStock: z.boolean(),
  }),
  upstreamRes: z.object({                    // 源站原始响应契约（照抄对方文档）
    item_name: z.string(),
    price: z.number(),
    stock: z.number(),
  }),

  take: ({ skuId }) => ({                    // 源站入参 → 源站请求（path 支持 :param）
    method: 'GET' as const,
    path: '/v2/items/:skuId',
    params: { skuId },
    query: { fmt: 'json' },
  }),
  put: (raw) => ({                           // 源站响应 → 原子字段（脏字段挡在总线之外）
    title: raw.item_name,
    priceCents: Math.round(raw.price * 100),
    inStock: raw.stock > 0,
  }),
  errorMap: {                                // 源站业务错误 → 规范化码
    extract: (body) => (body as any)?.error?.code,
    map: { ITEM_NOT_FOUND: 'PRODUCT_NOT_FOUND', 'HTTP:404': 'PRODUCT_NOT_FOUND' },
    fallback: 'UPSTREAM_UNKNOWN',
  },
});

// 2) 商品卡片：对外稳定的商品 API（业务侧，只做映射与派生）
const skuDetail = defineCard({
  meta: { name: 'product.detail', version: '1.0.0' },

  in: z.object({ sku: z.string(), count: z.number().int().positive().default(1) }),
  out: z.object({ name: z.string(), cents: z.number(), available: z.boolean() }),

  glue: z.object({                           // 总线 req 区：框架按字段审计 / 注入 / 屏蔽
    skuId: z.string(),
    quantity: z.number(),
    tenantId: inject(z.string()),            // extension：注册期由运行时配置注入
    internalTag: redact(z.string()),         // core：审计摘要自动脱敏
  }),

  toGlue: ({ sku, count }) => ({ skuId: sku, quantity: count ?? 1, internalTag: `tag:${sku}` }),
  sources: [{ source: jdItemDetail, id: 'jd', bind: (g) => ({ skuId: g.skuId }) }],
  fromGlue: (_g, res) => ({
    name: res.jd.title,
    cents: res.jd.priceCents,
    available: res.jd.inStock,
  }),
});

// 3) 控制面：绑定物理源站 → 注册卡片 → 注入配置 → 上线
const controller = new RelayController();
controller
  .registerSource('jd/items/detail', {
    baseURL: 'https://api.jd.example.com',
    auth: () => process.env.JD_TOKEN!,       // 惰性取用，值不进总线、不进日志摘要
  })
  .registerSourceCard(jdItemDetail)
  .registerCard(skuDetail)
  .setRuntimeConfig('product.detail', { tenantId: 'T-01' });

const relay = controller.buildRelay();       // 上线门：注入字段齐备才产出 Relay

// 4) 服务面：程序化调用（成功返回 out，失败抛 GlueError）
const out = await relay.handle('product.detail', { sku: 'A1' });
// → { name: 'X', cents: 990, available: true }
```

> 完整可运行示例见 [`examples/sku-detail/`](./examples/sku-detail)。

---

## 指南

### 源站卡片（对接侧插件）

`defineSource()` 声明「怎么连一个源站、能清洗出哪些原子字段」。对接者只声明能力契约，**不知道谁消费**；注册进中心化注册表后，任何商品卡片均可按名引用。

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `meta` | 是 | `{ name, version }`，卡片契约身份 |
| `ref` | 是 | 逻辑 ref，控制面经 `registerSource` 注入物理绑定 |
| `input` | 是 | 源站入参契约（可含分支字段，由 `take` 按值路由端点） |
| `output` | 是 | 原子字段契约（对接者的承诺；流式源站惯例 `z.custom<ReadableStream>`） |
| `upstreamRes` | 是 | 源站原始响应 schema（照抄对方文档） |
| `take` | 是 | 源站入参 → `UpstreamRequest`（`method` / `path` / `params` / `query` / `headers` / `body`） |
| `put` | 否* | 源站响应 → 原子字段；声明 `stream` 的源站可省略（流直写） |
| `request` | 否 | 源站请求契约，用于**子集校验** `take` 产物（只验不重建） |
| `errorMap` | 否 | `{ extract, map, fallback, retryableCodes }`，源站业务错误映射 |
| `stream` | 否 | 声明流式透传：`event-stream` 响应旁路校验 |

`errorMap` 的解析顺序：`extract(body)` 提取源站码 → 查 `map[code]` → 查 `map["HTTP:<status>"]` → 非 2xx 兜底 `fallback`（缺省 `UPSTREAM_UNKNOWN`）。命中 `retryableCodes` 的映射码会驱动重试。

### 商品卡片（业务侧）

`defineCard()` 声明「5 件套 + 出参」，`sources` 是对源站卡片的引用：

| 字段 | 说明 |
| --- | --- |
| `in` / `out` | 商品 API 的入参 / 出参契约（我们定义） |
| `glue` | 总线 `req` 区 schema（`z.object`），框架按字段操作的对象 |
| `toGlue` | 入参 → 总线；**只写 core 字段**，`inject` 字段由框架合成（类型上已被排除） |
| `sources` | `SourceCardRef[]`：`{ source, id, bind }`，`id` 是总线 `res.<id>` 命名空间键，`bind` 把总线数据映射为源站入参 |
| `fromGlue` | 总线 → 出参；多源站聚合时显式合并各命名空间（`res.a` / `res.b` …） |
| `middlewares` | 接缝中间件（见下） |

声明期即做自洽校验：`glue` 非 `z.object`、`sources` 为空、`id` 重复、`bind` 缺失、中间件非法等「对不上」都在 `defineCard` / `defineSource` **就地报错**（`RegistrationError`），不留到运行时。

### 注入与脱敏

```ts
glue: z.object({
  tenantId: inject(z.string()),      // extension：值由控制面注册期注入，toGlue 不负责
  apiKey: redact(z.string()),        // core：审计摘要 / digest 中自动打码（***xx）
})
```

- **`inject`**：声明「运行时差异」字段（租户、密钥、区域等）。`toGlue` 类型上被排除这些字段，框架在合成 `bus.req` 时从 `setRuntimeConfig` 取值填入；`take` / `fromGlue` 可信任其存在。`buildRelay()` 会校验所有 `inject` 字段均可满足，否则拒绝上线。
- **`redact`**：声明「敏感」core 字段。`Bus.digest()` 递归打码，供审计/日志消费；源站原始响应体 `raw` 永不进入摘要，也永不透出商品侧。

注入是**注册期静态**的（每次 `setRuntimeConfig` 更新）；请求期的动态数据一律由 `toGlue` 写入。

### 多源站策略与重试

一张商品卡片可引用多个源站卡片。策略由 `manifest.suggests` 建议、控制面 `setPolicy` 覆盖（**框架主权**）：

| 策略 | 行为 |
| --- | --- |
| `firstSuccess`（默认） | 顺序执行；**仅 `retryable` 错误**切换下一个源站，业务性失败直接抛出 |
| `race` | 并发执行，首个成功者胜出（全部失败时抛聚合错误的第一个） |
| `all` | 全部执行（聚合场景，`fromGlue` 合并各命名空间） |
| `scripted` | 源站段**不自动执行**：执行权在卡片编排逻辑，经 `ctx.invoke` 按需、按序、可并发驱动（见下） |

重试由 `RetryPolicy { max, backoff: 'fixed' | 'expo' }` 控制。`retryable` 是重试/切换源站的**唯一信号**：传输层 `TIMEOUT` / `NETWORK` 天然可重试，业务错误需命中 `errorMap.retryableCodes` 才可重试。

```ts
controller.setPolicy('product.detail', {
  timeoutMs: 3000,
  retry: { max: 2, backoff: 'expo' },
  strategy: 'firstSuccess',
});
```

解析优先级：`setPolicy` 覆盖 > `manifest.suggests` > 框架默认（`timeoutMs` 兜底为 `defaultTimeoutMs`，缺省 10s；`retry` 缺省 `{ max: 0 }`；`strategy` 缺省 `firstSuccess`）。

#### scripted 与编排原语 ctx.invoke

`scripted` 策略把 per-source 段的执行权交给**卡片自带的编排逻辑**（`middlewares`）：`sources` 照常声明（保住 manifest 交叉校验、`inspectCard` 依赖边视图与绑定就绪门禁），但不自动运行；编排代码经 `ctx.invoke(sourceId, input?)` 按需、按序、可并发地驱动源站段。

```ts
defineCard({
  // ...
  sources: [
    { source: tokenSc, id: 'token', bind: (g) => ({ productId: g.productId }) },
    { source: deductSc, id: 'deduct', bind: (g) => ({ /* ... */ }) },
  ],
  middlewares: [{
    seam: 'fromGlue',
    run: async (ctx, next) => {
      const token = await ctx.invoke('token');            // 省略 input → 走 bind(glue)
      const req = ctx.bus.req as { accountId: string; points: number };
      await ctx.invoke('deduct', {                        // 显式 input → 跳过 bind,仍过 input 校验点
        token: (token as { value: string }).value,        // 上一步产物可直读
        accountId: req.accountId, points: req.points,
      });
      await next();                                       // fromGlue 从 res.token / res.deduct 读 IR
    },
  }],
  // ...
});
controller.setPolicy('orchestrate.deduct', { strategy: 'scripted' });
```

- 每次 `invoke` 都走**完整源站段**（take / transport / put / 各校验点），产物写入 `res.<id>`（IR），`onBusRes` 钩子逐步触发，`digest()` 全量可见——治理主权不因编排旁路；
- 仅 `scripted` 策略下可用，否则 `GLUE.CARD.INVOKE_FORBIDDEN`；未声明的 id → `GLUE.CARD.SOURCE_NOT_DECLARED`；
- 多源容灾不再自动：降级由编排逻辑 `try/catch` 决定；`timeoutMs` / `retry` / `errorMap` 仍按源站卡片逐次生效；
- 并发安全：per-source 段隔离字段各持浅拷贝，`Promise.all` 多路 `invoke` 互不踩（同一 `id` 重复 invoke 为 last-write-wins）。

### 流式透传（SSE）

源站卡片声明 `stream: true` 后，`text/event-stream` 响应**旁路校验**、`put` 可省略，流直写 `res.<id>`；商品卡片 `out` 声明为 `z.custom<ReadableStream<Uint8Array>>()`，`fromGlue` 直通即可。

```ts
const llmChat = defineSource({
  meta: { name: 'openai.chat', version: '1.0.0' },
  ref: 'llm/openai',
  stream: true,                                  // 旁路校验是显式授予的特权
  input: z.object({ prompt: z.string() }),
  upstreamRes: z.custom<ReadableStream<Uint8Array>>(),
  output: z.custom<ReadableStream<Uint8Array>>(),
  take: ({ prompt }) => ({
    method: 'POST' as const,
    path: '/v1/chat/completions',
    body: { prompt, stream: true },
  }),
  // put 省略：流直写 res.<id>
});
```

- **未声明 `stream` 却收到流式响应** → `GLUE.BUSINESS.UPSTREAM_STREAM_UNDECLARED`（拒绝静默旁路）；
- 超时只覆盖到**流建立**，消费期不受 `timeoutMs` 限制；
- 失败/切换时会 `cancel()` 已建立但未消费的流，防连接悬挂；
- 经 `toFetchHandler` 暴露时，流式 `out` 自动作为 `text/event-stream` Response 直通；
- 需对流做加工（协议适配、事件重排）时，用原语 `sseEvents(stream)` / `parseSseJson(data)`。

### manifest 与版本治理

manifest 是**框架级卡片契约**（配置文件，部署唯一事实）；schema 是**类型唯一事实**。两者在注册期交叉校验防漂移。

```json
{
  "name": "product.detail",
  "version": "1.0.0",
  "entry": "./index.js",
  "requires": { "sources": ["jd.item-detail"], "injections": ["tenantId"] },
  "suggests": { "timeoutMs": 3000, "retry": { "max": 2, "backoff": "expo" }, "strategy": "firstSuccess" }
}
```

- `manifest` 可省略（由代码合成）；提供时校验 `name` / `version` / `requires.sources` / `requires.injections` 与代码一致。
- Node 便捷入口：`await controller.registerCardFromManifest('./cards/sku-detail/card.json')`（`entry` 动态 import，default 导出须为卡片）。

> ⚠️ **`requires.sources` 两侧同名不同义**：**商品卡片**里列出的是「引用的**源站卡片名**」（如 `jd.item-detail`）；**源站卡片**自己列出的是「物理绑定 **ref**」（如 `jd/items/detail`，它直接依赖绑定）。用于部署编排工具时需注意区分。

**版本门禁**（框架不留版本史，历史是宿主制品层的责任）：

- 同名同版本 → 拒绝（`version:duplicate`）；
- 低于当前服务版本 → 默认拒绝（防误发旧版）；显式声明回滚意图 `registerCard(card, manifest, { rollback: true })` 方可重发旧版制品，**原子替换** current（无下线窗口）；
- `deregisterCard(name)` = **退役**（退出服务目录，`handle` 即 `CARD.NOT_FOUND`；in-flight 请求持旧引用跑完，不断服）。退役 ≠ 回滚。

服务目录为 `name → current`（每名字仅一份），服务面每次 `handle` **实时解析** → 原子切换。

### 框架钩子与接缝中间件

两者都是洋葱模型，但**主权不同**：

- **框架钩子（`ControllerHooks`）**：框架特权（审计/注入/屏蔽）的执行点，**卡片不可覆盖**，置于接缝最外层。
  - `onBusReq`：`glue` 校验通过后、per-source 段之前，可读写 `ctx.bus.req`；
  - `onBusRes`：源站响应写入 `res.<id>` 之后，可读写 `ctx.bus.res`。
- **接缝中间件（`middlewares`）**：卡片自带的洋葱层，声明作用于哪个接缝（`toGlue` / `bind` / `take` / `put` / `fromGlue`）。

```ts
const controller = new RelayController({
  hooks: {
    onBusReq: (ctx) => { (ctx.bus.req as any).internalTag = '***'; },  // 屏蔽
    onBusRes: (ctx) => { audit.write(ctx.bus.digest()); },              // 审计
  },
});

// 卡片中间件：next() 前改写、next() 后读取本接缝产物
defineCard({
  // ...
  middlewares: [{
    seam: 'take',
    run: async (ctx, next) => {
      await next();                                  // take 产物就绪、transport 未执行
      ctx.upstream = { ...ctx.upstream!, headers: { 'x-trace': ctx.meta.traceId as string } };
    },
  }],
});
```

`GlueCtx` 贯穿一次执行，含 `card` / `bus` / `state` / `log` / `signal` / `timing` / `meta` / `invoke`（编排原语，scripted 专用），以及 per-source 段隔离的 `sourceId` / `sourceInput` / `upstream` / `raw`。

### 暴露为 fetch handler

```ts
const handler = relay.toFetchHandler();     // 缺省路由：pathname 首段 decodeURIComponent = 卡片名
// 或自定义路由：relay.toFetchHandler({ route: (req) => parseCardName(req) })

const res = await handler(new Request('https://x/product.detail', {
  method: 'POST',
  body: JSON.stringify({ sku: 'A1' }),
}));
```

- `GET` / `HEAD`：query 参数作为入参；其它方法：JSON body 作为入参；
- 成功 → `application/json`（`out`）；流式 `out` → `text/event-stream` 直通；
- 失败 → `{ error: { code, sourceId? } }`，**不透出** `raw` 与内部 message 细节。

适配任意 fetch 兼容运行时（Node、Edge、Workers、网关）。

### 测试

`omni-relay/testing` 子入口提供 mock 传输，无需真实网络：

```ts
import { mockSource, lastBody } from 'omni-relay/testing';

// 回放规则：单值 / 序列（超出取最后一个，便于测重试耗尽）/ 函数（按调用次数）
const src = mockSource('jd/items/detail', { body: { item_name: 'X', price: 9.9, stock: 3 } });

controller.registerSource(src.ref, src.binding);   // binding 内置 mock fetch
// ... registerSourceCard / registerCard / setRuntimeConfig / buildRelay / handle

src.mock.calls[0].url;    // 断言 take 产物（URL）
lastBody(src.mock);       // 断言请求体
```

流式回放用 `{ sse: 'data: hi\n\ndata: [DONE]\n\n' }`（或现成 `ReadableStream`）。

---

## 校验点与错误码

管道上有 7 个 Zod 校验点（`strict: false` 可整体跳过），失败即收敛为 `GlueError`：

| 校验点 | 归属接缝 | 校验对象 | 错误码 | HTTP |
| --- | --- | --- | --- | --- |
| `in` | toGlue | 商品入参 vs `card.in` | `GLUE.SCHEMA.IN` | 400 |
| `glue` | toGlue | 总线 `req` vs `card.glue` | `GLUE.SCHEMA.GLUE` | 502 |
| `input` | bind | 源站入参 vs `source.input` | `GLUE.SCHEMA.INPUT` | 502 |
| `request` | take | 源站请求 vs `source.request`（可选） | `GLUE.SCHEMA.REQUEST` | 502 |
| `upstreamRes` | put | 源站原始响应 vs `source.upstreamRes` | `GLUE.SCHEMA.UPSTREAM_RES` | 502 |
| `output` | put | 原子字段 vs `source.output` | `GLUE.SCHEMA.OUTPUT` | 502 |
| `out` | fromGlue | 商品出参 vs `card.out` | `GLUE.SCHEMA.OUT` | 502 |

统一错误模型 `GlueError`：任何一跳失败都收敛为它。字段 `code` / `message` / `retryable` / `status` / `seam` / `sourceId?` / `raw?`。

| 错误码族 | HTTP | retryable | 含义 |
| --- | --- | --- | --- |
| `GLUE.SCHEMA.*` | 400 / 502 | 否 | 校验点失败（见上表） |
| `GLUE.TRANSPORT.TIMEOUT` | 504 | **是** | 源站请求超时 |
| `GLUE.TRANSPORT.NETWORK` | 502 | **是** | 源站网络错误 |
| `GLUE.TRANSPORT.CANCELLED` | 499 | 否 | 请求被取消 |
| `GLUE.BUSINESS.<CODE>` | 502 | 视 `retryableCodes` | 源站业务错误（`errorMap` 翻译后），含 `SOURCE_UNBOUND` / `UPSTREAM_STREAM_UNDECLARED` |
| `GLUE.CARD.*` | 404 / 500 | 否 | 未注册的卡片（`NOT_FOUND`）；非 scripted 调用 invoke（`INVOKE_FORBIDDEN`）；invoke 未声明的源站（`SOURCE_NOT_DECLARED`） |
| `GLUE.UNKNOWN` | 500 | 否 | 未收敛的异常 |

- `retryable` 是**重试 / 切换源站的唯一信号**；
- `raw`（源站原始响应体）**只进日志/审计，永不透出**给商品侧（`toJSON()` 只含 `code` / `status` / `sourceId`）；
- 声明期 / 注册期错误为 `RegistrationError`（带 `step` 定位）。

---

## API 参考

主入口 `omni-relay`：

| 分类 | 导出 |
| --- | --- |
| 定义卡片 | `defineCard`、`defineSource`、`inject`、`redact` |
| 控制面 | `RelayController`、`noopLogger` |
| 服务面 | `Relay` |
| manifest | `ManifestSchema`、`parseManifest`、`readManifest` |
| 总线 / 标记 | `Bus`、`relayMeta`、`scanGlueMeta` |
| 源站 / 传输 | `SourceRegistry`、`defaultTransport`、`buildUrl`、`buildInit`、`MockSource` |
| 流式 | `isReadableStream`、`sseEvents`、`parseSseJson` |
| 错误 | `GlueError`、`RegistrationError` |
| 类型 | `RelayCard`、`SourceCard`、`SourceCardRef`、`GlueCtx`、`UpstreamRequest`、`SourceBinding`、`ResolvedPolicy`、`InspectView`、`Manifest`、`CheckSeam`、`SseEvent` 等 |

测试子入口 `omni-relay/testing`：`mockSource`、`lastBody`、`MockSource`，及类型 `MockedSource`、`MockResponse`、`MockResponder`。

`RelayController` 主要方法：

| 方法 | 说明 |
| --- | --- |
| `registerSource(ref, binding)` | 逻辑 ref → 物理绑定（`baseURL` / `headers` / `auth` / `timeoutMs` / `fetch`） |
| `registerSourceCard(sc, manifest?, opts?)` | 注册源站卡片到中心化注册表 |
| `registerCard(card, manifest?, opts?)` | 注册商品卡片（执行交叉校验链 + 版本门禁） |
| `registerCardFromManifest(path, loader?)` | Node 便捷入口：从 manifest 文件注册 |
| `setRuntimeConfig(name, config)` | 注入 `inject` 字段值 |
| `setPolicy(name, policy)` | 性能类策略覆盖（`timeoutMs` / `retry` / `strategy`） |
| `buildRelay()` | 上线门：注入字段齐备后产出 `Relay` |
| `deregisterCard(name)` / `deregisterSourceCard(name)` | 退役 |
| `inspectCard(name)` / `inspectSourceCard(name)` | 字段级只读视图（管理界面 / 审计工具消费） |
| `listCards()` / `listSourceCards()` / `listBindings()` | 清单视图（`listBindings` 不含认证材料，仅 `hasAuth` 布尔） |
| `getAuditLog()` | 控制面操作审计（谁在何时注册 / 变更了什么） |

---

## 设计原则

- **卡片是一等公民**：每个能力（源站对接 / 商品 API）都是可独立声明、注册、版本化、退役的卡片。
- **声明期自洽**：`defineCard` / `defineSource` 就地校验，「对不上」在声明期报错，不留到运行时。
- **契约双事实源交叉校验**：schema 是类型唯一事实，manifest 是部署唯一事实，注册期交叉校验防漂移。
- **总线是介入面**：框架主权（审计 / 注入 / 屏蔽）住在总线与钩子上，卡片不可覆盖 —— 治理与业务解耦。
- **控制面 / 服务面分离**：控制面治理、服务面执行，原子切换不断服，in-flight 请求持旧引用跑完。
- **对接与消费解耦**：源站卡片不知道谁消费，商品卡片不接触源站细节，经中心化注册表按名引用。
- **错误收敛**：任何一跳失败收敛为 `GlueError`，`retryable` 是重试/切换唯一信号，`raw` 永不外泄。

---

## 项目结构

```
src/
├─ index.ts            公共出口
├─ core/
│  ├─ types.ts         全部类型契约
│  ├─ card.ts          defineCard（商品卡片声明期校验）
│  ├─ sourceCard.ts    defineSource（源站卡片声明期校验）
│  ├─ markers.ts       inject / redact 字段标记
│  ├─ bus.ts           中介总线（三分区 + 脱敏摘要）
│  ├─ pipeline.ts      管道执行序（per-source 段、重试、错误映射）
│  ├─ strategy.ts      多源站策略（firstSuccess / race / all）
│  ├─ controller.ts    控制面（注册 / 绑定 / 注入 / 策略 / 审计 / 版本门禁）
│  ├─ relay.ts         服务面（handle / toFetchHandler）
│  ├─ manifest.ts      manifest schema 与读取
│  ├─ errors.ts        GlueError / RegistrationError 与错误码
│  ├─ validate.ts      校验点执行器
│  └─ stream.ts        isReadableStream
├─ source/
│  ├─ registry.ts      源站注册表（ref → 物理绑定）
│  ├─ transport.ts     defaultTransport / buildUrl / buildInit / MockSource
│  └─ sse.ts           sseEvents / parseSseJson 流原语
└─ testing/
   └─ index.ts         测试子入口（mockSource / lastBody）
```

---

## 开发

```bash
pnpm install
pnpm build       # tsdown → dist（ESM + CJS + 类型声明 + sourcemap）
pnpm test        # vitest run
pnpm test:watch  # vitest 监听模式
pnpm test:coverage
pnpm typecheck   # tsc --noEmit
```

---

## License

MIT（见 [`package.json`](./package.json) 的 `license` 字段）。
