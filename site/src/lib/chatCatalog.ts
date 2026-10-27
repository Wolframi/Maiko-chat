import type { ChatInfo } from "./types";
import { shallowEqual } from "./externalStore";

/** Routing and header data; live previews and voice activity belong to the sidebar. */
export type ShellChat = Pick<ChatInfo, "id" | "type" | "title" | "topic" | "members" | "peerId" |
  "avatarUrl" | "createdBy" | "memberIds" | "visibility"> & {
  textChannels?: { id: string; title: string }[];
};

export function createChatCatalogSelector() {
  let cache = new Map<string, { source: ChatInfo; value: ShellChat }>();
  let catalog: ShellChat[] = [];
  return (chats: ChatInfo[]) => {
    const nextCache = new Map<string, { source: ChatInfo; value: ShellChat }>();
    const next = chats.map(chat => {
      const previous = cache.get(chat.id);
      if (previous?.source === chat) {
        nextCache.set(chat.id, previous);
        return previous.value;
      }
      const { id, type, title, topic, members, peerId, avatarUrl, createdBy, visibility } = chat;
      let memberIds = chat.memberIds;
      let textChannels = chat.textChannels?.map(({ id, title }) => ({ id, title }));
      if (previous) {
        if (shallowEqual(previous.value.memberIds, memberIds)) memberIds = previous.value.memberIds;
        if (previous.value.textChannels?.length === textChannels?.length &&
          textChannels?.every((channel, index) => shallowEqual(channel, previous.value.textChannels?.[index]))) {
          textChannels = previous.value.textChannels;
        }
      }
      const projection: ShellChat = { id, type, title, topic, members, peerId, avatarUrl, createdBy, visibility, memberIds, textChannels };
      const value = previous && shallowEqual(previous.value, projection) ? previous.value : projection;
      nextCache.set(id, { source: chat, value });
      return value;
    });
    cache = nextCache;
    if (!shallowEqual(catalog, next)) catalog = next;
    return catalog;
  };
}
