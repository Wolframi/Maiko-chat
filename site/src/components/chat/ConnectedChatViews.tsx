"use client";

import { memo, type ComponentProps } from "react";
import { useRuntimeState } from "./ChatRuntime";
import { MessageList } from "./MessageList";
import { Composer } from "./Composer";
import { ChatSidebar } from "./ChatSidebar";
import { ServerRail } from "./ServerRail";
import { ChatInfoPanel } from "./ChatInfoPanel";

type ThreadProps = Omit<ComponentProps<typeof MessageList>, "messages" | "historyVersion" | "people" | "account" | "othersTyping" | "loading" | "hasMore" | "hasNewer" | "loadingOlder" | "historyError" | "peerReadAt">;
export const ThreadMessages = memo(function ThreadMessages(props: ThreadProps) {
  const state = useRuntimeState("conversation", ({ messages, historyVersion, othersTyping, historyLoading,
    hasMoreHistory, hasNewerHistory, loadingOlderHistory, historyPageError, peerReadAt }) => ({ messages,
    historyVersion, othersTyping, historyLoading, hasMoreHistory, hasNewerHistory, loadingOlderHistory, historyPageError, peerReadAt }));
  const { account, people } = useRuntimeState("core", state => ({ account: state.account, people: state.people }));
  if (!account) return null;
  return <MessageList {...props} account={account} people={people} messages={state.messages}
    historyVersion={state.historyVersion} othersTyping={state.othersTyping} loading={state.historyLoading}
    hasMore={state.hasMoreHistory} hasNewer={state.hasNewerHistory} loadingOlder={state.loadingOlderHistory}
    historyError={state.historyPageError} peerReadAt={state.peerReadAt} />;
});
ThreadMessages.displayName = "ThreadMessages";

export const ThreadComposer = memo(function ThreadComposer(props: Omit<ComponentProps<typeof Composer>, "disabled" | "error">) {
  const state = useRuntimeState("conversation", state => ({ disabled: state.historyLoading && !state.messages.length, error: state.composerError }));
  return <Composer {...props} {...state} />;
});
ThreadComposer.displayName = "ThreadComposer";

export const ConnectedSidebar = memo(function ConnectedSidebar(props: Omit<ComponentProps<typeof ChatSidebar>, "chats" | "people">) {
  const chats = useRuntimeState("list", state => state.chats);
  const people = useRuntimeState("core", state => state.people);
  return <ChatSidebar {...props} chats={chats} people={people} />;
});
ConnectedSidebar.displayName = "ConnectedSidebar";

export const ConnectedChatInfoPanel = memo(function ConnectedChatInfoPanel(props: Omit<ComponentProps<typeof ChatInfoPanel>, "chat">) {
  const chat = useRuntimeState("list", state => props.open ? state.currentChat : null);
  return <ChatInfoPanel {...props} chat={chat} />;
});

export const ConnectedServerRail = memo(function ConnectedServerRail(props: Omit<ComponentProps<typeof ServerRail>, "groups" | "unreadHome">) {
  const groups = useRuntimeState("list", state => state.chats.filter(chat => chat.type === "group"));
  const unreadHome = useRuntimeState("list", state => state.unreadTotal);
  return <ServerRail {...props} groups={groups} unreadHome={unreadHome} />;
});
