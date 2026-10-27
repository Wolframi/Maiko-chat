export type MessageVisibility = { hiddenFor?: string[] };

export function messageVisibleTo(message: MessageVisibility, userId: string) {
  return !message.hiddenFor?.includes(userId);
}

/** Keep the peer's copy, including media and replies, intact. */
export function hideHistoryFor(messages: MessageVisibility[], userId: string) {
  for (const message of messages) {
    if (messageVisibleTo(message, userId)) {
      message.hiddenFor = [...(message.hiddenFor || []), userId];
    }
  }
}
