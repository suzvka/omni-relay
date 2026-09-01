/**
 * 流式透传的运行时判定工具。
 * 泛型在运行时擦除,以 instanceof 统一识别 transport 产物 / 总线分区 / 商品出参中的流。
 */
export function isReadableStream(value: unknown): value is ReadableStream<Uint8Array> {
  return typeof ReadableStream !== 'undefined' && value instanceof ReadableStream;
}
