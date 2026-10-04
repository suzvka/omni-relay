/**
 * omni-relay/docgen:把卡片契约生成接口描述的 Markdown 字符串。
 * 纯文本产出,不写盘、不绑定任何文档框架;页面装配与渲染由宿主负责。
 */
export { schemaToFields } from './fields';
export type { SchemaToFieldsOptions } from './fields';
export {
  renderFieldTable,
  renderJsonExample,
  renderEndpoint,
  renderEndpoints,
  cardDocOf,
  hasCardDoc,
  endpointDocWithCard,
  renderCardDoc,
  DOCGEN_LABELS,
} from './render';
export type {
  FieldDoc,
  ErrorRow,
  EndpointDoc,
  RenderOptions,
  CardDoc,
  EndpointFacts,
} from './types';
