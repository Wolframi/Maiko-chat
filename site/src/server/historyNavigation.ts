import { messageVisibleTo, type MessageVisibility } from "./dmHistory";
import { isThreadMessage } from "./historyPage";

type NavigationMessage = MessageVisibility & {
  id: string; kind?: string; text: string; author?: string; file?: { name: string };
};

export function matchesHistorySearch(message: NavigationMessage, query: string) {
  const q = query.trim().toLowerCase();
  return Boolean(q) && message.kind !== "system" && message.kind !== "call" &&
    [message.text, message.author, message.file?.name].some(value => value?.toLowerCase().includes(q));
}

function anchorIndex<T extends NavigationMessage>(messages: readonly T[], viewerId: string, id: string) {
  const index = messages.findIndex(message => message.id === id && messageVisibleTo(message, viewerId) && isThreadMessage(message));
  if (index < 0) throw new Error("Сообщение недоступно в истории");
  return index;
}

/** Small contiguous window in stored order; never copy the entire thread. */
export function selectHistoryWindow<T extends NavigationMessage>(messages: readonly T[], viewerId: string, id: string) {
  const index = anchorIndex(messages, viewerId, id);
  const older: T[] = [], newer: T[] = [];
  for (let i = index - 1; i >= 0 && older.length < 41; i--) {
    if (messageVisibleTo(messages[i], viewerId) && isThreadMessage(messages[i])) older.push(messages[i]);
  }
  for (let i = index + 1; i < messages.length && newer.length < 41; i++) {
    if (messageVisibleTo(messages[i], viewerId) && isThreadMessage(messages[i])) newer.push(messages[i]);
  }
  const selected = [...older.slice(0, 40).reverse(), messages[index], ...newer.slice(0, 40)];
  return { messages: selected, before: selected[0].id, after: selected.at(-1)!.id, hasMore: older.length > 40, hasNewer: newer.length > 40 };
}

export function selectNewerHistory<T extends NavigationMessage>(messages: readonly T[], viewerId: string, after: string) {
  const index = anchorIndex(messages, viewerId, after);
  const selected: T[] = [];
  for (let i = index + 1; i < messages.length && selected.length < 81; i++) {
    if (messageVisibleTo(messages[i], viewerId) && isThreadMessage(messages[i])) selected.push(messages[i]);
  }
  return { messages: selected.slice(0, 80), after: selected[Math.min(79, selected.length - 1)]?.id ?? after, hasNewer: selected.length > 80 };
}

export function searchHistory<T extends NavigationMessage>(messages: readonly T[], viewerId: string, query: string, after?: string) {
  const start = after ? anchorIndex(messages, viewerId, after) + 1 : 0;
  const ids: string[] = [];
  for (let i = start; i < messages.length && ids.length < 41; i++) {
    if (messageVisibleTo(messages[i], viewerId) && matchesHistorySearch(messages[i], query)) ids.push(messages[i].id);
  }
  return { ids: ids.slice(0, 40), hasMore: ids.length > 40, after: ids[Math.min(39, ids.length - 1)] ?? null };
}
