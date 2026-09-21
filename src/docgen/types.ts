import type * as z from 'zod';

/**
 * docgen 层的边界:只把「卡片契约 + 宿主补充信息」生成为 Markdown 字符串。
 * 不写文件、不依赖任何文档框架(Nextra/MDX 等)、不认识 auth 的语义(只原样打印宿主给的字符串)。
 * 装配与页面渲染是宿主的职责,这里只交出稳定的 MD 文本。
 */

/** schemaToFields 的产物:一个字段(含容器自身)的展平描述 */
export interface FieldDoc {
  /** 展示路径:如 `order.no` / `items[].sku`(根字段即裸键名) */
  path: string;
  /** 叶子键名(用于 hideFields 命中判定) */
  name: string;
  /** 紧凑类型标签:string / integer / string / null / object / string[] / IN / OUT / any */
  type: string;
  /** 是否必填 */
  required: boolean;
  /** 字段说明(来自 `.describe()`) */
  description?: string;
  /** 枚举取值(来自 enum / const;已并入 type 标签,此处另存一份供宿主自取) */
  enumValues?: string[];
  /** 示例(来自 `.meta({ examples })`,取首个) */
  example?: unknown;
  /** 嵌套深度(根字段为 0) */
  depth: number;
}

/** 字段表渲染选项 */
export interface FieldTableOptions {
  /** 覆盖表头列名 */
  headers?: { field?: string; type?: string; required?: string; description?: string };
  /** 必填/可选标记(默认 ✅ / —) */
  requiredMark?: string;
  optionalMark?: string;
  /** 是否在说明列内联展示示例(默认 true) */
  showExamples?: boolean;
}

/** 错误速查行 */
export interface ErrorRow {
  status: number | string;
  scenario: string;
}

/** 单个端点的文档规格:card 与 request/response 二选一(card 自动反射其契约) */
export interface EndpointDoc {
  /** 小节标题(默认取卡片名,再退到 path) */
  title?: string;
  /** HTTP 方法(宿主给,框架不推断) */
  method: string;
  /** 对外端点路径(宿主给,框架不推断) */
  path: string;
  /** 端点说明段落 */
  description?: string;
  /** 鉴权标签:宿主自定义字符串(如 `session` / `product` / `public`),docgen 只原样打印 */
  auth?: string;
  /** 直接传 defineCard / defineSource 产物:自动取 in/out(业务卡)或 input/output(源站卡) */
  card?: unknown;
  /** 显式覆盖请求 schema(优先于 card) */
  request?: z.ZodType;
  /** 显式覆盖响应 schema(优先于 card) */
  response?: z.ZodType;
  /** 请求体示例对象 */
  requestExample?: unknown;
  /** 响应体示例对象 */
  responseExample?: unknown;
  /** 错误速查 */
  errors?: ErrorRow[];
  /** 备注(以引用块逐行呈现) */
  notes?: string[];
  /** 敏感字段的叶子名:表中打码标注,示例中值替换为 `***` */
  hideFields?: string[];
}

/** renderEndpoint / renderEndpoints 的选项 */
export interface RenderOptions {
  /** 成功响应状态码标注(默认 200) */
  successStatus?: number;
  /** 标题层级(默认 2,即 `##` / `###`) */
  headingLevel?: number;
  /** 字段表选项,请求/响应共用 */
  fieldTable?: FieldTableOptions;
}
