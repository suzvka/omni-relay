# omni-relay 应转尽转·业务管线编排器

> 以**卡片**为一等公民的 API 绑定框架:把任意源站 API 包装为可复用的 **API 卡片**,业务卡片用**命令式双钩子**在一块 **IR 键值缓存**上编排它们,对外暴露稳定的商品 API;**IR** 是框架执行宿主规则(注入 / 屏蔽 / 审计)的介入面。

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
  - [API 卡片（对接侧插件）](#api-卡片对接侧插件)
  - [业务卡片（collect / respond 双钩子）](#业务卡片collect--respond-双钩子)
  - [IR：键值缓存与 seeds 注入](#ir键值缓存与-seeds-注入)
  - [编排原语 ctx.invoke 与多源容灾](#编排原语-ctxinvoke-与多源容灾)
  - [流式透传（SSE）](#流式透传sse)
  - [manifest 与版本治理](#manifest-与版本治理)
  - [框架钩子](#框架钩子)
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
- 业务过程往往是**命令式**的：先取 A、用 A 的结果决定要不要取 B、失败要降级——用声明式数据流表达这些很别扭；
- 上游会超时、限流、宕机，需要**重试与容灾切换**，且要能区分「可重试」与「业务性失败」；
- 对接侧和业务侧往往是不同的人，**对接逻辑**（怎么连一个源站）和**业务逻辑**（怎么编排成商品）需要解耦、独立演进与版本化。

omni-relay 的回答是**卡片化 + IR 键值缓存 + 命令式双钩子**：

- 每个能力都是一张可独立声明、注册、版本化、卸载的**卡片**；
- 一次执行围绕一块 **IR**（键值缓存）展开：业务卡片在 **collect** 钩子里直读直写 IR、按需 `invoke` API 卡片把数据收集进来，在 **respond** 钩子里只读 IR 构筑出参；
- **控制面**负责治理（注册/绑定/注入/策略，治理动作经事件回调通知宿主），**服务面**负责执行（`handle` / `fetch`），两者分离，原子切换不断服。

---

## 核心概念

| 概念 | 说明 | 定义方式 |
| --- | --- | --- |
| **API 卡片** | 对接侧插件：封装「连接一个源站 + 清洗为原子字段」。 | `defineSource()` |
| **业务卡片** | 业务侧插件：对外稳定的商品 API。 | `defineCard()` |
| **IR** | 贯穿一次执行的键值缓存，框架执行宿主规则的介入面。 | 框架内部构造，`ctx.ir` |
| **seeds** | 宿主注册期注入的 IR 初始键；`buildRelay` 上线门一次性校验其存在 + 类型。 | `seeds` + `setRuntimeConfig` |
| **编排原语** | `ctx.invoke(id, input?)`：调用一张已注册 API 卡片，产物写回 IR 并返回。 | `CollectCtx.invoke` |
| **控制面** | 卡片注册与卸载、源站绑定、seeds 注入、策略覆盖、治理事件通知、版本门禁。 | `RelayController` |
| **服务面** | 程序化调用 `handle`，或暴露为框架无关的 `fetch` handler。 | `Relay` |

**自封装卡片**是理解 omni-relay 的关键：API 卡片是「标准化的对接模块」，业务卡片是「顶层业务」；对接者向中心化注册表注册自己的能力，业务卡片在 `collect` 里按名 `invoke`，两侧解耦、各自演进。

---

## 数据流：一次 handle 发生了什么

```
入站请求
  │  
  ▼
信息收集 ---
  |       | 业务过程
  ▼       |
响应构筑 ---
  |
  ▼ 
返回响应
```

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
import { defineCard, defineSource, RelayController } from 'omni-relay';

// 1) API 卡片：封装「连接一个源站 + 清洗为原子字段」（对接侧插件）
const jdItemDetail = defineSource({
  meta: { name: 'jd.item-detail', version: '1.0.0' },
  ref: 'jd/items/detail',                    // 逻辑 ref，控制面据此绑定物理地址

  input: z.object({ skuId: z.string() }),    // invoke 省略入参时从 IR 读取的键
  output: z.object({                         // invoke 写回 IR 的原子字段
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
  put: (raw) => ({                           // 源站响应 → 原子字段（脏字段挡在 IR 之外）
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

// 2) 业务卡片：对外稳定的商品 API（命令式双钩子）
const skuDetail = defineCard({
  meta: { name: 'product.detail', version: '1.0.0' },

  in: z.object({ sku: z.string(), count: z.number().int().positive().default(1) }),
  out: z.object({ name: z.string(), cents: z.number(), available: z.boolean() }),

  seeds: { tenantId: z.string() },           // 宿主注册期注入的 IR 初始键
  uses: ['jd.item-detail'],                  // 声明可能 invoke 的 API 卡片（供治理/inspect）

  // collect：入站请求 → IR，再 invoke 把数据收集进 IR
  collect: async (ctx) => {
    const { sku, count } = ctx.input as { sku: string; count?: number };
    ctx.ir.skuId = sku;                      // 填 IR：jd 的 input 需要 skuId
    ctx.ir.quantity = count ?? 1;
    await ctx.invoke('jd.item-detail');      // 省略入参 → 从 IR 按 input 取 skuId
  },

  // respond：只读 IR（ir['jd.item-detail'] 是 invoke 写回的原子字段）
  respond: (ctx) => {
    const jd = ctx.ir['jd.item-detail'] as { title: string; priceCents: number; inStock: boolean };
    return { name: jd.title, cents: jd.priceCents, available: jd.inStock };
  },
});

// 3) 控制面：绑定物理源站 → 注册卡片 → 注入 seeds → 上线
const controller = new RelayController();
controller
  .registerSource('jd/items/detail', {
    baseURL: 'https://api.jd.example.com',
    auth: () => process.env.JD_TOKEN!,       // 惰性取用，值不进 IR
  })
  .registerSourceCard(jdItemDetail)
  .registerCard(skuDetail)
  .setRuntimeConfig('product.detail', { tenantId: 'T-01' });

const relay = controller.buildRelay();       // 上线门：seeds 存在 + 类型齐备才产出 Relay

// 4) 服务面：程序化调用（成功返回 out，失败抛 GlueError）
const out = await relay.handle('product.detail', { sku: 'A1' });
// → { name: 'X', cents: 990, available: true }
```

> 完整可运行示例见 [`examples/sku-detail/`](./examples/sku-detail)。

---

## 指南

### API 卡片（对接侧插件）

`defineSource()` 声明「怎么连一个源站、能清洗出哪些原子字段」。对接者只声明能力契约，**不知道谁消费**；注册进中心化注册表后，任何业务卡片均可在 `collect` 里按名 `invoke`。

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `meta` | 是 | `{ name, version }`，卡片契约身份（`name` 即 `invoke` 的 id） |
| `ref` | 是 | 逻辑 ref，控制面经 `registerSource` 注入物理绑定 |
| `input` | 是 | 源站入参契约：`invoke` 省略入参时据此**从 IR 提取**所需键 |
| `output` | 是 | 原子字段契约（对接者的承诺；流式源站惯例 `z.custom<ReadableStream>`） |
| `upstreamRes` | 是 | 源站原始响应 schema（照抄对方文档） |
| `take` | 是 | 源站入参 → `UpstreamRequest`（`method` / `path` / `params` / `query` / `headers` / `body`） |
| `put` | 否* | 源站响应 → 原子字段；声明 `stream` 的源站可省略（流直写） |
| `request` | 否 | 源站请求契约，用于**子集校验** `take` 产物（只验不重建） |
| `errorMap` | 否 | `{ extract, map, fallback, retryableCodes }`，源站业务错误映射 |
| `stream` | 否 | 声明流式透传：`event-stream` 响应旁路校验 |

`errorMap` 的解析顺序：`extract(body)` 提取源站码 → 查 `map[code]` → 查 `map["HTTP:<status>"]` → 非 2xx 兜底 `fallback`（缺省 `UPSTREAM_UNKNOWN`）。命中 `retryableCodes` 的映射码会驱动重试。

### 业务卡片（collect / respond 双钩子）

`defineCard()` 声明「入站/出参契约 + 两个钩子」：

| 字段 | 说明 |
| --- | --- |
| `in` / `out` | 商品 API 的入站请求 / 出参契约（我们定义；两端 `▸in` / `▸out` 校验点） |
| `seeds` | 可选，`{ 键: Zod schema }`：宿主注册期注入的 IR 初始键；`buildRelay` 一次性校验存在 + 类型 |
| `uses` | 可选，`string[]`：声明可能 `invoke` 的 API 卡片名（供 manifest 交叉校验 / `inspectCard` 依赖边）；**不限制** `invoke` |
| `collect` | **入站请求处理钩子**：`(ctx: CollectCtx) => void \| Promise<void>`。业务过程本身——直读直写 `ctx.ir`、按需 `ctx.invoke` 把数据收集进 IR |
| `respond` | **响应构筑钩子**：`(ctx: RespondCtx) => out`。只读 IR 构筑出参；`RespondCtx` 类型层无 `invoke` |

声明期即做自洽校验：`in`/`out` 非 Zod、`collect`/`respond` 非函数、`seeds` 值非 Zod、`uses` 含空串、缺 `meta.name` 等「对不上」都在 `defineCard` / `defineSource` **就地报错**（`RegistrationError`），不留到运行时。

`collect` 与 `respond` 本质同形（都在 IR 上工作），强制二分只为**语义清晰与过程可见**：取数在 collect、构筑在 respond，读代码时一眼可辨。

### IR：键值缓存与 seeds 注入

IR（`ctx.ir`）是一块 `Record<string, unknown>` 键值缓存，贯穿一次执行：

- **seeds**：宿主经 `setRuntimeConfig(name, config)` 在注册期注入的初始键（租户、密钥、区域等），在 `collect` 前并入 IR。`buildRelay()` 会用 `seeds` 声明的 schema 一次性校验每个 seed 值**存在且类型正确**，否则拒绝上线——这份静态校验只在上线门跑一次，不摊到每次请求。
- **collect 填充**：请求期的动态数据一律由 `collect` 直写 IR（`ctx.ir.skuId = ...`），把入站请求格式化为后续 `invoke` 所需的键。
- **invoke 写回**：每次 `ctx.invoke(id)` 的产物写入 `ir[id]`（命名空间 = API 卡片名，避免碰撞），同时作为返回值可直接使用。
- **respond 只读**：`respond` 只消费 IR 中已有的值。

IR 全程公开可读——宿主的字段级治理动作（摘要、屏蔽等）在 `onBusReq` / `onBusRes` 钩子中按**宿主自身规则**实现，框架不内建任何具体规则。

### 编排原语 ctx.invoke 

`ctx.invoke(id, input?)` 调用一张**已注册**的 API 卡片，每次都走**完整源站段**，产物会出现在 IR 中：

- `invoke(id)`：省略入参 → 从 IR 按 `source.input` **提取并校验**所需键（印证「调用前确保 IR 已填好该 API 入参」）；
- `invoke(id, input)`：显式入参（仍过 `▸input` 校验），用于携带上一步产物或派生参数；
- `id` 未注册 → `GLUE.CARD.SOURCE_NOT_REGISTERED`；其 `ref` 未绑定 → `GLUE.BUSINESS.SOURCE_UNBOUND`；
- **并发安全**：每次 invoke 内部隔离，`Promise.all` 多路 invoke 互不踩（同一 `id` 重复 invoke 为 last-write-wins）。

```ts
collect: async (ctx) => {
  let lastErr: unknown;
  for (const id of ['endpoint.a', 'endpoint.b']) {
    try {
      await ctx.invoke(id);
      return;                                  // 首个成功即胜出
    } catch (e) {
      if (e instanceof GlueError && e.retryable) { lastErr = e; continue; }
      throw e;                                 // 业务性失败不切换，直接抛出
    }
  }
  throw lastErr;
},
```

`timeoutMs` / `retry`（`{ max, backoff: 'fixed' | 'expo' }`）由 `setPolicy` 覆盖 > `manifest.suggests` > 框架默认（`timeoutMs` 再兜底 `registerSource` 的 `binding.timeoutMs`、最终 `defaultTimeoutMs`，缺省 10s；`retry` 缺省 `{ max: 0 }`），逐次 invoke 生效。`retryable` 由传输层（`TIMEOUT`/`NETWORK` 天然可重试）与 `errorMap.retryableCodes` 决定。

```ts
controller.setPolicy('product.detail', { timeoutMs: 3000, retry: { max: 2, backoff: 'expo' } });
```

### 流式透传（SSE）

API 卡片声明 `stream: true` 后，`text/event-stream` 响应**旁路校验**、`put` 可省略，流直写 `ir[id]`；业务卡片 `out` 声明为 `z.custom<ReadableStream<Uint8Array>>()`，`respond` 直通即可。

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
  // put 省略：流直写 ir[id]
});
```

- **未声明 `stream` 却收到流式响应** → `GLUE.BUSINESS.UPSTREAM_STREAM_UNDECLARED`（拒绝静默旁路）；
- 超时只覆盖到**流建立**，消费期不受 `timeoutMs` 限制；
- 失败时会 `cancel()` 已建立但未消费的流，防连接悬挂；
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
  "suggests": { "timeoutMs": 3000, "retry": { "max": 2, "backoff": "expo" } }
}
```

- `manifest` 可省略（由代码合成）；提供时校验 `name` / `version` / `requires.sources`（对 `uses`）/ `requires.injections`（对 `seeds` 键）与代码一致。
- Node 便捷入口：`await controller.registerCardFromManifest('./cards/sku-detail/card.json')`（`entry` 动态 import，default 导出须为卡片）。

> ⚠️ **`requires.sources` 两侧同名不同义**：**业务卡片**里列出的是 `uses`（可能 invoke 的 **API 卡片名**，如 `jd.item-detail`）；**API 卡片**自己列出的是「物理绑定 **ref**」（如 `jd/items/detail`）。

**版本门禁**：

- 同名同版本 → 拒绝（`version:duplicate`）；
- 低于当前服务版本 → 默认拒绝（防误发旧版）；
- `deregisterCard(name)` = **卸载**（从服务目录移除当前卡片，`handle` 即 `CARD.NOT_FOUND`；in-flight 请求持旧引用跑完，不断服）。

> 卸载 API 卡片的影响面：v2 下 `collect` 经 `ctx.invoke` **按名动态解析** API 卡片，卸载后 invoke 即 `SOURCE_NOT_REGISTERED`——依赖是运行时解析的，不再内嵌副本。

服务目录为 `name → current`（每名字仅一份）：服务面每次 `handle` **实时解析** → 原子切换；升级与回滚都只是注册链上的一次版本号比较 + 原子替换，不存在下线窗口。

### 框架钩子

宿主规则在 IR 上的执行点，**卡片不可覆盖**：

- `onBusReq`：`▸in` 校验通过、seeds 并入 IR 后、`collect` 之前，可读写 `ctx.ir`（宿主预填/屏蔽上下文）；
- `onBusRes`：每次 `invoke` 产物写入 `ir[id]` 之后，可读写 `ctx.ir`（`ctx.sourceId` 为本次 API 卡片名）。

```ts
const controller = new RelayController({
  onControlEvent: (e) => audit.write(e),                            // 控制面治理事件
  hooks: {
    onBusReq: (ctx) => { ctx.ir.tenantId = mask(ctx.ir.tenantId); },  // 屏蔽/改写
    onBusRes: (ctx) => { audit.write(snapshotOf(ctx.ir)); },           // 宿主自定快照/摘要
  },
});
```

`CollectCtx` 含 `card` / `input` / `ir` / `state` / `log` / `signal` / `timing` / `meta` / `invoke` / `sourceId`；`RespondCtx` 与之同形但**无 `invoke`**。

### 暴露为 fetch handler

```ts
const handler = relay.toFetchHandler();     // 缺省路由：整个 pathname（去首尾斜杠）decodeURIComponent = 卡片名
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

管道上有 6 个 Zod 校验点（`strict: false` 可整体跳过），失败即收敛为 `GlueError`：

| 校验点 | 归属阶段 | 校验对象 | 错误码 | HTTP |
| --- | --- | --- | --- | --- |
| `in` | collect | 入站请求 vs `card.in` | `GLUE.SCHEMA.IN` | 400 |
| `input` | invoke | 源站入参（IR 提取或显式）vs `source.input` | `GLUE.SCHEMA.INPUT` | 502 |
| `request` | invoke | 源站请求 vs `source.request`（可选） | `GLUE.SCHEMA.REQUEST` | 502 |
| `upstreamRes` | invoke | 源站原始响应 vs `source.upstreamRes` | `GLUE.SCHEMA.UPSTREAM_RES` | 502 |
| `output` | invoke | 原子字段 vs `source.output` | `GLUE.SCHEMA.OUTPUT` | 502 |
| `out` | respond | 商品出参 vs `card.out` | `GLUE.SCHEMA.OUT` | 502 |

> IR 本身**没有**整体校验点：它是自由键值缓存，契约校验落在两端（`in`/`out`）与每次 `invoke` 的源站段（`input`/`output` 等）。seeds 的类型校验在 `buildRelay` 上线门一次性完成。

统一错误模型 `GlueError`：任何一跳失败都收敛为它。字段 `code` / `message` / `retryable` / `status` / `seam` / `sourceId?` / `raw?`。

| 错误码族 | HTTP | retryable | 含义 |
| --- | --- | --- | --- |
| `GLUE.SCHEMA.*` | 400 / 502 | 否 | 校验点失败（见上表） |
| `GLUE.TRANSPORT.TIMEOUT` | 504 | **是** | 源站请求超时 |
| `GLUE.TRANSPORT.NETWORK` | 502 | **是** | 源站网络错误 |
| `GLUE.TRANSPORT.CANCELLED` | 499 | 否 | 请求被取消 |
| `GLUE.BUSINESS.<CODE>` | 502 | 视 `retryableCodes` | 源站业务错误（`errorMap` 翻译后），含 `SOURCE_UNBOUND` / `UPSTREAM_STREAM_UNDECLARED` |
| `GLUE.CARD.NOT_FOUND` | 404 | 否 | 未注册的业务卡片 |
| `GLUE.CARD.SOURCE_NOT_REGISTERED` | 404 | 否 | `invoke` 了未注册的 API 卡片 |
| `GLUE.UNKNOWN` | 500 | 否 | 未收敛的异常 |

- `retryable` 是**重试 / 切换源站的唯一信号**；
- `raw`（源站原始响应体）只留在错误对象内供宿主消费，**永不透出**给商品侧（`toJSON()` 只含 `code` / `status` / `sourceId`）；
- 声明期 / 注册期错误为 `RegistrationError`（带 `step` 定位）。

---

## API 参考

主入口 `omni-relay`：

| 分类 | 导出 |
| --- | --- |
| 定义卡片 | `defineCard`、`defineSource` |
| 控制面 | `RelayController`、`noopLogger` |
| 服务面 | `Relay` |
| manifest | `ManifestSchema`、`parseManifest`、`readManifest` |
| 源站 / 传输 | `SourceRegistry`、`defaultTransport`、`buildUrl`、`buildInit`、`MockSource` |
| 流式 | `isReadableStream`、`sseEvents`、`parseSseJson` |
| 错误 | `GlueError`、`RegistrationError` |
| 类型 | `RelayCard`、`SourceCard`、`CollectCtx`、`RespondCtx`、`UpstreamRequest`、`SourceBinding`、`ResolvedPolicy`、`InspectView`、`Manifest`、`CheckSeam`、`SseEvent` 等 |

测试子入口 `omni-relay/testing`：`mockSource`、`lastBody`、`MockSource`，及类型 `MockedSource`、`MockResponse`、`MockResponder`。

`RelayController` 主要方法：

| 方法 | 说明 |
| --- | --- |
| `registerSource(ref, binding)` | 逻辑 ref → 物理绑定（`baseURL` / `headers` / `auth` / `timeoutMs` / `fetch`） |
| `registerSourceCard(sc, manifest?, opts?)` | 注册 API 卡片到中心化注册表 |
| `registerCard(card, manifest?, opts?)` | 注册业务卡片（执行交叉校验链 + 版本门禁） |
| `registerCardFromManifest(path, loader?)` | Node 便捷入口：从 manifest 文件注册业务卡片 |
| `registerSourceCardFromManifest(path, loader?)` | Node 便捷入口：从 manifest 文件注册 API 卡片 |
| `setRuntimeConfig(name, config)` | 注入 `seeds` 键值（注册期静态） |
| `setPolicy(name, policy)` | 性能类策略覆盖（`timeoutMs` / `retry`） |
| `buildRelay()` | 上线门：seeds 存在 + 类型齐备后产出 `Relay` |
| `deregisterCard(name)` / `deregisterSourceCard(name)` | 卸载 |
| `inspectCard(name)` / `inspectSourceCard(name)` | 字段级只读视图（管理界面消费） |
| `listCards()` / `listSourceCards()` / `listBindings()` | 清单视图（`listBindings` 不含认证材料，仅 `hasAuth` 布尔） |
| `onControlEvent`（构造选项） | 控制面治理事件回调；条目格式与去向由宿主决定，框架不留存 |

---

## 项目结构

```
src/
├─ index.ts            公共出口
├─ core/
│  ├─ types.ts         全部类型契约（CollectCtx / RespondCtx / RawCardDef …）
│  ├─ card.ts          defineCard（业务卡片声明期校验）
│  ├─ sourceCard.ts    defineSource（API 卡片声明期校验）
│  ├─ pipeline.ts      管道执行序（collect / respond / invoke 内核、重试、错误映射）
│  ├─ controller.ts    控制面（注册 / 绑定 / seeds / 策略 / 治理事件 / 版本门禁）
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
