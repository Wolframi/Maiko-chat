import { messageVisibleTo, type MessageVisibility } from "./dmHistory";

type HistoryMessage = MessageVisibility & { id: string; kind?: string; text: string };

export function isThreadMessage(message: HistoryMessage) {
  return message.kind !== "system" || !/ (в чате|вышел)$/.test(String(message.text || "").trim());
}

/** Cursors follow stored order, including messages with identical timestamps. */
export function selectHistoryPage<T extends HistoryMessage>(
  messages: readonly T[], viewerId: string, before?: string, limit = 80,
) {
  let end = messages.length;
  if (before) {
    end = messages.findIndex(message => message.id === before && messageVisibleTo(message, viewerId));
    if (end < 0) throw new Error("История изменилась. Откройте чат снова.");
  }
  const size = Math.max(1, Math.min(200, Math.floor(limit) || 80));
  const selected: T[] = [];
  let hasMore = false;
  for (let index = end - 1; index >= 0; index--) {
    const message = messages[index];
    if (!messageVisibleTo(message, viewerId) || !isThreadMessage(message)) continue;
    if (selected.length === size) { hasMore = true; break; }
    selected.push(message);
  }
  selected.reverse();
  return { messages: selected, hasMore, before: selected[0]?.id ?? null };
}
