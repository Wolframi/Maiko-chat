"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, MotionConfig } from "motion/react";
import { defaultTransition, easeOutSoft, softSpring } from "@/lib/motion";
import { useChat } from "@/hooks/useChat";
import { useCall } from "@/hooks/useCall";
import { useVoiceChannel } from "@/hooks/useVoiceChannel";
import { JoinGate } from "@/components/chat/JoinGate";
import { JoinBackdrop } from "@/components/chat/JoinBackdrop";
import { Composer } from "@/components/chat/Composer";
import { ChatSidebar } from "@/components/chat/ChatSidebar";
import { ServerRail, type RailFocus } from "@/components/chat/ServerRail";
import { GuildMemberList } from "@/components/chat/GuildMemberList";
import { CallOverlay } from "@/components/chat/CallOverlay";
import { VoiceOverlay } from "@/components/chat/VoiceOverlay";
import { VoiceDock } from "@/components/chat/VoiceDock";
import { ProfilePanel } from "@/components/chat/ProfilePanel";
import { ChatInfoPanel } from "@/components/chat/ChatInfoPanel";
import { MessageList } from "@/components/chat/MessageList";
import { AudioPlaybackBar } from "@/components/chat/AudioPlaybackBar";
import dynamic from "next/dynamic";
import { Avatar } from "@/components/chat/Avatar";
import {
  collectRoomAudioTracks,
  setRoomAudioTracks,
  stopAudioPlayback,
} from "@/lib/audioPlayback";

const MediaLightbox = dynamic(
  () => import("@/components/chat/ImageLightbox").then((mod) => mod.MediaLightbox),
  { ssr: false }
);
import {
  IconChevronDown,
  IconChevronUp,
  IconClose,
  IconHash,
  IconImage,
  IconLogout,
  IconMenu,
  IconTrash,
  IconMic,
  IconMicOff,
  IconMore,
  IconPhone,
  IconSearch,
  IconUsers,
} from "@/lib/icons";
import { ConfirmDialog } from "@/components/chat/ConfirmDialog";
import type { ChatMessage, RoomMediaItem } from "@/lib/types";
import { isImageAttachment, isVideoAttachment, albumPreviewText } from "@/lib/files";
import { formatLastSeen } from "@/lib/notify";
import { isChatMuted, toggleChatMuted } from "@/lib/mute";
import { flushPendingBootReload } from "@/lib/liveReload";
import { peekLastRoom, peekMediaResume, saveLastRoom } from "@/lib/mediaResume";
import { getSavedRingtone, prefetchRingtone } from "@/lib/ringtone";
import { Toaster, toast } from "sonner";

type SidebarPanel = RailFocus;

type ReplyDraft = {
  id: string;
  author: string;
  text: string;
};

