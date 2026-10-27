"use client";

import { createContext, memo, useContext, useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from "react";
import { useChat } from "@/hooks/useChat";
import { useCall } from "@/hooks/useCall";
import { useVoiceChannel } from "@/hooks/useVoiceChannel";
import { useStoreSelector } from "@/hooks/useStoreSelector";
import { createExternalStore, shallowEqual, type ExternalStore } from "@/lib/externalStore";
import { collectRoomAudioTracks, setRoomAudioTracks } from "@/lib/audioPlayback";
import { createChatCatalogSelector } from "@/lib/chatCatalog";

export type ChatApi = ReturnType<typeof useChat>;
export type CallApi = ReturnType<typeof useCall>;
export type VoiceApi = ReturnType<typeof useVoiceChannel>;
type Conversation = Pick<ChatApi, "messages" | "historyLoading" | "historyVersion" | "hasMoreHistory" | "hasNewerHistory" | "loadingOlderHistory" | "historyPageError" | "othersTyping" | "peerReadAt" | "composerError">;
type ChatList = Pick<ChatApi, "chats" | "currentChat" | "unreadTotal">;
type ChatCore = Omit<ChatApi, keyof Conversation | keyof ChatList>;
type RuntimeState = { core: ChatCore; conversation: Conversation; list: ChatList; call: CallApi; voice: VoiceApi };
type RuntimeStores = { [K in keyof RuntimeState]: ExternalStore<RuntimeState[K] | null> };
const RuntimeContext = createContext<RuntimeStores | null>(null);
const identity = <T,>(value: T) => value;

export function useChatRuntime() {
  const stores = useContext(RuntimeContext);
  if (!stores) throw new Error("ChatRuntimeProvider is missing");
  return stores;
}

export function useRuntimeState<K extends keyof RuntimeState, S>(key: K, selector: (value: RuntimeState[K]) => S): S {
  const stores = useChatRuntime();
  // Readiness is checked before mounting consumers. Runtime drivers use nullable selectors below.
  return useStoreSelector<RuntimeState[K] | null, S>(stores[key], value => {
    if (!value) throw new Error(`Chat runtime ${key} is not ready`);
    return selector(value);
  }, shallowEqual);
}

export function useChatShell() {
  const core = useRuntimeState("core", identity);
  const selectCatalog = useMemo(() => {
    const select = createChatCatalogSelector();
    return (state: ChatList) => select(state.chats);
  }, []);
  const chats = useRuntimeState("list", selectCatalog);
  const currentChatId = useRuntimeState("list", state => state.currentChat?.id ?? null);
  const unreadTotal = useRuntimeState("list", state => state.unreadTotal);
  const currentChat = useMemo(() => chats.find(chat => chat.id === currentChatId) ?? null, [chats, currentChatId]);
  const historyLoading = useRuntimeState("conversation", state => state.historyLoading);
  return { ...core, chats, currentChat, unreadTotal, historyLoading };
}

export function useCallShell() {
  return useRuntimeState("call", state => {
    const { incoming, active, cameraOff, sharingScreen, remoteSharingScreen, remoteCameraOff, minimized,
      startCall, rejectCall, endCall, setMinimized } = state;
    return { incoming, active, cameraOff, sharingScreen, remoteSharingScreen, remoteCameraOff, minimized,
      startCall, rejectCall, endCall, setMinimized };
  });
}

export function useVoiceShell() {
  return useRuntimeState("voice", state => {
    const { active, joining, minimized, error, join, leave, setMinimized, clearError, cameraOff, sharingScreen } = state;
    return { active, joining, minimized, error, join, leave, setMinimized, clearError, cameraOff, sharingScreen,
      hasRemoteScreen: state.peers.some(peer => peer.sharingScreen),
      hasRemoteCamera: state.peers.some(peer => !peer.cameraOff && !peer.sharingScreen) };
  });
}

const ChatDriver = memo(function ChatDriver({ stores }: { stores: RuntimeStores }) {
  const api = useChat();
  useLayoutEffect(() => {
    const { messages, historyLoading, historyVersion, hasMoreHistory, hasNewerHistory, loadingOlderHistory,
      historyPageError, othersTyping, peerReadAt, composerError, chats, currentChat, unreadTotal, ...core } = api;
    stores.core.publish(core);
    stores.list.publish({ chats, currentChat, unreadTotal });
    stores.conversation.publish({ messages, historyLoading, historyVersion, hasMoreHistory, hasNewerHistory,
      loadingOlderHistory, historyPageError, othersTyping, peerReadAt, composerError });
  });
  useEffect(() => {
    if (api.session?.room) setRoomAudioTracks(api.session.room, collectRoomAudioTracks(api.messages));
  }, [api.messages, api.session?.room]);
  return null;
});

const CallDriver = memo(function CallDriver({ stores }: { stores: RuntimeStores }) {
  const session = useStoreSelector(stores.core, state => ({ socket: state?.socket ?? null, selfId: state?.account?.userId,
    token: state?.account?.token, onLog: state?.logCall }), shallowEqual);
  const api = useCall(session);
  useLayoutEffect(() => { stores.call.publish(api); });
  return null;
});

const VoiceDriver = memo(function VoiceDriver({ stores }: { stores: RuntimeStores }) {
  const session = useStoreSelector(stores.core, state => ({ socket: state?.socket ?? null, selfId: state?.account?.userId,
    selfName: state?.account?.displayName || state?.account?.username, token: state?.account?.token }), shallowEqual);
  const callBusy = useStoreSelector(stores.call, state => Boolean(state?.active || state?.incoming));
  const api = useVoiceChannel({ ...session, callBusy });
  useLayoutEffect(() => { stores.voice.publish(api); });
  return null;
});

export function ChatRuntimeProvider({ children }: { children: ReactNode }) {
  const [stores] = useState<RuntimeStores>(() => ({
    core: createExternalStore<ChatCore | null>(null, shallowEqual),
    conversation: createExternalStore<Conversation | null>(null, shallowEqual),
    list: createExternalStore<ChatList | null>(null, shallowEqual),
    call: createExternalStore<CallApi | null>(null, shallowEqual),
    voice: createExternalStore<VoiceApi | null>(null, shallowEqual),
  }));
  return <RuntimeContext.Provider value={stores}>
    <ChatDriver stores={stores} /><CallDriver stores={stores} /><VoiceDriver stores={stores} />{children}
  </RuntimeContext.Provider>;
}

export function ChatRuntimeReady({ children }: { children: ReactNode }) {
  const stores = useChatRuntime();
  const core = useStoreSelector(stores.core, Boolean), list = useStoreSelector(stores.list, Boolean);
  const conversation = useStoreSelector(stores.conversation, Boolean);
  const call = useStoreSelector(stores.call, Boolean), voice = useStoreSelector(stores.voice, Boolean);
  return core && list && conversation && call && voice ? children : <div className="boot" aria-label="Загрузка Майко" />;
}
