/**
 * 源站 SSE 流原语 — 供上层流加工场景复用（协议适配、事件重排等）
 *
 * sseEvents：源站 SSE 字节流 → 事件对象流（跨 chunk 缓冲、CRLF 兼容、注释行忽略）；
 * parseSseJson：data 帧文本 → JSON 对象（[DONE]/空/非法帧返回 null，调用方跳过）。
 *
 * 仅覆盖源站流式交互实际使用的 SSE 子集（event:/data: 行），不做完整 SSE 规范实现。
 * 知道"怎么解析/重组 SSE 传输形态"属于本框架；具体协议的帧语义（如 OpenAI chunk）
 * 留给上层模块定义。
 */

/** 单个 SSE 事件（data 多行按 \n 连接） */
export interface SseEvent {
  event?: string;
  data: string;
}

const EVENT_BOUNDARY = /\r?\n\r?\n/;

/** 从缓冲中找到首个完整事件块边界；无完整块返回 -1 */
function findEventEnd(buffer: string): number {
  const m = EVENT_BOUNDARY.exec(buffer);
  return m ? (m.index ?? 0) + m[0].length : -1;
}

/** 解析单个事件块文本；空事件（仅注释/空行）返回 null */
function parseEvent(raw: string): SseEvent | null {
  let event: string | undefined;
  const dataLines: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith(':')) continue; // 注释/keep-alive
    if (line.startsWith('event:')) {
      event = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      const v = line.slice(5);
      dataLines.push(v.startsWith(' ') ? v.slice(1) : v);
    }
  }
  if (dataLines.length === 0 && event === undefined) return null;
  return { event, data: dataLines.join('\n') };
}

/** 源站 SSE 字节流 → 事件对象流 */
export function sseEvents(source: ReadableStream<Uint8Array>): ReadableStream<SseEvent> {
  const decoder = new TextDecoder();
  let buffer = '';

  return new ReadableStream<SseEvent>({
    async start(controller) {
      const reader = source.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          for (;;) {
            const end = findEventEnd(buffer);
            if (end < 0) break;
            const ev = parseEvent(buffer.slice(0, end));
            buffer = buffer.slice(end);
            if (ev) controller.enqueue(ev);
          }
        }
        buffer += decoder.decode(); // flush 多字节残缺
        if (buffer.trim().length > 0) {
          const ev = parseEvent(buffer);
          if (ev) controller.enqueue(ev);
        }
      } finally {
        reader.releaseLock();
        source.cancel().catch(() => {});
      }
    },
  });
}

/** 解析 SSE data 帧为 JSON 对象；[DONE]/空/非法 JSON 返回 null（调用方跳过） */
export function parseSseJson(data: string): Record<string, unknown> | null {
  const trimmed = data.trim();
  if (!trimmed || trimmed === '[DONE]') return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed !== null && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