export function ChatApp() {
  const {
    socket,
    connected,
    authReady,
    account,
    session,
    messages,
    historyLoading,
    online,
    chats,
    people,
    currentChat,
    othersTyping,
    unreadTotal,
    authError,
    sidebarError,
    composerError,
    profileError,
    register,
    login,
    logout,
    updateProfile,
    uploadAvatar,
    openChat,
    openDm,
    createGroup,
    joinPublicGroup,
    inviteToGroup,
    respondGroupInvite,
    createVoiceChannel,
    deleteVoiceChannel,
    updateGroupAvatar,
    updateGroupProfile,
    updateGroupVisibility,
    fetchRoomMedia,
    searchPeople,
    suggestPeople,
    searchPublicGroups,
    leave,
    sendMessage,
    retryMessage,
    discardMessage,
    deleteMessage,
    editMessage,
    forwardMessage,
    markChatVisibleRead,
    peerReadAt,
    chatMembers,
    deleteGroup,
    leaveGroup,
    sendFiles,
    cancelUpload,
    logCall,
    markAllRead,
    reactToMessage,
    setTyping,
    clearComposerError,
    clearProfileError,
  } = useChat();

  const {
    incoming,
    active,
    localStream,
    remoteStream,
    muted,
    deafened,
    cameraOff,
    sharingScreen,
    mediaBusy,
    remoteSharingScreen,
    remoteCameraOff,
    minimized,
    status,
    durationLabel,
    networkQuality,
    localSpeaking,
    remoteSpeaking,
    remoteAudioRef,
    noiseFilterEnabled,
    noiseFilterKind,
    startCall,
    acceptCall,
    rejectCall,
    endCall,
    toggleMute,
    toggleDeafen,
    toggleNoiseFilter,
    toggleCamera,
    toggleScreenShare,
    setMinimized,
  } = useCall({
    socket,
    selfId: account?.userId,
    token: account?.token,
    onLog: logCall,
  });

  const voice = useVoiceChannel({
    socket,
    selfId: account?.userId,
    selfName: account?.displayName || account?.username,
    token: account?.token,
    callBusy: Boolean(active || incoming),
  });
  const leaveVoice = voice.leave;
  const joinVoice = voice.join;
  const voiceError = voice.error;
  const clearVoiceError = voice.clearError;

  const handleLogout = useCallback(() => {
    stopAudioPlayback();
    leaveVoice();
    if (incoming) rejectCall();
    if (active) endCall();
    logout();
  }, [active, endCall, incoming, leaveVoice, logout, rejectCall]);

  useEffect(() => {
    if (!voiceError) return;
    toast.error(voiceError);
    clearVoiceError();
  }, [clearVoiceError, voiceError]);

  useEffect(() => {
    prefetchRingtone(getSavedRingtone()?.url);
  }, []);

  const searchRef = useRef<HTMLInputElement>(null);
  const wasOfflineRef = useRef(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [chatInfoOpen, setChatInfoOpen] = useState(false);
  const [membersOpen, setMembersOpen] = useState(false);
  const [groupAvatarBusy, setGroupAvatarBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [savingProfile, setSavingProfile] = useState(false);
  const [sidebarPanel, setSidebarPanel] = useState<SidebarPanel>("home");
  const [replyTo, setReplyTo] = useState<ReplyDraft | null>(null);
  const [editingMessage, setEditingMessage] = useState<ChatMessage | null>(null);
  const [forwardMessageTarget, setForwardMessageTarget] =
    useState<ChatMessage | null>(null);
  const [lightbox, setLightbox] = useState<{
    src: string;
    name: string;
    kind: "image" | "video";
  } | null>(null);
  const [flashOnline, setFlashOnline] = useState(false);
  const [roomSearchOpen, setRoomSearchOpen] = useState(false);
  const [roomSearch, setRoomSearch] = useState("");
  const [matchIndex, setMatchIndex] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmDeleteGroup, setConfirmDeleteGroup] = useState(false);
  const [confirmLeaveGroup, setConfirmLeaveGroup] = useState(false);
  const [unreadAtOpen, setUnreadAtOpen] = useState(0);
  const [chatMuted, setChatMuted] = useState(false);
  const [mutedVersion, setMutedVersion] = useState(0);
  const [pendingTitle, setPendingTitle] = useState<string | null>(null);
  const replyDraftsRef = useRef(new Map<string, ReplyDraft | null>());
  const pendingAudioJumpRef = useRef<{ roomId: string; messageId: string } | null>(
    null,
  );

  useEffect(() => {
    setChatMuted(session?.room ? isChatMuted(session.room) : false);
  }, [session?.room, mutedVersion]);

  useEffect(() => {
    setSidebarOpen(false);
    setRoomSearch("");
    setRoomSearchOpen(false);
    setMatchIndex(0);
    setMenuOpen(false);
    setChatInfoOpen(false);

    const room = session?.room;
    if (!room) {
      setReplyTo(null);
      return;
    }
    setReplyTo(replyDraftsRef.current.get(room) ?? null);
  }, [session?.room]);

  const setReplyDraft = useCallback(
    (draft: ReplyDraft | null) => {
      const room = session?.room;
      if (room) replyDraftsRef.current.set(room, draft);
      setReplyTo(draft);
    },
    [session?.room],
  );

  const handleOpenChat = useCallback(
    (chatId: string) => {
      const chat = chats.find((item) => item.id === chatId);
      setPendingTitle(
        chat
          ? chat.type === "channel"
            ? `#${chat.title}`
            : chat.title
          : null,
      );
      setUnreadAtOpen(chat?.unreadCount || 0);
      if (chat?.type === "group") {
        setSidebarPanel(chatId);
        saveLastRoom(chatId, chatId);
      } else {
        saveLastRoom(chatId, "home");
      }
      openChat(chatId);
    },
    [chats, openChat],
  );

  const triedResumeKeyRef = useRef<string | null>(null);
  const restoreRoomRef = useRef<string | null>(null);
  const restoreTriesRef = useRef(0);
  const restoredOnceRef = useRef(false);
  useEffect(() => {
    if (!authReady || !account || !connected) return;
    if (restoredOnceRef.current) return;
    restoredOnceRef.current = true;
    const resume = peekMediaResume();
    const last = peekLastRoom();
    const chatId =
      resume?.kind === "voice"
        ? resume.groupId
        : resume?.kind === "call"
          ? resume.chatId
          : last?.chatId;
    if (!chatId) return;
    restoreRoomRef.current = chatId;
    if (resume?.kind === "voice") {
      setSidebarPanel(resume.groupId);
      setSidebarOpen(true);
      setPendingTitle(resume.title);
    } else if (resume?.kind === "call") {
      setSidebarPanel("home");
      setSidebarOpen(true);
      setPendingTitle(resume.peerName);
    } else if (last?.panel && last.panel !== "home") {
      setSidebarPanel(last.panel);
    }
    handleOpenChat(chatId);
  }, [account, authReady, connected, handleOpenChat]);

  useEffect(() => {
    const target = restoreRoomRef.current;
    if (!target || !connected || !authReady) return;
    if (session?.room === target) {
      restoreRoomRef.current = null;
      restoreTriesRef.current = 0;
      return;
    }
    if (restoreTriesRef.current >= 12) {
      restoreRoomRef.current = null;
      return;
    }
    const timer = window.setTimeout(() => {
      restoreTriesRef.current += 1;
      handleOpenChat(target);
    }, 500);
    return () => window.clearTimeout(timer);
  }, [authReady, chats, connected, handleOpenChat, session?.room]);

  const wasConnectedRef = useRef(false);
  useEffect(() => {
    if (!connected) {
      wasConnectedRef.current = false;
      return;
    }
    const justReconnected = !wasConnectedRef.current;
    wasConnectedRef.current = true;
    if (!authReady || !account) return;
    const resume = peekMediaResume();
    if (!resume) return;
    const key =
      resume.kind === "voice"
        ? `voice:${resume.channelId}`
        : `call:${resume.peerId}:${resume.chatId}`;
    if (!justReconnected && triedResumeKeyRef.current === key) return;
    triedResumeKeyRef.current = key;

    if (resume.kind === "voice") {
      setSidebarPanel(resume.groupId);
      setSidebarOpen(true);
      setPendingTitle(resume.title);
      restoreRoomRef.current = resume.groupId;
      handleOpenChat(resume.groupId);
      voice.setMinimized(false);
      void joinVoice(resume.channelId, resume.groupId, resume.title);
      return;
    }
    if (active || incoming) return;
    setSidebarPanel("home");
    setSidebarOpen(true);
    setPendingTitle(resume.peerName);
    restoreRoomRef.current = resume.chatId;
    handleOpenChat(resume.chatId);
    setMinimized(false);
    void startCall(resume.peerId, resume.peerName, resume.mode, resume.chatId, {
      reconnect: true,
    });
  }, [
    account,
    active,
    authReady,
    connected,
    handleOpenChat,
    incoming,
    joinVoice,
    setMinimized,
    startCall,
    voice.setMinimized,
  ]);

  useEffect(() => {
    if (active || incoming || voice.active) return;
    const timer = window.setTimeout(() => flushPendingBootReload(), 800);
    return () => window.clearTimeout(timer);
  }, [active, incoming, voice.active]);

  useEffect(() => {
    function onNotifyOpen(event: Event) {
      const chatId = (event as CustomEvent<{ chatId?: string }>).detail?.chatId;
      if (!chatId) return;
      handleOpenChat(chatId);
    }
    function onSwMessage(event: MessageEvent) {
      const data = event.data as { type?: string; chatId?: string } | null;
      if (!data || data.type !== "pulse:open-chat" || !data.chatId) return;
      handleOpenChat(data.chatId);
    }
    window.addEventListener("pulse:open-chat", onNotifyOpen);
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.addEventListener("message", onSwMessage);
    }
    return () => {
      window.removeEventListener("pulse:open-chat", onNotifyOpen);
      if ("serviceWorker" in navigator) {
        navigator.serviceWorker.removeEventListener("message", onSwMessage);
      }
    };
  }, [handleOpenChat]);

  const handleToggleMute = useCallback(
    (chatId: string) => {
      const next = toggleChatMuted(chatId);
      setMutedVersion((value) => value + 1);
      if (session?.room === chatId) setChatMuted(next);
      toast(next ? "Чат без звука" : "Звук чата включён");
    },
    [session?.room, toast],
  );

  const handleOpenDm = useCallback(
    (userId: string) => {
      const existing = chats.find(
        (chat) => chat.type === "dm" && chat.peerId === userId,
      );
      const person =
        people.find((user) => user.id === userId) ||
        chatMembers.find((user) => user.id === userId);
      setPendingTitle(
        existing?.title ||
          person?.displayName ||
          person?.username ||
          "Личные сообщения",
      );
      setUnreadAtOpen(existing?.unreadCount || 0);
      // Leave guild sidebar (#general / voice) — show DM inbox instead.
      setSidebarPanel("home");
      setMembersOpen(false);
      openDm(userId);
    },
    [chats, chatMembers, openDm, people],
  );

  const [pendingGuildPanel, setPendingGuildPanel] = useState<string | null>(
    null,
  );

  const handleCreateGroup = useCallback(
    async (title: string, topic: string, visibility: "public" | "private") => {
      setPendingTitle(title.trim() || "Группа");
      setUnreadAtOpen(0);
      const result = await createGroup(title, topic, visibility);
      if (!result.ok) {
        toast.error(result.error || "Не удалось создать группу");
        return result;
      }
      if (result.room) setPendingGuildPanel(result.room);
      return result;
    },
    [createGroup],
  );

  useEffect(() => {
    if (currentChat) setPendingTitle(null);
  }, [currentChat]);

  useEffect(() => {
    function syncViewport() {
      const height = window.visualViewport?.height ?? window.innerHeight;
      document.documentElement.style.setProperty(
        "--app-height",
        `${Math.round(height)}px`,
      );
    }
    syncViewport();
    window.visualViewport?.addEventListener("resize", syncViewport);
    window.addEventListener("resize", syncViewport);
    return () => {
      window.visualViewport?.removeEventListener("resize", syncViewport);
      window.removeEventListener("resize", syncViewport);
    };
  }, []);

  useEffect(() => {
    let startX = 0;
    let startY = 0;

    function onTouchStart(event: TouchEvent) {
      const touch = event.touches[0];
      if (!touch) return;
      startX = touch.clientX;
      startY = touch.clientY;
    }

    function onTouchEnd(event: TouchEvent) {
      if (window.innerWidth > 920) return;
      const touch = event.changedTouches[0];
      if (!touch) return;
      const dx = touch.clientX - startX;
      const dy = touch.clientY - startY;
      if (Math.abs(dy) > 48) return;
      if (!sidebarOpen && startX <= 28 && dx > 56) {
        setSidebarOpen(true);
        return;
      }
      if (sidebarOpen && dx < -56) setSidebarOpen(false);
    }

    window.addEventListener("touchstart", onTouchStart, { passive: true });
    window.addEventListener("touchend", onTouchEnd, { passive: true });
    return () => {
      window.removeEventListener("touchstart", onTouchStart);
      window.removeEventListener("touchend", onTouchEnd);
    };
  }, [sidebarOpen]);

  useEffect(() => {
    if (!connected) {
      wasOfflineRef.current = true;
      return;
    }
    if (!wasOfflineRef.current) return;
    wasOfflineRef.current = false;
    setFlashOnline(true);
    const timer = window.setTimeout(() => setFlashOnline(false), 1800);
    return () => window.clearTimeout(timer);
  }, [connected]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSidebarOpen(true);
        setSidebarPanel("home");
        window.setTimeout(() => searchRef.current?.focus(), 40);
        return;
      }

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
        if (!session) return;
        event.preventDefault();
        setRoomSearchOpen(true);
        return;
      }

      if (event.key !== "Escape") return;

      if (chatInfoOpen) {
        setChatInfoOpen(false);
        return;
      }
      if (membersOpen) {
        setMembersOpen(false);
        return;
      }
      if (menuOpen) {
        setMenuOpen(false);
        return;
      }
      if (roomSearchOpen) {
        setRoomSearchOpen(false);
        setRoomSearch("");
        return;
      }
      if (sidebarOpen) {
        setSidebarOpen(false);
        return;
      }
      if (replyTo) {
        setReplyDraft(null);
        return;
      }
      if (lightbox) setLightbox(null);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    session,
    chatInfoOpen,
    membersOpen,
    menuOpen,
    roomSearchOpen,
    sidebarOpen,
    replyTo,
    lightbox,
    setReplyDraft,
    toast,
  ]);

  const peer = useMemo(
    () =>
      currentChat?.peerId
        ? people.find((user) => user.id === currentChat.peerId) ?? null
        : null,
    [currentChat?.peerId, people],
  );

  const chatLabel =
    currentChat?.type === "channel"
      ? `#${currentChat.title}`
      : currentChat?.type === "group"
        ? "#general"
        : currentChat?.title || pendingTitle || "Pulse";

  const subtitle = !session
    ? connected
      ? "подключено"
      : ""
    : currentChat?.type === "dm"
      ? peer?.online
        ? peer.bio?.trim() || "в сети"
        : formatLastSeen(peer?.lastSeenAt)
      : currentChat?.topic || "Группа";

  const canCall = Boolean(
    session && currentChat?.type === "dm" && currentChat.peerId,
  );
  const peerOnline = Boolean(peer?.online);

  const handleSendFiles = useCallback(
    async (
      files: File[],
      options?: {
        caption?: string;
        replyToId?: string;
        onProgress?: (ratio: number) => void;
      },
    ) => {
      setUploading(true);
      setUploadProgress(0);
      try {
        const result = await sendFiles(files, {
          caption: options?.caption,
          replyToId: options?.replyToId,
          onProgress: (ratio) => {
            setUploadProgress(ratio);
            options?.onProgress?.(ratio);
          },
        });
        if (result.ok) setReplyDraft(null);
        return result;
      } finally {
        setUploading(false);
        setUploadProgress(0);
      }
    },
    [sendFiles, setReplyDraft],
  );

  const handleSaveProfile = useCallback(
    async (patch: {
      displayName: string;
      bio: string;
      avatarUrl?: string | null;
    }) => {
      setSavingProfile(true);
      try {
        return await updateProfile(patch);
      } finally {
        setSavingProfile(false);
      }
    },
    [updateProfile],
  );

  const openPeople = useCallback(() => {
    setSidebarPanel("dms");
    setSidebarOpen(true);
  }, []);

  const groups = useMemo(
    () => chats.filter((chat) => chat.type === "group"),
    [chats],
  );

  const selectHome = useCallback(() => {
    setSidebarPanel("home");
    setSidebarOpen(true);
    setMembersOpen(false);
    setChatInfoOpen(false);
    // Leave group text room so the right members rail / group header disappear.
    if (currentChat?.type === "group") {
      leave();
    }
  }, [currentChat?.type, leave]);

  const selectDms = useCallback(() => {
    setSidebarPanel("dms");
    setSidebarOpen(true);
    setMembersOpen(false);
    setChatInfoOpen(false);
    if (currentChat?.type === "group") {
      leave();
    }
  }, [currentChat?.type, leave]);

  const selectGroup = useCallback(
    (groupId: string) => {
      setSidebarPanel(groupId);
      setSidebarOpen(true);
      handleOpenChat(groupId);
    },
    [handleOpenChat],
  );

  const selectCreate = useCallback(() => {
    setSidebarPanel("create");
    setSidebarOpen(true);
  }, []);

  useEffect(() => {
    const room = session?.room;
    if (!room) return;
    const chat = chats.find((item) => item.id === room);
    if (chat?.type === "group" && sidebarPanel === "create") {
      setSidebarPanel(room);
    }
  }, [session?.room, chats, sidebarPanel]);

  // After join/create: open guild sidebar only once the group is in chats.
  useEffect(() => {
    if (!pendingGuildPanel) return;
    if (!chats.some((chat) => chat.id === pendingGuildPanel)) return;
    setSidebarPanel(pendingGuildPanel);
    setPendingGuildPanel(null);
  }, [chats, pendingGuildPanel]);

  const handleReply = useCallback(
    (message: ChatMessage) => {
      const file = message.file;
      let text = message.text;
      if (message.kind === "file" && file) {
        if (message.files && message.files.length > 1) {
          text = albumPreviewText(message.files, message.text);
        } else if (isImageAttachment(file)) text = "Фото";
        else if (isVideoAttachment(file)) text = "Видео";
        else text = `Файл: ${file.name || message.text}`;
      }
      setReplyDraft({
        id: message.id,
        author: message.author,
        text,
      });
    },
    [setReplyDraft],
  );

  const handleOpenImage = useCallback(
    (src: string, name: string, kind: "image" | "video" = "image") => {
      // Bust stale HEVC cache after server converts phone videos to H.264.
      const openSrc =
        kind === "video"
          ? `${src}${src.includes("?") ? "&" : "?"}v=${Date.now()}`
          : src;
      setLightbox({ src: openSrc, name, kind });
    },
    [],
  );

  const canEditGroupAvatar = Boolean(
    account &&
      currentChat &&
      (currentChat.type === "group" || currentChat.type === "channel") &&
      currentChat.createdBy &&
      currentChat.createdBy === account.userId,
  );

  const canEditGroupProfile = Boolean(
    account &&
      currentChat &&
      currentChat.type === "group" &&
      currentChat.createdBy === account.userId &&
      currentChat.id !== "lobby" &&
      currentChat.id !== "random",
  );

  const canDeleteGroup = Boolean(
    account &&
      currentChat &&
      currentChat.type === "group" &&
      currentChat.createdBy &&
      currentChat.createdBy === account.userId &&
      currentChat.id !== "lobby" &&
      currentChat.id !== "random",
  );

  const canLeaveGroup = Boolean(
    account &&
      currentChat &&
      currentChat.type === "group" &&
      currentChat.id !== "lobby" &&
      currentChat.id !== "random" &&
      currentChat.memberIds?.includes(account.userId) &&
      currentChat.createdBy !== account.userId,
  );

  const canModerateMessages = Boolean(
    account &&
      currentChat &&
      currentChat.type === "group" &&
      currentChat.createdBy === account.userId,
  );

  const showChatInfo = Boolean(
    currentChat &&
      (currentChat.type === "group" || currentChat.type === "channel"),
  );

  const showMemberRail = Boolean(
    account &&
      currentChat &&
      currentChat.type === "group" &&
      sidebarPanel === currentChat.id,
  );

  const handleOpenChatInfo = useCallback(() => {
    if (!showChatInfo) return;
    setMenuOpen(false);
    setMembersOpen(false);
    setChatInfoOpen(true);
  }, [showChatInfo]);

  const handleOpenMembers = useCallback(() => {
    if (!showMemberRail) return;
    setMenuOpen(false);
    setChatInfoOpen(false);
    setMembersOpen(true);
  }, [showMemberRail]);

  useEffect(() => {
    setMembersOpen(false);
  }, [currentChat?.id]);

  const handleFetchRoomMedia = useCallback(
    (kind: "media" | "file", offset: number) => {
      if (!currentChat?.id) {
        return Promise.resolve({
          items: [] as RoomMediaItem[],
          total: 0,
          hasMore: false,
          error: "Чат не выбран",
        });
      }
      return fetchRoomMedia(currentChat.id, kind, offset, 48);
    },
    [currentChat?.id, fetchRoomMedia],
  );

  const handleSaveGroupAvatar = useCallback(
    async (avatarUrl: string | null) => {
      if (!currentChat?.id) return false;
      setGroupAvatarBusy(true);
      try {
        return await updateGroupAvatar(currentChat.id, avatarUrl);
      } finally {
        setGroupAvatarBusy(false);
      }
    },
    [currentChat?.id, updateGroupAvatar],
  );

  const handleSaveGroupProfile = useCallback(
    async (patch: { title?: string; topic?: string }) => {
      if (!currentChat?.id) return false;
      setGroupAvatarBusy(true);
      try {
        return await updateGroupProfile(currentChat.id, patch);
      } finally {
        setGroupAvatarBusy(false);
      }
    },
    [currentChat?.id, updateGroupProfile],
  );

  const handleOpenRoomMedia = useCallback((item: RoomMediaItem) => {
    if (item.kind === "image" || item.kind === "video") {
      setLightbox({
        src: item.file.url,
        name: item.file.name,
        kind: item.kind,
      });
    }
  }, []);

  const handleReact = useCallback(
    (messageId: string, emoji: string) => {
      if (!session?.room) return;
      reactToMessage(session.room, messageId, emoji);
    },
    [reactToMessage, session?.room],
  );

  const handleCopied = useCallback(() => {
    toast("Скопировано");
  }, []);

  const searchMatches = useMemo(() => {
    const q = roomSearch.trim().toLowerCase();
    if (!q) return [] as string[];
    return messages
      .filter((message) => {
        if (message.kind === "system" || message.kind === "call") return false;
        return (
          message.text.toLowerCase().includes(q) ||
          message.author.toLowerCase().includes(q) ||
          Boolean(message.file?.name.toLowerCase().includes(q))
        );
      })
      .map((message) => message.id);
  }, [messages, roomSearch]);

  useEffect(() => {
    setMatchIndex(0);
  }, [roomSearch, session?.room]);

  const activeMatchId = searchMatches[matchIndex] || null;

  const jumpToMessage = useCallback(
    (messageId: string) => {
      const el = document.getElementById(`msg-${messageId}`);
      if (!el) {
        toast("Сообщение недоступно в истории");
        return;
      }
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("is-flash");
      window.setTimeout(() => el.classList.remove("is-flash"), 1200);
    },
    [toast],
  );

  useEffect(() => {
    if (!session?.room) return;
    setRoomAudioTracks(session.room, collectRoomAudioTracks(messages));
  }, [messages, session?.room]);

  const focusPlayingTrack = useCallback(
    (roomId: string, messageId: string) => {
      if (session?.room === roomId) {
        jumpToMessage(messageId);
        return;
      }
      pendingAudioJumpRef.current = { roomId, messageId };
      handleOpenChat(roomId);
    },
    [handleOpenChat, jumpToMessage, session?.room],
  );

  useEffect(() => {
    const pending = pendingAudioJumpRef.current;
    if (!pending || historyLoading) return;
    if (session?.room !== pending.roomId) return;
    const el = document.getElementById(`msg-${pending.messageId}`);
    if (!el) return;
    pendingAudioJumpRef.current = null;
    jumpToMessage(pending.messageId);
  }, [historyLoading, jumpToMessage, messages, session?.room]);

  const handleDiscard = useCallback(
    (messageId: string) => {
      discardMessage(messageId);
      toast("Черновик удалён");
    },
    [discardMessage, toast],
  );

  const handleDeleteMessage = useCallback(
    (messageId: string) => {
      if (!session?.room) return;
      deleteMessage(session.room, messageId);
      toast("Сообщение удалено");
    },
    [deleteMessage, session?.room, toast],
  );

  const handleEditMessage = useCallback((message: ChatMessage) => {
    setEditingMessage(message);
    setReplyTo(null);
  }, []);

  const handleForwardPick = useCallback(
    async (toChatId: string) => {
      if (!session?.room || !forwardMessageTarget) return;
      const ok = await forwardMessage(
        session.room,
        forwardMessageTarget.id,
        toChatId,
      );
      if (ok) {
        toast("Переслано");
        setForwardMessageTarget(null);
      }
    },
    [forwardMessage, forwardMessageTarget, session?.room],
  );

  const handleComposerSend = useCallback(
    (text: string, replyToId?: string) => {
      if (editingMessage && session?.room) {
        editMessage(session.room, editingMessage.id, text);
        setEditingMessage(null);
        return true;
      }
      return sendMessage(text, replyToId);
    },
    [editMessage, editingMessage, sendMessage, session?.room],
  );

  const markReadThrottled = useRef(0);
  const handleMarkRead = useCallback(() => {
    const now = Date.now();
    if (now - markReadThrottled.current < 800) return;
    markReadThrottled.current = now;
    markChatVisibleRead();
  }, [markChatVisibleRead]);

  const handleDeleteGroup = useCallback(async () => {
    if (!currentChat?.id || !canDeleteGroup) return;
    const ok = await deleteGroup(currentChat.id);
    setConfirmDeleteGroup(false);
    if (ok) {
      setChatInfoOpen(false);
      setMenuOpen(false);
      toast("Группа удалена");
    }
  }, [canDeleteGroup, currentChat, deleteGroup, toast]);

  const handleLeaveGroup = useCallback(async () => {
    if (!currentChat?.id || !canLeaveGroup) return;
    const ok = await leaveGroup(currentChat.id);
    setConfirmLeaveGroup(false);
    if (ok) {
      setChatInfoOpen(false);
      setMenuOpen(false);
      toast("Вы вышли из группы");
    }
  }, [canLeaveGroup, currentChat, leaveGroup, toast]);

  const selfName = account?.displayName || account?.username || "";
  // Only a short positive flash when the link is healthy again — no "offline" copy.
  const showReconnect = Boolean(account && flashOnline && connected);
  const reconnectText = "подключено";

  const [mountAt] = useState(() =>
    typeof performance !== "undefined" ? performance.now() : Date.now(),
  );
  const [introVisible, setIntroVisible] = useState(true);
  const [authWash, setAuthWash] = useState(true);
  // Avoid hydration mismatch: reducedMotion="user" reads matchMedia on first client paint.
  const [motionPolicy, setMotionPolicy] = useState<"never" | "user">("never");

  useEffect(() => {
    setMotionPolicy("user");
  }, []);

  // Hold splash until auth is ready AND a calm minimum beat has played.
  useEffect(() => {
    if (!authReady) return;

    const reduced =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const minMs = reduced ? 120 : 1100;
    const now =
      typeof performance !== "undefined" ? performance.now() : Date.now();
    const wait = Math.max(0, minMs - (now - mountAt));

    const timer = window.setTimeout(() => setIntroVisible(false), wait);
    return () => window.clearTimeout(timer);
  }, [authReady]);

  const showAuthScene = introVisible || !account;

  useEffect(() => {
    if (showAuthScene) {
      setAuthWash(true);
      return;
    }
    const timer = window.setTimeout(() => setAuthWash(false), 520);
    return () => window.clearTimeout(timer);
  }, [showAuthScene]);

  const easeOut = easeOutSoft;

  return (
    <MotionConfig reducedMotion={motionPolicy} transition={defaultTransition}>
    <div
      className={`app-shell ${showAuthScene || authWash ? "app-shell--auth" : ""}`}
    >
      <Toaster
        position="bottom-center"
        theme="light"
        gap={10}
        offset={28}
        toastOptions={{
          className: "pulse-toast",
          duration: 2200,
        }}
      />
      <CallOverlay
        incoming={incoming}
        active={active}
        localStream={localStream}
        remoteStream={remoteStream}
        muted={muted}
        deafened={deafened}
        cameraOff={cameraOff}
        sharingScreen={sharingScreen}
        mediaBusy={mediaBusy}
        remoteSharingScreen={remoteSharingScreen}
        remoteCameraOff={remoteCameraOff}
        peerAvatarUrl={
          active
            ? people.find((user) => user.id === active.peerId)?.avatarUrl ||
              (currentChat?.peerId === active.peerId
                ? currentChat.avatarUrl
                : null) ||
              null
            : null
        }
        selfAvatarUrl={account?.avatarUrl || null}
        incomingAvatarUrl={
          incoming
            ? people.find((user) => user.id === incoming.fromUserId)
                ?.avatarUrl || null
            : null
        }
        minimized={minimized}
        status={status}
        durationLabel={durationLabel}
        networkQuality={networkQuality}
        localSpeaking={localSpeaking}
        remoteSpeaking={remoteSpeaking}
        noiseFilterEnabled={noiseFilterEnabled}
        noiseFilterKind={noiseFilterKind}
        remoteAudioRef={remoteAudioRef}
        currentChatId={session?.room ?? null}
        onAccept={() => acceptCall()}
        onReject={() => rejectCall()}
        onEnd={endCall}
        onToggleMute={toggleMute}
        onToggleDeafen={toggleDeafen}
        onToggleNoiseFilter={toggleNoiseFilter}
        onToggleCamera={toggleCamera}
        onToggleScreenShare={toggleScreenShare}
        onToggleMinimized={() => setMinimized((value) => !value)}
        onExpandCall={() => {
          if (active?.chatId) handleOpenChat(active.chatId);
          setMinimized(false);
        }}
      />

      <VoiceOverlay
        active={voice.active}
        peers={voice.peers}
        selfName={voice.selfName}
        selfAvatarUrl={account?.avatarUrl || null}
        localStream={voice.localStream}
        remoteStreams={voice.remoteStreams}
        muted={voice.muted}
        deafened={voice.deafened}
        cameraOff={voice.cameraOff}
        sharingScreen={voice.sharingScreen}
        mediaBusy={voice.mediaBusy}
        minimized={voice.minimized}
        currentGroupId={session?.room ?? null}
        selfSpeaking={voice.selfSpeaking}
        noiseFilterEnabled={voice.noiseFilterEnabled}
        noiseFilterKind={voice.noiseFilterKind}
        onLeave={voice.leave}
        onToggleMute={voice.toggleMute}
        onToggleDeafen={voice.toggleDeafen}
        onToggleNoiseFilter={voice.toggleNoiseFilter}
        onToggleCamera={voice.toggleCamera}
        onToggleScreenShare={voice.toggleScreenShare}
        onToggleMinimized={() => voice.setMinimized((value) => !value)}
        onExpand={() => {
          if (voice.active?.groupId) handleOpenChat(voice.active.groupId);
          voice.setMinimized(false);
        }}
      />

      <MediaLightbox
        item={lightbox}
        onClose={() => setLightbox(null)}
      />

      <ChatInfoPanel
        open={chatInfoOpen && showChatInfo}
        chat={currentChat}
        canEditAvatar={canEditGroupAvatar}
        canEditProfile={canEditGroupProfile}
        canDeleteGroup={canDeleteGroup}
        canLeaveGroup={canLeaveGroup}
        uploading={groupAvatarBusy}
        error={sidebarError}
        onClose={() => setChatInfoOpen(false)}
        onUploadAvatar={uploadAvatar}
        onSaveAvatar={handleSaveGroupAvatar}
        onSaveProfile={handleSaveGroupProfile}
        onSaveVisibility={
          canEditGroupProfile
            ? async (visibility) => {
                if (!currentChat) return false;
                return updateGroupVisibility(currentChat.id, visibility);
              }
            : undefined
        }
        onFetchMedia={handleFetchRoomMedia}
        onOpenMedia={handleOpenRoomMedia}
        onDeleteGroup={() => {
          setChatInfoOpen(false);
          setConfirmDeleteGroup(true);
        }}
        onLeaveGroup={() => {
          setChatInfoOpen(false);
          setConfirmLeaveGroup(true);
        }}
      />

      {account && (
        <ProfilePanel
          open={profileOpen}
          account={account}
          connected={connected}
          saving={savingProfile}
          error={profileError}
          onClose={() => {
            clearProfileError();
            setProfileOpen(false);
          }}
          onSave={handleSaveProfile}
          onUploadAvatar={uploadAvatar}
          onLogout={handleLogout}
        />
      )}

      <AnimatePresence>
        {showAuthScene && (
          <motion.div
            key="auth-backdrop"
            className="join-backdrop-host"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.55, ease: easeOut }}
          >
            <JoinBackdrop />
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence mode="wait">
        {introVisible ? (
          <motion.div
            key="boot"
            className="boot"
            initial={{ opacity: 0, scale: 0.98 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 1.015 }}
            transition={{ duration: 0.42, ease: easeOut }}
          >
            <span className="boot__ring" aria-hidden />
            <span className="boot__ring boot__ring--delayed" aria-hidden />
            <motion.p
              className="boot__word"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.55, delay: 0.06, ease: easeOut }}
            >
              Pulse
            </motion.p>
          </motion.div>
        ) : !account ? (
          <motion.div
            key="join"
            className="join-wrap"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.45, ease: easeOut }}
          >
            <JoinGate
              connected={connected}
              error={authError}
              onRegister={register}
              onLogin={login}
            />
          </motion.div>
        ) : (
          <motion.div
            key="workspace"
            className={`workspace ${showMemberRail ? "has-members" : ""}`}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={softSpring}
          >
            <AnimatePresence>
              {showReconnect && (
                <motion.div
                  className="reconnect-banner is-ok"
                  initial={{ opacity: 0, y: -10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  transition={softSpring}
                >
                  <span>{reconnectText}</span>
                </motion.div>
              )}
            </AnimatePresence>

            <div
              className={`workspace__sidebar ${sidebarOpen ? "is-open" : ""}`}
            >
              <ServerRail
                focus={sidebarPanel}
                groups={groups}
                unreadHome={unreadTotal}
                onSelectHome={selectHome}
                onSelectDms={selectDms}
                onSelectGroup={selectGroup}
                onCreate={selectCreate}
              />
              <div className="workspace__sidebar-pane">
              <ChatSidebar
                chats={chats}
                people={people}
                currentUserId={account.userId}
                currentChatId={session?.room}
                focus={sidebarPanel}
                onFocusChange={setSidebarPanel}
                onOpenChat={handleOpenChat}
                onOpenDm={handleOpenDm}
                onCreateGroup={handleCreateGroup}
                onInviteToGroup={(groupId, userId) => {
                  void inviteToGroup(groupId, userId).then((result) => {
                    if (!result.ok) {
                      toast.error(result.error || "Не удалось пригласить");
                      return;
                    }
                    toast.success("Приглашение отправлено в ЛС");
                  });
                }}
                onSearchPeople={searchPeople}
                onSuggestPeople={suggestPeople}
                onSearchGroups={searchPublicGroups}
                onJoinGroup={async (groupId) => {
                  const result = await joinPublicGroup(groupId);
                  if (!result.ok) {
                    toast.error(result.error || "Не удалось присоединиться");
                    return result;
                  }
                  toast.success("Вы присоединились к группе");
                  setPendingGuildPanel(groupId);
                  return result;
                }}
                onToggleMute={handleToggleMute}
                mutedVersion={mutedVersion}
                onClose={() => setSidebarOpen(false)}
                onMarkAllRead={
                  unreadTotal > 0
                    ? () => {
                        markAllRead();
                        toast("Все чаты прочитаны");
                      }
                    : undefined
                }
                error={sidebarError}
                searchRef={searchRef}
                activeVoiceChannelId={voice.active?.channelId || null}
                voiceJoining={voice.joining}
                onJoinVoice={(channelId, groupId, title) => {
                  handleOpenChat(groupId);
                  voice.setMinimized(false);
                  void voice.join(channelId, groupId, title);
                }}
                onCreateVoiceChannel={(groupId, title) => {
                  void createVoiceChannel(groupId, title).then((result) => {
                    if (!result.ok) {
                      toast.error(result.error || "Не удалось создать канал");
                      return;
                    }
                    toast.success("Голосовой канал создан");
                  });
                }}
                onDeleteVoiceChannel={(groupId, channelId) => {
                  void deleteVoiceChannel(groupId, channelId).then((result) => {
                    if (!result.ok) {
                      toast.error(result.error || "Не удалось удалить канал");
                      return;
                    }
                    if (voice.active?.channelId === channelId) {
                      voice.leave();
                    }
                    toast.success("Голосовой канал удалён");
                  });
                }}
              />
              {voice.active && (
                <VoiceDock
                  channelTitle={voice.active.title}
                  groupTitle={
                    chats.find((chat) => chat.id === voice.active?.groupId)
                      ?.title
                  }
                  muted={voice.muted}
                  deafened={voice.deafened}
                  peerCount={voice.peers.length}
                  onToggleMute={voice.toggleMute}
                  onToggleDeafen={voice.toggleDeafen}
                  onLeave={voice.leave}
                  onExpand={() => {
                    if (voice.active?.groupId) handleOpenChat(voice.active.groupId);
                    voice.setMinimized(false);
                  }}
                />
              )}
              </div>
            </div>

            {sidebarOpen && (
              <button
                type="button"
                className="workspace__backdrop"
                aria-label="Закрыть список чатов"
                onClick={() => setSidebarOpen(false)}
              />
            )}

            <section className={`room ${session ? "" : "room--idle"} ${
              (active &&
                session?.room === active.chatId &&
                !minimized) ||
              (voice.active &&
                session?.room === voice.active.groupId &&
                !voice.minimized)
                ? "room--in-call"
                : ""
            }`}>
              <header className="room__header">
                <div className="room__heading">
                  <button
                    type="button"
                    className="icon-btn room__menu"
                    aria-label="Открыть меню"
                    onClick={() => setSidebarOpen(true)}
                  >
                    <IconMenu />
                    {unreadTotal > 0 && (
                      <i className="room__menu-badge">{unreadTotal}</i>
                    )}
                  </button>
                  {session && currentChat && currentChat.type === "dm" && (
                    <span
                      className={`room__peer ${
                        peerOnline ? "is-online" : ""
                      }`}
                    >
                      <Avatar
                        name={currentChat.title}
                        src={peer?.avatarUrl}
                        size="md"
                      />
                    </span>
                  )}
                  {session && currentChat && currentChat.type === "group" && (
                    <span className="room__peer room__peer--channel" aria-hidden>
                      <IconHash size={22} />
                    </span>
                  )}
                  {session &&
                    currentChat &&
                    currentChat.type === "channel" &&
                    (showChatInfo ? (
                      <button
                        type="button"
                        className="room__peer is-clickable"
                        onClick={handleOpenChatInfo}
                        aria-label="Открыть информацию о чате"
                      >
                        <Avatar
                          name={currentChat.title}
                          src={currentChat.avatarUrl}
                          size="md"
                        />
                      </button>
                    ) : (
                      <span className="room__peer">
                        <Avatar
                          name={currentChat.title}
                          src={currentChat.avatarUrl}
                          size="md"
                        />
                      </span>
                    ))}
                  <div
                    className={`room__heading-text ${showChatInfo ? "is-clickable" : ""}`}
                    onClick={showChatInfo ? handleOpenChatInfo : undefined}
                    onKeyDown={
                      showChatInfo
                        ? (event) => {
                            if (event.key === "Enter" || event.key === " ") {
                              event.preventDefault();
                              handleOpenChatInfo();
                            }
                          }
                        : undefined
                    }
                    role={showChatInfo ? "button" : undefined}
                    tabIndex={showChatInfo ? 0 : undefined}
                  >
                    <AnimatePresence mode="wait" initial={false}>
                      <motion.p
                        key={session ? chatLabel : "pulse"}
                        className="room__brand"
                        initial={{ opacity: 0, y: 4 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -4 }}
                      transition={{ duration: 0.26, ease: easeOut }}
                    >
                      {session ? chatLabel : "Pulse"}
                      {session &&
                        currentChat?.type !== "dm" &&
                        chatMuted && (
                        <IconMicOff size={14} className="room__mute-icon" />
                      )}
                    </motion.p>
                  </AnimatePresence>
                  <AnimatePresence mode="wait" initial={false}>
                    <motion.h2
                      key={subtitle}
                      className="room__title"
                      initial={{ opacity: 0, y: 4 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -2 }}
                      transition={{ duration: 0.24, ease: easeOut }}
                    >
                        {subtitle}
                      </motion.h2>
                    </AnimatePresence>
                  </div>
                </div>

                <div className="room__meta">
                  {showMemberRail && (
                    <button
                      type="button"
                      className={`icon-btn room__members-btn ${membersOpen ? "is-on" : ""}`}
                      aria-label="Участники"
                      title="Участники"
                      onClick={handleOpenMembers}
                    >
                      <IconUsers />
                    </button>
                  )}
                  {session && (
                    <button
                      type="button"
                      className={`icon-btn room__search-btn ${roomSearchOpen ? "is-on" : ""}`}
                      aria-label="Поиск в чате"
                      title="Поиск в чате"
                      onClick={() =>
                        setRoomSearchOpen((value) => {
                          if (value) setRoomSearch("");
                          return !value;
                        })
                      }
                    >
                      <IconSearch />
                    </button>
                  )}

                  {canCall && (
                    <div className="room__call-actions">
                      <button
                        type="button"
                        className="icon-btn"
                        aria-label="Звонок"
                        title={peerOnline ? "Звонок" : "Абонент не в сети"}
                        disabled={!peerOnline || Boolean(active)}
                        onClick={() =>
                          currentChat?.peerId &&
                          startCall(
                            currentChat.peerId,
                            currentChat.title,
                            "audio",
                            currentChat.id,
                          )
                        }
                      >
                        <IconPhone />
                      </button>
                    </div>
                  )}

                  <button
                    type="button"
                    className="room__me"
                    onClick={() => setProfileOpen(true)}
                    aria-label="Открыть профиль"
                    title={selfName}
                  >
                    <Avatar
                      name={selfName}
                      src={account.avatarUrl}
                      size="md"
                    />
                    <div className="room__me-text">
                      <span className="room__user">{selfName}</span>
                      {account.bio?.trim() ? (
                        <span className="status">{account.bio.trim()}</span>
                      ) : null}
                    </div>
                  </button>

                  {session && (
                    <div className="room__more-wrap">
                      <button
                        type="button"
                        className={`icon-btn ${menuOpen ? "is-on" : ""}`}
                        aria-label="Ещё"
                        aria-expanded={menuOpen}
                        onClick={() => setMenuOpen((value) => !value)}
                      >
                        <IconMore />
                      </button>
                      {menuOpen && (
                        <>
                          <button
                            type="button"
                            className="room__more-backdrop"
                            aria-label="Закрыть меню"
                            onClick={() => setMenuOpen(false)}
                          />
                          <div className="room__more-menu" role="menu">
                            {showMemberRail && (
                              <button
                                type="button"
                                role="menuitem"
                                onClick={handleOpenMembers}
                              >
                                <IconUsers size={16} />
                                Участники
                                {chatMembers.length > 0
                                  ? ` · ${chatMembers.length}`
                                  : ""}
                              </button>
                            )}
                            {showChatInfo && (
                              <button
                                type="button"
                                role="menuitem"
                                onClick={handleOpenChatInfo}
                              >
                                <IconImage size={16} />
                                Медиа и файлы
                              </button>
                            )}
                            {canLeaveGroup && (
                              <button
                                type="button"
                                role="menuitem"
                                className="is-danger"
                                onClick={() => {
                                  setMenuOpen(false);
                                  setConfirmLeaveGroup(true);
                                }}
                              >
                                <IconLogout size={16} />
                                Выйти из группы
                              </button>
                            )}
                            {canDeleteGroup && (
                              <button
                                type="button"
                                role="menuitem"
                                className="is-danger"
                                onClick={() => {
                                  setMenuOpen(false);
                                  setConfirmDeleteGroup(true);
                                }}
                              >
                                <IconTrash size={16} />
                                Удалить группу
                              </button>
                            )}
                            <button
                              type="button"
                              role="menuitem"
                              onClick={() => {
                                setRoomSearchOpen(true);
                                setMenuOpen(false);
                              }}
                            >
                              <IconSearch size={16} />
                              Поиск в чате
                            </button>
                            {canCall && (
                              <button
                                type="button"
                                role="menuitem"
                                className="room__more-call"
                                disabled={!peerOnline || Boolean(active)}
                                onClick={() => {
                                  if (
                                    !currentChat?.peerId ||
                                    !peerOnline ||
                                    active
                                  )
                                    return;
                                  startCall(
                                    currentChat.peerId,
                                    currentChat.title,
                                    "audio",
                                    currentChat.id,
                                  );
                                  setMenuOpen(false);
                                }}
                              >
                                <IconPhone size={16} />
                                Звонок
                              </button>
                            )}
                            {currentChat?.type !== "dm" && (
                              <button
                                type="button"
                                role="menuitem"
                                onClick={() => {
                                  if (!session?.room) return;
                                  handleToggleMute(session.room);
                                  setMenuOpen(false);
                                }}
                              >
                                {chatMuted ? (
                                  <IconMic size={16} />
                                ) : (
                                  <IconMicOff size={16} />
                                )}
                                {chatMuted
                                  ? "Включить звук чата"
                                  : "Без звука"}
                              </button>
                            )}
                            <button
                              type="button"
                              role="menuitem"
                              onClick={() => {
                                leave();
                                setMenuOpen(false);
                              }}
                            >
                              <IconClose size={16} />
                              Свернуть чат
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </div>
              </header>

              <div
          id="pulse-call-dock"
          className={`room__call-dock ${
            sharingScreen || remoteSharingScreen
              ? "is-screen"
              : (!cameraOff && !sharingScreen) ||
                  (!remoteCameraOff && !remoteSharingScreen)
                ? "is-camera"
                : ""
          } ${
            voice.active &&
            (voice.sharingScreen ||
              voice.peers.some((peer) => peer.sharingScreen))
              ? "is-screen"
              : voice.active &&
                  (!voice.cameraOff ||
                    voice.peers.some(
                      (peer) => !peer.cameraOff && !peer.sharingScreen,
                    ))
                ? "is-camera"
                : ""
          } ${
            (active && session?.room === active.chatId && minimized) ||
            (voice.active &&
              session?.room === voice.active.groupId &&
              voice.minimized)
              ? "is-mini"
              : ""
          }`}
        />

              <div className="room__stage">
              <AudioPlaybackBar
                currentRoomId={session?.room}
                chats={chats}
                onFocusTrack={focusPlayingTrack}
              />

              {!session ? (
                <div className="room__empty-state">
                  <p className="room__empty-brand">Pulse</p>
                  <p className="room__empty-copy">
                    Выберите чат слева или найдите человека, чтобы начать
                    переписку.
                  </p>
                  <p className="room__empty-hint room__empty-hint--mobile">
                    Нажмите меню слева, чтобы открыть чаты
                  </p>
                  <div className="room__empty-actions">
                    <button
                      type="button"
                      className="room__profile-cta room__profile-cta--primary"
                      onClick={openPeople}
                    >
                      Найти человека
                    </button>
                    <button
                      type="button"
                      className="room__profile-cta room__profile-cta--drawer"
                      onClick={() => setSidebarOpen(true)}
                    >
                      Открыть чаты
                    </button>
                    <button
                      type="button"
                      className="room__profile-cta"
                      onClick={() => setProfileOpen(true)}
                    >
                      Профиль
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  {roomSearchOpen && (
                    <div className="room__search">
                      <IconSearch size={15} />
                      <input
                        value={roomSearch}
                        onChange={(event) => setRoomSearch(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key !== "Enter") return;
                          event.preventDefault();
                          if (!searchMatches.length) return;
                          setMatchIndex((index) => {
                            if (event.shiftKey) {
                              return (
                                (index - 1 + searchMatches.length) %
                                searchMatches.length
                              );
                            }
                            return (index + 1) % searchMatches.length;
                          });
                        }}
                        placeholder="Поиск · Enter далее"
                        autoFocus
                      />
                      <span className="room__search-count">
                        {roomSearch.trim()
                          ? `${searchMatches.length ? matchIndex + 1 : 0}/${searchMatches.length}`
                          : ""}
                      </span>
                      <button
                        type="button"
                        className="icon-btn"
                        aria-label="Предыдущее совпадение"
                        disabled={!searchMatches.length}
                        onClick={() =>
                          setMatchIndex((index) =>
                            searchMatches.length
                              ? (index - 1 + searchMatches.length) %
                                searchMatches.length
                              : 0,
                          )
                        }
                      >
                        <IconChevronUp size={16} />
                      </button>
                      <button
                        type="button"
                        className="icon-btn"
                        aria-label="Следующее совпадение"
                        disabled={!searchMatches.length}
                        onClick={() =>
                          setMatchIndex((index) =>
                            searchMatches.length
                              ? (index + 1) % searchMatches.length
                              : 0,
                          )
                        }
                      >
                        <IconChevronDown size={16} />
                      </button>
                      <button
                        type="button"
                        className="icon-btn"
                        aria-label="Закрыть поиск"
                        onClick={() => {
                          setRoomSearchOpen(false);
                          setRoomSearch("");
                        }}
                      >
                        <IconClose size={16} />
                      </button>
                    </div>
                  )}

                  {online.length > 0 &&
                    currentChat?.type !== "dm" &&
                    currentChat?.type !== "group" && (
                    <div className="room__people-row">
                      {online.filter(Boolean).map((name, index) => {
                        const person = people.find(
                          (user) =>
                            user.displayName === name ||
                            user.username === name,
                        );
                        return (
                          <span key={name || `online-${index}`} className="chip">
                            <Avatar
                              name={name}
                              src={person?.avatarUrl}
                              size="sm"
                            />
                            {name}
                          </span>
                        );
                      })}
                    </div>
                  )}

                  <motion.div
                    key={session.room}
                    className="room__stream"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ duration: 0.22, ease: easeOut }}
                  >
                    <MessageList
                      chatId={session.room}
                      messages={messages}
                      people={people}
                      account={account}
                      othersTyping={othersTyping}
                      searchQuery={roomSearch}
                      activeMatchId={activeMatchId}
                      loading={historyLoading}
                      unreadAtOpen={unreadAtOpen}
                      peerReadAt={peerReadAt}
                      onReply={handleReply}
                      onOpenImage={handleOpenImage}
                      onReact={handleReact}
                      onJumpTo={jumpToMessage}
                      onCopied={handleCopied}
                      onRetry={retryMessage}
                      onDiscard={handleDiscard}
                      onDelete={handleDeleteMessage}
                      onEdit={handleEditMessage}
                      onForward={setForwardMessageTarget}
                      onInviteRespond={(messageId, accept) => {
                        if (!session?.room) return;
                        void respondGroupInvite(
                          session.room,
                          messageId,
                          accept,
                        ).then((result) => {
                          if (!result.ok) {
                            toast.error(
                              result.error || "Не удалось ответить на приглашение",
                            );
                            return;
                          }
                          if (accept && result.groupId) {
                            toast.success("Вы вступили в группу");
                            handleOpenChat(result.groupId);
                          } else if (!accept) {
                            toast("Приглашение отклонено");
                          }
                        });
                      }}
                      onMarkRead={handleMarkRead}
                      canModerate={canModerateMessages}
                    />
                  </motion.div>

                  <Composer
                    onSend={handleComposerSend}
                    onSendFiles={handleSendFiles}
                    onTyping={setTyping}
                    uploading={uploading}
                    disabled={historyLoading && !messages.length}
                    uploadProgress={uploadProgress}
                    error={composerError}
                    onClearError={clearComposerError}
                    onCancelUpload={cancelUpload}
                    replyTo={replyTo}
                    onClearReply={() => setReplyDraft(null)}
                    focusToken={session.room}
                    mentionMembers={chatMembers}
                    editingText={editingMessage?.text || null}
                    onCancelEdit={() => setEditingMessage(null)}
                    onAttachmentsCleared={() =>
                      toast("Вложения сброшены при смене чата")
                    }
                  />

                  {forwardMessageTarget && (
                    <div className="forward-sheet" role="dialog" aria-label="Переслать">
                      <button
                        type="button"
                        className="forward-sheet__backdrop"
                        aria-label="Закрыть"
                        onClick={() => setForwardMessageTarget(null)}
                      />
                      <div className="forward-sheet__card">
                        <header>
                          <strong>Переслать</strong>
                          <button
                            type="button"
                            onClick={() => setForwardMessageTarget(null)}
                          >
                            <IconClose size={16} />
                          </button>
                        </header>
                        <div className="forward-sheet__list">
                          {chats
                            .filter((chat) => chat.id !== session.room)
                            .slice(0, 24)
                            .map((chat) => (
                              <button
                                key={chat.id}
                                type="button"
                                onClick={() => void handleForwardPick(chat.id)}
                              >
                                {chat.title}
                              </button>
                            ))}
                        </div>
                      </div>
                    </div>
                  )}
                </>
              )}
              </div>
            </section>

            {showMemberRail && account && (
              <GuildMemberList
                members={chatMembers}
                ownerId={currentChat?.createdBy}
                currentUserId={account.userId}
                onSelectMember={(userId) => {
                  if (userId === account.userId) {
                    setProfileOpen(true);
                    return;
                  }
                  handleOpenDm(userId);
                  setSidebarOpen(false);
                }}
              />
            )}

            {showMemberRail && account && membersOpen && (
              <div className="member-sheet" role="dialog" aria-modal="true">
                <button
                  type="button"
                  className="member-sheet__backdrop"
                  aria-label="Закрыть участников"
                  onClick={() => setMembersOpen(false)}
                />
                <div className="member-sheet__card">
                  <header className="member-sheet__head">
                    <h3>
                      Участники
                      {chatMembers.length > 0 ? (
                        <span> · {chatMembers.length}</span>
                      ) : null}
                    </h3>
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label="Закрыть"
                      onClick={() => setMembersOpen(false)}
                    >
                      <IconClose />
                    </button>
                  </header>
                  <GuildMemberList
                    members={chatMembers}
                    ownerId={currentChat?.createdBy}
                    currentUserId={account.userId}
                    onSelectMember={(userId) => {
                      setMembersOpen(false);
                      if (userId === account.userId) {
                        setProfileOpen(true);
                        return;
                      }
                      handleOpenDm(userId);
                      setSidebarOpen(false);
                    }}
                  />
                </div>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      <ConfirmDialog
        open={confirmLeaveGroup}
        title="Выйти из группы?"
        body={
          currentChat
            ? `Вы перестанете видеть «${currentChat.title}» в списке чатов.`
            : undefined
        }
        confirmLabel="Выйти"
        onCancel={() => setConfirmLeaveGroup(false)}
        onConfirm={() => {
          void handleLeaveGroup();
        }}
      />

      <ConfirmDialog
        open={confirmDeleteGroup}
        title="Удалить группу?"
        body={
          currentChat
            ? `Группа «${currentChat.title}» будет удалена для всех участников.`
            : undefined
        }
        confirmLabel="Удалить"
        onCancel={() => setConfirmDeleteGroup(false)}
        onConfirm={() => {
          void handleDeleteGroup();
        }}
      />
    </div>
    </MotionConfig>
  );
}
