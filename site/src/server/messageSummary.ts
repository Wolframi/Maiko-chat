import { messageVisibleTo, type MessageVisibility } from "./dmHistory";

type SummaryMessage = MessageVisibility & {
  kind?: string;
  authorId?: string;
  createdAt: number;
};

/** Compute sidebar metadata without copying, reversing or filtering the history. */
export function summarizeMessages<T extends SummaryMessage>(
  messages: readonly T[],
  viewerId: string,
  readAt = 0,
) {
  let count = 0;
  let unreadCount = 0;
  let last: T | undefined;
  for (const message of messages) {
    if (message.kind === "system" || !messageVisibleTo(message, viewerId)) continue;
    count++;
    last = message;
    if (message.createdAt > readAt && message.authorId !== viewerId) unreadCount++;
  }
  return { count, unreadCount, last };
}
