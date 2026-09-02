<div align="center">

# omni-relay 应转尽转·业务管线编排器

**把整个上游聚合域封装成卡片，装进你的服务就能用。**

任意源站、任意协议一律卡片化 —— 零胶水对接、零脏字段泄漏、零停机升级。

[![license](https://img.shields.io/badge/license-MIT-blue)](#license)
[![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)]()
[![zod](https://img.shields.io/badge/peer-zod%20%5E4-3178c6)]()
[![module](https://img.shields.io/badge/module-ESM%20%2B%20CJS-orange)]()

</div>

---

## 为什么选 omni-relay

把多个异构上游聚合成一套对外稳定的商品 API，你会反复踩同一批坑：每个上游的入参、鉴权、字段命名都不一样，脏字段悄悄泄漏进对外契约；业务过程天然是命令式的——先取 A、用 A 决定要不要取 B、失败要降级，声明式数据流怎么写都别扭；上游会超时、限流、宕机，「可重试」和「业务性失败」永远分不清；对接的人和业务的人是两拨人，逻辑却缠在一起，谁也不敢动。

omni-relay 的答案是：**卡片化 + IR 键值缓存 + 命令式双钩子**。每个能力都是一张卡片，一次执行围绕一块 IR 展开，治理与执行两个面彻底分离。

- **卡片化对接** —— `defineSource` 封装「连接一个源站 + 清洗为原子字段」，脏字段一律挡在 IR 之外
- **命令式编排** —— `collect` 直读直写 IR、按需 `ctx.invoke` 取数，`respond` 只读构筑出参，过程一眼可见
- **容灾内建** —— 超时、重试、退避、源站切换开箱即用，`retryable` 是切换的唯一信号，业务性失败绝不盲试
- **两侧解耦** —— 对接者只声明能力契约、不知道谁消费；业务卡片按名 `invoke`，各自独立演进、独立版本化
- **服务不断** —— 控制面治理、服务面执行，升级、回滚、卸载都是原子切换，没有下线窗口

## 🚀 快速开始

```bash
pnpm add omni-relay zod
```

用一张 API 卡片声明「怎么连一个源站」：

```ts
const jdItemDetail = defineSource({
  meta: { name: 'jd.item-detail', version: '1.0.0' },
  ref: 'jd/items/detail',                         // 逻辑 ref，物理地址上线时再绑
  input: z.object({ skuId: z.string() }),
  output: z.object({ title: z.string(), priceCents: z.number(), inStock: z.boolean() }),
  upstreamRes: z.object({ item_name: z.string(), price: z.number(), stock: z.number() }),
  take: ({ skuId }) => ({ method: 'GET' as const, path: '/v2/items/:skuId', params: { skuId } }),
  put: (raw) => ({                                // 源站响应 → 原子字段
    title: raw.item_name,
    priceCents: Math.round(raw.price * 100),
    inStock: raw.stock > 0,
  }),
});
```

用一张业务卡片编排它，对外就是稳定的商品 API：

```ts
const skuDetail = defineCard({
  meta: { name: 'product.detail', version: '1.0.0' },
  in: z.object({ sku: z.string() }),
  out: z.object({ name: z.string(), cents: z.number(), available: z.boolean() }),

  collect: async (ctx) => {                       // 取数：直写 IR，按需 invoke
    ctx.ir.skuId = (ctx.input as { sku: string }).sku;
    await ctx.invoke('jd.item-detail');           // 省略入参 → 自动从 IR 提取
  },
  respond: (ctx) => {                             // 构筑：只读 IR
    const jd = ctx.ir['jd.item-detail'] as { title: string; priceCents: number; inStock: boolean };
    return { name: jd.title, cents: jd.priceCents, available: jd.inStock };
  },
});
```

绑定、上线、服务，一气呵成：

```ts
const controller = new RelayController();
controller
  .registerSource('jd/items/detail', {
    baseURL: 'https://api.jd.example.com',
    auth: () => process.env.JD_TOKEN!,            // 惰性取用，凭证不进 IR
  })
  .registerSourceCard(jdItemDetail)
  .registerCard(skuDetail);

const relay = controller.buildRelay();            // 上线门：契约齐备才放行
const out = await relay.handle('product.detail', { sku: 'A1' });
```

要挂到任意 fetch 兼容运行时（Node、Edge、Workers、网关）？一行：

```ts
const handler = relay.toFetchHandler();
```

流式、容灾、测试同样现成：

```ts
// SSE 流式透传 —— 声明 stream: true，流直写、旁路校验、失败自动回收
defineSource({ stream: true, /* ... */ });

// 多源容灾 —— 首个成功即胜出，业务性失败不切换、直接抛出
for (const id of ['endpoint.a', 'endpoint.b']) {
  try { await ctx.invoke(id); return; }
  catch (e) { if (e instanceof GlueError && e.retryable) continue; throw e; }
}

// 离线测试 —— mock 传输，无需真实网络
const src = mockSource('jd/items/detail', { body: { item_name: 'X', price: 9.9, stock: 3 } });
```

> 完整可运行示例见 [`examples/sku-detail/`](./examples/sku-detail)。

## 📦 盒子里有什么

| 能力 | 说明 |
| --- | --- |
| API 卡片 | `defineSource` 声明对接契约：入参提取、请求构建、字段清洗、错误映射，一环不缺 |
| 业务卡片 | `defineCard` 声明商品 API：`collect` / `respond` 双钩子，取数与构筑语义分明 |
| IR 键值缓存 | 贯穿一次执行的公共黑板：seeds 注入、invoke 写回、宿主规则介入面 |
| 契约校验 | 管道 6 个 Zod 校验点，任何一跳失败都收敛为统一 `GlueError`，raw 永不透出 |
| 重试与容灾 | `timeoutMs` / `retry` 策略覆盖，`retryable` 驱动重试与源站切换 |
| 流式透传 | SSE 声明式直通，未声明即拒绝，失败自动 `cancel` 防悬挂 |
| 版本治理 | manifest 交叉校验、版本门禁拒绝旧版误发、原子切换不断服 |
| 管理视图 | `inspectCard` / `listCards` / 治理事件回调，认证材料只留 `hasAuth` 布尔 |
| 测试子入口 | `omni-relay/testing`：mock 传输、单值/序列/函数回放、SSE 回放 |

## 📚 深入了解

- [examples/sku-detail](./examples/sku-detail) —— 完整可运行的端到端示例
- [test](./test) —— 框架自测套件，也是最全的用法示范
- [src/core/types.ts](./src/core/types.ts) —— 全部类型契约，类型即文档

## 🛠️ 开发

```bash
pnpm install     # 安装依赖
pnpm build       # tsdown → dist（ESM + CJS + 类型声明 + sourcemap）
pnpm test        # vitest run
pnpm typecheck   # tsc --noEmit
```

## License

[MIT](./package.json)
