import type { ChatInfo, ChatMessage } from "./types";

export function applyChatUpdate(chats: ChatInfo[], chatId: string, chat: ChatInfo | null) {
  const exists = chats.some(item => item.id === chatId);
  const next = chat ? chats.map(item => item.id === chatId ? chat : item) : chats.filter(item => item.id !== chatId);
  if (chat && !exists) next.push(chat);
  return next.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return (b.lastMessage?.createdAt ?? b.createdAt) - (a.lastMessage?.createdAt ?? a.createdAt);
  });
}

/** Keep newer live edits/optimistic bubbles if a history response overlaps them. */
export function prependHistory(older: ChatMessage[], current: ChatMessage[]) {
  const known = new Set(current.map(message => message.id));
  return [...older.filter(message => !known.has(message.id)), ...current];
}
