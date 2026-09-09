"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import type {
  AuthAccount,
  ChatInfo,
  ChatMessage,
  GroupVisibility,
  PeopleUser,
  PublicGroupHit,
  RoomMediaItem,
  Session,
  TypingEvent,
} from "@/lib/types";
import {
  MAX_FILES_AT_ONCE,
  albumPreviewText,
  attachmentPreviewText,
  audioDisplayName,
  isAudioAttachment,
  isImageAttachment,
  isMediaAttachment,
  isVideoAttachment,
  isVoiceNote,
  messageAttachments,
  uploadFileWithRetry,
  runPool,
  validateAvatarFile,
  validateFile,
} from "@/lib/files";
import {
  playMessageBeep,
  showDesktopNotify,
  subscribeWebPush,
} from "@/lib/notify";
import { isChatMuted } from "@/lib/mute";
import { compressUploadBatch } from "@/lib/compressImage";
import { watchAppBoot } from "@/lib/liveReload";

const TOKEN_KEY = "pulse-chat-token";

type AuthAck = {
  ok: boolean;
  account?: AuthAccount;
  error?: string;
};

type SessionAck = {
  ok: boolean;
  session?: Session;
  error?: string;
};

export function useChat() {
  const socketRef = useRef<Socket | null>(null);
  const [socket, setSocket] = useState<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  const [account, setAccount] = useState<AuthAccount | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [online, setOnline] = useState<string[]>([]);
  const [chats, setChats] = useState<ChatInfo[]>([]);
  const [people, setPeople] = useState<PeopleUser[]>([]);
  const [typingUsers, setTypingUsers] = useState<string[]>([]);
  const [peerReadAt, setPeerReadAt] = useState<number | null>(null);
  const [chatMembers, setChatMembers] = useState<PeopleUser[]>([]);
  const [authError, setAuthError] = useState<string | null>(null);
  const [sidebarError, setSidebarError] = useState<string | null>(null);
  const [composerError, setComposerError] = useState<string | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const typingTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map(),
  );
  const accountRef = useRef<AuthAccount | null>(null);
  const sessionRef = useRef<Session | null>(null);
  const messagesRef = useRef<ChatMessage[]>([]);
  const uploadAbortRef = useRef<AbortController | null>(null);
  const expectedRoomRef = useRef<string | null>(null);
  const switchSeqRef = useRef(0);
  const pendingAckTimersRef = useRef(new Map<string, number>());
  const historyWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const historyCacheRef = useRef(new Map<string, ChatMessage[]>());
  const previousRoomRef = useRef<{
    session: Session;
    messages: ChatMessage[];
  } | null>(null);

  useEffect(() => {
    accountRef.current = account;
  }, [account]);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const persistAccount = useCallback((next: AuthAccount | null) => {
    setAccount(next);
    try {
      if (next) localStorage.setItem(TOKEN_KEY, next.token);
      else localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* ignore */
    }
  }, []);

  const authEpochRef = useRef(0);

  useEffect(() => {
    const socket = io({
      path: "/api/socket",
      autoConnect: true,
      // Polling first is more reliable behind Cloudflare quick tunnels;
      // socket.io then upgrades to websocket when the proxy allows it.
      transports: ["polling", "websocket"],
      upgrade: true,
      rememberUpgrade: false,
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 700,
      reconnectionDelayMax: 8_000,
      randomizationFactor: 0.4,
      timeout: 20_000,
    });
    socketRef.current = socket;
    setSocket(socket);

    const restoreSessionAfterConnect = () => {
      setConnected(true);
      setReconnecting(false);
      let token = "";
      try {
        token = localStorage.getItem(TOKEN_KEY) || "";
      } catch {
        token = "";
      }

      if (!token) {
        setAuthReady(true);
        return;
      }

      const restoreEpoch = authEpochRef.current;
      socket.emit("auth:restore", { token }, (result: AuthAck) => {
        // Ignore stale restore if user already logged in/out meanwhile.
        if (restoreEpoch !== authEpochRef.current) {
          setAuthReady(true);
          return;
        }

        let currentToken = "";
        try {
          currentToken = localStorage.getItem(TOKEN_KEY) || "";
        } catch {
          currentToken = "";
        }

        if (result?.ok && result.account) {
          persistAccount(result.account);
          const room = sessionRef.current?.room;
          if (room) {
            expectedRoomRef.current = room;
            socket.emit(
              "chats:switch",
              { chatId: room },
              (ack: SessionAck) => {
                if (ack?.ok && ack.session) {
                  expectedRoomRef.current = ack.session.room;
                  setSession(ack.session);
                }
              },
            );
          }
        } else if (currentToken === token) {
          // Only clear if the failed token is still the active one.
          persistAccount(null);
        }
        setAuthReady(true);
      });
    };

    socket.on("connect", restoreSessionAfterConnect);

    const stopBootWatch = watchAppBoot(socket);

    socket.on("disconnect", (reason) => {
      setConnected(false);
      // Keep session/messages/call UI — brief blips should not kick the user.
      if (reason === "io server disconnect") {
        // Server forced disconnect — try coming back.
        socket.connect();
      }
      setReconnecting(true);
    });
    socket.io.on("reconnect_attempt", () => setReconnecting(true));
    socket.io.on("reconnect", () => {
      setReconnecting(false);
      setConnected(true);
      // `connect` also fires; restoreSessionAfterConnect re-binds room.
    });
    socket.io.on("reconnect_error", () => setReconnecting(true));
    socket.io.on("reconnect_failed", () => setReconnecting(true));

    // Phone: when user returns to a minimized tab, force socket back immediately.
    const onVisibility = () => {
      if (typeof document === "undefined" || document.hidden) return;
      if (!socket.connected) {
        setReconnecting(true);
        socket.connect();
      }
    };
    const onPageShow = () => onVisibility();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pageshow", onPageShow);
    window.addEventListener("focus", onVisibility);

    socket.on("chats", (list: ChatInfo[]) => setChats(list));
    socket.on("people", (list: PeopleUser[]) => setPeople(list));
    socket.on(
      "voice:state",
      (payload: {
        groupId?: string;
        channels?: NonNullable<ChatInfo["voiceChannels"]>;
      }) => {
        const groupId = String(payload?.groupId || "");
        if (!groupId || !Array.isArray(payload?.channels)) return;
        setChats((prev) =>
          prev.map((chat) =>
            chat.id === groupId
              ? { ...chat, voiceChannels: payload.channels }
              : chat,
          ),
        );
      },
    );

    socket.on(
      "message:deleted",
      (payload: {
        chatId?: string;
        messageId?: string;
        tombstone?: ChatMessage;
      }) => {
        const chatId = String(payload?.chatId || "");
        const messageId = String(payload?.messageId || "");
        if (!chatId || !messageId) return;

        const tombstone = payload.tombstone;
        const apply = (list: ChatMessage[]) => {
          if (!tombstone) {
            return list.filter((item) => item.id !== messageId);
          }
          return list.map((item) => {
            if (item.id === messageId) {
              return {
                ...tombstone,
                clientKey: item.clientKey || tombstone.clientKey,
              };
            }
            if (item.replyTo?.id === messageId) {
              return {
                ...item,
                replyTo: { ...item.replyTo, text: tombstone.text },
              };
            }
            return item;
          });
        };

        const cached = historyCacheRef.current.get(chatId);
        if (cached) {
          historyCacheRef.current.set(chatId, apply(cached));
        }

        const currentRoom =
          expectedRoomRef.current || sessionRef.current?.room;
        if (currentRoom === chatId) {
          setMessages((prev) => apply(prev));
        }
      },
    );

    socket.on("chat:deleted", (payload: { chatId?: string }) => {
      const chatId = String(payload?.chatId || "");
      if (!chatId) return;
      historyCacheRef.current.delete(chatId);
      setChats((prev) => prev.filter((chat) => chat.id !== chatId));

      const currentRoom = expectedRoomRef.current || sessionRef.current?.room;
      if (currentRoom === chatId) {
        switchSeqRef.current += 1;
        expectedRoomRef.current = null;
        setSession(null);
        setMessages([]);
        setTypingUsers([]);
        setSidebarError("Группа удалена");
      }
    });

    socket.on("chat:left", (payload: { chatId?: string }) => {
      const chatId = String(payload?.chatId || "");
      if (!chatId) return;
      historyCacheRef.current.delete(chatId);
      setChats((prev) => prev.filter((chat) => chat.id !== chatId));

      const currentRoom = expectedRoomRef.current || sessionRef.current?.room;
      if (currentRoom === chatId) {
        switchSeqRef.current += 1;
        expectedRoomRef.current = null;
        setSession(null);
        setMessages([]);
        setTypingUsers([]);
      }
    });

    socket.on("auth:expired", () => {
      authEpochRef.current += 1;
      switchSeqRef.current += 1;
      expectedRoomRef.current = null;
      pendingAckTimersRef.current.forEach((timer) =>
        window.clearTimeout(timer),
      );
      pendingAckTimersRef.current.clear();
      persistAccount(null);
      setSession(null);
      setMessages([]);
      setOnline([]);
      setChats([]);
      setTypingUsers([]);
      setAuthError("Сессия завершена. Войдите снова.");
      setAuthReady(true);
    });

    socket.on(
      "history",
      (payload: ChatMessage[] | { chatId?: string; messages?: ChatMessage[] }) => {
        const chatId = Array.isArray(payload) ? null : String(payload?.chatId || "");
        const history = Array.isArray(payload)
          ? payload
          : Array.isArray(payload?.messages)
            ? payload.messages
            : [];

        if (chatId) {
          if (!expectedRoomRef.current) {
            expectedRoomRef.current = chatId;
          } else if (chatId !== expectedRoomRef.current) {
            return;
          }
        }

        pendingAckTimersRef.current.forEach((timer) => window.clearTimeout(timer));
        pendingAckTimersRef.current.clear();
        if (historyWatchdogRef.current) {
          clearTimeout(historyWatchdogRef.current);
          historyWatchdogRef.current = null;
        }
        if (chatId || expectedRoomRef.current) {
          const key = chatId || expectedRoomRef.current || "";
          if (key) historyCacheRef.current.set(key, history);
        }
        setMessages(history);
        setHistoryLoading(false);
        setTypingUsers([]);
        setComposerError(null);
      },
    );

    socket.on("message", (message: ChatMessage) => {
      const currentRoom = expectedRoomRef.current || sessionRef.current?.room;
      const inView = Boolean(currentRoom && message.room === currentRoom);

      if (inView) {
        const ackTimer = pendingAckTimersRef.current.get(message.id);
        if (ackTimer) {
          window.clearTimeout(ackTimer);
          pendingAckTimersRef.current.delete(message.id);
        }

        setMessages((prev) => {
          const index = prev.findIndex((item) => item.id === message.id);
          if (index >= 0) {
            const next = [...prev];
            next[index] = {
              ...message,
              clientKey: prev[index].clientKey || prev[index].id,
              status: undefined,
            };
            return next;
          }

          // Server assigns its own id; replace matching optimistic bubble.
          const selfId = accountRef.current?.userId;
          if (selfId && message.authorId === selfId) {
            const pendingIdx = prev.findIndex(
              (item) =>
                item.status === "pending" &&
                item.authorId === selfId &&
                item.room === message.room &&
                item.kind === (message.kind || "text") &&
                item.text === message.text,
            );
            if (pendingIdx >= 0) {
              const oldId = prev[pendingIdx].id;
              const timer = pendingAckTimersRef.current.get(oldId);
              if (timer) {
                window.clearTimeout(timer);
                pendingAckTimersRef.current.delete(oldId);
              }
              const next = [...prev];
              next[pendingIdx] = {
                ...message,
                clientKey: prev[pendingIdx].clientKey || oldId,
                status: undefined,
              };
              return next;
            }
          }

          return [...prev, message];
        });
      }

      const self = accountRef.current;
      if (!self || message.authorId === self.userId) return;
      if (message.kind === "system" || message.kind === "call") return;

      const viewing =
        inView && typeof document !== "undefined" && !document.hidden;

      if (viewing) {
        socket.emit("chats:read", { chatId: message.room });
        return;
      }

      if (isChatMuted(message.room)) return;

      playMessageBeep();
      // Notify when tab is in background OR user is in another chat.
      showDesktopNotify(
        message.author,
        message.kind === "file"
          ? albumPreviewText(messageAttachments(message), message.text)
          : message.text,
        { chatId: message.room },
      );
    });

    socket.on("message:update", (message: ChatMessage) => {
      // Full replace — soft-delete tombstones must drop file/reactions fields.
      const patch = (list: ChatMessage[]) => {
        const next = list.map((item) =>
          item.id === message.id
            ? { ...message, clientKey: item.clientKey || message.clientKey }
            : item,
        );
        if (message.pinned) {
          return next.map((item) =>
            item.id === message.id
              ? item
              : item.pinned
                ? { ...item, pinned: false }
                : item,
          );
        }
        return next;
      };

      const cached = historyCacheRef.current.get(message.room);
      if (cached) {
        historyCacheRef.current.set(message.room, patch(cached));
      }

      const currentRoom = expectedRoomRef.current || sessionRef.current?.room;
      if (!currentRoom || message.room !== currentRoom) return;
      setMessages((prev) => patch(prev));
    });

    socket.on(
      "chat:read",
      (payload: { chatId?: string; userId?: string; readAt?: number }) => {
        const chatId = String(payload?.chatId || "");
        const current = expectedRoomRef.current || sessionRef.current?.room;
        if (!chatId || chatId !== current) return;
        const selfId = accountRef.current?.userId;
        if (payload.userId && selfId && payload.userId === selfId) return;
        const readAt = Number(payload?.readAt) || Date.now();
        setPeerReadAt(readAt);
      },
    );

    socket.on(
      "message:ping",
      (ping: { room?: string; author?: string; text?: string }) => {
        const room = String(ping?.room || "");
        if (!room || isChatMuted(room)) return;
        const viewingOther =
          typeof document !== "undefined" &&
          !document.hidden &&
          (expectedRoomRef.current || sessionRef.current?.room) === room;
        if (viewingOther) return;
        playMessageBeep();
        showDesktopNotify(String(ping.author || "Pulse"), String(ping.text || ""), {
          chatId: room,
        });
      },
    );

    socket.on("presence", (payload: string[] | { chatId?: string; names?: string[] }) => {
      if (Array.isArray(payload)) {
        setOnline(payload);
        return;
      }
      const chatId = String(payload?.chatId || "");
      const current = expectedRoomRef.current || sessionRef.current?.room;
      if (!chatId || chatId !== current) return;
      setOnline(Array.isArray(payload.names) ? payload.names : []);
    });

    socket.on(
      "typing",
      ({
        chatId,
        name,
        isTyping,
      }: TypingEvent & { chatId?: string }) => {
        const current = expectedRoomRef.current || sessionRef.current?.room;
        if (chatId && current && chatId !== current) return;

        const existing = typingTimers.current.get(name);
        if (existing) clearTimeout(existing);

        setTypingUsers((prev) => {
          if (isTyping) {
            return prev.includes(name) ? prev : [...prev, name];
          }
          return prev.filter((item) => item !== name);
        });

        if (isTyping) {
          typingTimers.current.set(
            name,
            setTimeout(() => {
              setTypingUsers((prev) => prev.filter((item) => item !== name));
              typingTimers.current.delete(name);
            }, 2500),
          );
        }
      },
    );

    return () => {
      stopBootWatch();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pageshow", onPageShow);
      window.removeEventListener("focus", onVisibility);
      typingTimers.current.forEach((timer) => clearTimeout(timer));
      typingTimers.current.clear();
      pendingAckTimersRef.current.forEach((timer) => window.clearTimeout(timer));
      pendingAckTimersRef.current.clear();
      if (historyWatchdogRef.current) {
        clearTimeout(historyWatchdogRef.current);
        historyWatchdogRef.current = null;
      }
      socket.disconnect();
      socketRef.current = null;
      setSocket(null);
    };
  }, [persistAccount]);

  // Keep Web Push subscription alive while logged in (for background calls).
  useEffect(() => {
    if (!account?.token || !authReady) return;
    void subscribeWebPush(account.token);
  }, [account?.token, authReady]);

  const register = useCallback(
    (username: string, password: string) => {
      setAuthError(null);
      authEpochRef.current += 1;
      const epoch = authEpochRef.current;
      const socket = socketRef.current;
      if (!socket?.connected) {
        setAuthError("Нет соединения с сервером");
        return;
      }
      socket.emit(
        "auth:register",
        { username, password },
        (result: AuthAck) => {
          if (epoch !== authEpochRef.current) return;
          if (!result?.ok || !result.account) {
            setAuthError(result?.error || "Не удалось зарегистрироваться");
            return;
          }
          persistAccount(result.account);
        },
      );
    },
    [persistAccount],
  );

  const login = useCallback(
    (username: string, password: string) => {
      setAuthError(null);
      authEpochRef.current += 1;
      const epoch = authEpochRef.current;
      const socket = socketRef.current;
      if (!socket?.connected) {
        setAuthError("Нет соединения с сервером");
        return;
      }
      socket.emit(
        "auth:login",
        { username, password },
        (result: AuthAck) => {
          if (epoch !== authEpochRef.current) return;
          if (!result?.ok || !result.account) {
            setAuthError(result?.error || "Не удалось войти");
            return;
          }
          persistAccount(result.account);
        },
      );
    },
    [persistAccount],
  );

  const logout = useCallback(() => {
    authEpochRef.current += 1;
    switchSeqRef.current += 1;
    expectedRoomRef.current = null;
    pendingAckTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    pendingAckTimersRef.current.clear();
    socketRef.current?.emit("leave");
    socketRef.current?.emit("auth:logout");
    persistAccount(null);
    setSession(null);
    setMessages([]);
    setOnline([]);
    setChats([]);
    setTypingUsers([]);
    setAuthError(null);
    setSidebarError(null);
    setComposerError(null);
    setProfileError(null);
  }, [persistAccount]);

  const updateProfile = useCallback(
    (patch: {
      displayName: string;
      bio: string;
      avatarUrl?: string | null;
    }) =>
      new Promise<boolean>((resolve) => {
        setProfileError(null);
        socketRef.current?.emit(
          "profile:update",
          patch,
          (result: AuthAck) => {
            if (!result?.ok || !result.account) {
              setProfileError(result?.error || "Не удалось сохранить профиль");
              resolve(false);
              return;
            }
            persistAccount(result.account);
            resolve(true);
          },
        );
      }),
    [persistAccount],
  );

  const uploadAvatar = useCallback(
    async (file: File) => {
      if (!account?.token) {
        setProfileError("Нужен вход");
        return null;
      }
      const invalid = validateAvatarFile(file);
      if (invalid) {
        setProfileError(invalid);
        return null;
      }
      setProfileError(null);
      try {
        const uploaded = await uploadFileWithRetry(file, account.token, {
          kind: "avatar",
          retries: 2,
        });
        return uploaded.url;
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Не удалось загрузить аватар";
        setProfileError(
          message === "Запрещённый Origin" ||
            message === "Загрузка запрещена (Origin)"
            ? "Загрузка заблокирована. Обновите страницу и попробуйте снова"
            : message,
        );
        return null;
      }
    },
    [account?.token],
  );

  const beginRoomSwitch = useCallback((roomHint?: string) => {
    const seq = ++switchSeqRef.current;
    const current = sessionRef.current;
    if (current?.room) {
      previousRoomRef.current = {
        session: current,
        messages: messagesRef.current.filter((item) => item.room === current.room),
      };
      if (messagesRef.current.length) {
        historyCacheRef.current.set(current.room, messagesRef.current);
      }
    }

    // Empty string = switch in flight to an unknown room (DM/group create).
    expectedRoomRef.current = roomHint || "";
    pendingAckTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    pendingAckTimersRef.current.clear();
    if (historyWatchdogRef.current) {
      clearTimeout(historyWatchdogRef.current);
      historyWatchdogRef.current = null;
    }
    setSidebarError(null);
    setTypingUsers([]);
    setComposerError(null);
    setPeerReadAt(null);
    setChatMembers([]);

    const cached = roomHint ? historyCacheRef.current.get(roomHint) : undefined;
    if (cached?.length) {
      setMessages(cached);
      setHistoryLoading(false);
    } else {
      setMessages([]);
      setHistoryLoading(true);
      historyWatchdogRef.current = setTimeout(() => {
        if (seq !== switchSeqRef.current) return;
        setHistoryLoading(false);
        historyWatchdogRef.current = null;
      }, 8_000);
    }

    const account = accountRef.current;
    const name =
      account?.displayName ||
      account?.username ||
      sessionRef.current?.name ||
      "";

    if (roomHint) {
      setSession({ name, room: roomHint });
    } else {
      setSession((prev) => (prev ? { ...prev, name } : { name, room: "" }));
    }

    return seq;
  }, []);

  const restorePreviousRoom = useCallback((error: string) => {
    const prev = previousRoomRef.current;
    setHistoryLoading(false);
    setSidebarError(error);
    if (!prev) {
      expectedRoomRef.current = null;
      setSession(null);
      setMessages([]);
      return;
    }
    expectedRoomRef.current = prev.session.room;
    setSession(prev.session);
    const cached =
      historyCacheRef.current.get(prev.session.room) || prev.messages;
    setMessages(cached);
  }, []);

  const openChat = useCallback(
    (chatId: string) => {
      if (
        sessionRef.current?.room === chatId &&
        expectedRoomRef.current === chatId &&
        messagesRef.current.length > 0
      ) {
        return;
      }

      const seq = beginRoomSwitch(chatId);
      socketRef.current?.emit(
        "chats:switch",
        { chatId },
        (result: SessionAck) => {
          if (seq !== switchSeqRef.current) return;
          if (!result?.ok || !result.session) {
            restorePreviousRoom(result?.error || "Не удалось открыть чат");
            return;
          }
          expectedRoomRef.current = result.session.room;
          setSession(result.session);
        },
      );
    },
    [beginRoomSwitch, restorePreviousRoom],
  );

  const openDm = useCallback(
    (userId: string) => {
      const seq = beginRoomSwitch();
      socketRef.current?.emit("dm:open", { userId }, (result: SessionAck) => {
        if (seq !== switchSeqRef.current) return;
        if (!result?.ok || !result.session) {
          restorePreviousRoom(result?.error || "Не удалось открыть ЛС");
          return;
        }
        expectedRoomRef.current = result.session.room;
        setSession(result.session);
        const cached = historyCacheRef.current.get(result.session.room);
        if (cached?.length) {
          setMessages(cached);
          setHistoryLoading(false);
        }
      });
    },
    [beginRoomSwitch, restorePreviousRoom],
  );

  const createGroup = useCallback(
    (
      title: string,
      topic: string,
      visibility: GroupVisibility = "public",
    ) => {
      return new Promise<{ ok: boolean; error?: string; room?: string }>(
        (resolve) => {
          const socket = socketRef.current;
          if (!socket?.connected) {
            setSidebarError("Нет соединения");
            resolve({ ok: false, error: "Нет соединения" });
            return;
          }
          const seq = beginRoomSwitch();
          let settled = false;
          const finish = (result: {
            ok: boolean;
            error?: string;
            room?: string;
          }) => {
            if (settled) return;
            settled = true;
            window.clearTimeout(timer);
            resolve(result);
          };
          const timer = window.setTimeout(() => {
            restorePreviousRoom("Сервер не ответил");
            finish({ ok: false, error: "Сервер не ответил" });
          }, 15_000);
          socket.emit(
            "group:create",
            { title, topic, memberIds: [], visibility },
            (result: SessionAck) => {
              if (seq !== switchSeqRef.current) {
                finish({ ok: false, error: "Отменено" });
                return;
              }
              if (!result?.ok || !result.session) {
                restorePreviousRoom(
                  result?.error || "Не удалось создать группу",
                );
                finish({
                  ok: false,
                  error: result?.error || "Не удалось создать группу",
                });
                return;
              }
              expectedRoomRef.current = result.session.room;
              setSession(result.session);
              finish({ ok: true, room: result.session.room });
            },
          );
        },
      );
    },
    [beginRoomSwitch, restorePreviousRoom],
  );

  const joinPublicGroup = useCallback(
    (groupId: string) => {
      return new Promise<{ ok: boolean; error?: string }>((resolve) => {
        const socket = socketRef.current;
        if (!socket?.connected) {
          resolve({ ok: false, error: "Нет соединения" });
          return;
        }
        const seq = beginRoomSwitch(groupId);
        let settled = false;
        const finish = (result: { ok: boolean; error?: string }) => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timer);
          resolve(result);
        };
        const timer = window.setTimeout(() => {
          restorePreviousRoom("Сервер не ответил");
          finish({ ok: false, error: "Сервер не ответил" });
        }, 15_000);
        socket.emit(
          "group:join",
          { groupId },
          (result: SessionAck) => {
            if (seq !== switchSeqRef.current) {
              finish({ ok: false, error: "Отменено" });
              return;
            }
            if (!result?.ok || !result.session) {
              restorePreviousRoom(result?.error || "Не удалось присоединиться");
              finish({
                ok: false,
                error: result?.error || "Не удалось присоединиться",
              });
              return;
            }
            expectedRoomRef.current = result.session.room;
            setSession(result.session);
            finish({ ok: true });
          },
        );
      });
    },
    [beginRoomSwitch, restorePreviousRoom],
  );

  const updateGroupVisibility = useCallback(
    (groupId: string, visibility: GroupVisibility) =>
      new Promise<boolean>((resolve) => {
        setSidebarError(null);
        const socket = socketRef.current;
        if (!socket?.connected) {
          setSidebarError("Нет соединения");
          resolve(false);
          return;
        }
        let settled = false;
        const finish = (ok: boolean) => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timer);
          resolve(ok);
        };
        const timer = window.setTimeout(() => {
          setSidebarError("Сервер не ответил");
          finish(false);
        }, 12_000);
        socket.emit(
          "group:visibility",
          { groupId, visibility },
          (result: { ok?: boolean; error?: string }) => {
            if (!result?.ok) {
              setSidebarError(
                result?.error || "Не удалось изменить доступ группы",
              );
              finish(false);
              return;
            }
            finish(true);
          },
        );
      }),
    [],
  );

  const inviteToGroup = useCallback(
    (groupId: string, userId: string) =>
      new Promise<{ ok: boolean; error?: string }>((resolve) => {
        const socket = socketRef.current;
        if (!socket?.connected) {
          resolve({ ok: false, error: "Нет соединения" });
          return;
        }
        const timer = window.setTimeout(() => {
          resolve({ ok: false, error: "Сервер не ответил" });
        }, 12_000);
        socket.emit(
          "group:invite",
          { groupId, userId },
          (result: { ok?: boolean; error?: string }) => {
            window.clearTimeout(timer);
            resolve({
              ok: Boolean(result?.ok),
              error: result?.error,
            });
          },
        );
      }),
    [],
  );

  const respondGroupInvite = useCallback(
    (chatId: string, messageId: string, accept: boolean) =>
      new Promise<{ ok: boolean; error?: string; groupId?: string }>(
        (resolve) => {
          socketRef.current?.emit(
            "group:invite:respond",
            { chatId, messageId, accept },
            (result: {
              ok?: boolean;
              error?: string;
              groupId?: string;
            }) => {
              resolve({
                ok: Boolean(result?.ok),
                error: result?.error,
                groupId: result?.groupId,
              });
            },
          );
        },
      ),
    [],
  );

  const createVoiceChannel = useCallback(
    (groupId: string, title: string) =>
      new Promise<{ ok: boolean; error?: string; channelId?: string }>(
        (resolve) => {
          socketRef.current?.emit(
            "voice:create",
            { groupId, title },
            (result: {
              ok?: boolean;
              error?: string;
              channel?: { id: string; title: string };
            }) => {
              if (!result?.ok) {
                resolve({
                  ok: false,
                  error: result?.error || "Не удалось создать канал",
                });
                return;
              }
              resolve({ ok: true, channelId: result.channel?.id });
            },
          );
        },
      ),
    [],
  );

  const deleteVoiceChannel = useCallback(
    (groupId: string, channelId: string) =>
      new Promise<{ ok: boolean; error?: string }>((resolve) => {
        socketRef.current?.emit(
          "voice:delete",
          { groupId, channelId },
          (result: { ok?: boolean; error?: string }) => {
            if (!result?.ok) {
              resolve({
                ok: false,
                error: result?.error || "Не удалось удалить канал",
              });
              return;
            }
            resolve({ ok: true });
          },
        );
      }),
    [],
  );

  const updateGroupAvatar = useCallback(
    (chatId: string, avatarUrl: string | null) =>
      new Promise<boolean>((resolve) => {
        setSidebarError(null);
        socketRef.current?.emit(
          "group:avatar",
          { chatId, avatarUrl },
          (result: { ok?: boolean; error?: string }) => {
            if (!result?.ok) {
              setSidebarError(
                result?.error || "Не удалось обновить аватар группы",
              );
              resolve(false);
              return;
            }
            resolve(true);
          },
        );
      }),
    [],
  );

  const updateGroupProfile = useCallback(
    (chatId: string, patch: { title?: string; topic?: string }) =>
      new Promise<boolean>((resolve) => {
        setSidebarError(null);
        socketRef.current?.emit(
          "group:update",
          { chatId, ...patch },
          (result: { ok?: boolean; error?: string }) => {
            if (!result?.ok) {
              setSidebarError(
                result?.error || "Не удалось обновить группу",
              );
              resolve(false);
              return;
            }
            resolve(true);
          },
        );
      }),
    [],
  );

  const fetchRoomMedia = useCallback(
    (
      chatId: string,
      kind: "media" | "file" | "all" = "all",
      offset = 0,
      limit = 48,
    ) =>
      new Promise<{
        items: RoomMediaItem[];
        total: number;
        hasMore: boolean;
        error?: string;
      }>((resolve) => {
        const socket = socketRef.current;
        if (!socket?.connected) {
          resolve({
            items: [],
            total: 0,
            hasMore: false,
            error: "Нет соединения",
          });
          return;
        }
        socket.emit(
          "room:media",
          { chatId, kind, offset, limit },
          (result: {
            ok?: boolean;
            items?: RoomMediaItem[];
            total?: number;
            hasMore?: boolean;
            error?: string;
          }) => {
            if (!result?.ok) {
              resolve({
                items: [],
                total: 0,
                hasMore: false,
                error: result?.error || "Не удалось загрузить",
              });
              return;
            }
            resolve({
              items: Array.isArray(result.items) ? result.items : [],
              total: Number(result.total) || 0,
              hasMore: Boolean(result.hasMore),
            });
          },
        );
      }),
    [],
  );

  const leave = useCallback(() => {
    switchSeqRef.current += 1;
    expectedRoomRef.current = null;
    pendingAckTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    pendingAckTimersRef.current.clear();
    socketRef.current?.emit("leave");
    setSession(null);
    setMessages([]);
    setHistoryLoading(false);
    setOnline([]);
    setTypingUsers([]);
    setComposerError(null);
  }, []);

  const sendMessage = useCallback((text: string, replyToId?: string) => {
    const value = text.trim();
    if (!value) return false;
    const account = accountRef.current;
    const session = sessionRef.current;
    const socket = socketRef.current;
    if (!account || !session?.room || !socket?.connected) {
      setComposerError("Нет соединения");
      return false;
    }
    if (
      historyLoading ||
      !expectedRoomRef.current ||
      expectedRoomRef.current !== session.room
    ) {
      setComposerError("Чат ещё открывается — подождите");
      return false;
    }

    setComposerError(null);
    const room = session.room;
    const clientId =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `msg_${Date.now()}_${Math.random().toString(16).slice(2)}`;

    setMessages((prev) => {
      const source = replyToId
        ? prev.find((item) => item.id === replyToId)
        : undefined;
      const optimistic: ChatMessage = {
        id: clientId,
        clientKey: clientId,
        room,
        author: account.displayName || account.username,
        authorId: account.userId,
        text: value,
        createdAt: Date.now(),
        kind: "text",
        status: "pending",
        replyTo: source
          ? {
              id: source.id,
              author: source.author,
              text:
                source.kind === "file"
                  ? `Файл: ${source.file?.name || source.text}`
                  : source.text.slice(0, 140),
            }
          : undefined,
      };
      return [...prev, optimistic];
    });
    socket.emit("typing", false);

    const fail = () => {
      pendingAckTimersRef.current.delete(clientId);
      setMessages((prev) =>
        prev.map((item) =>
          item.id === clientId ? { ...item, status: "failed" } : item,
        ),
      );
    };

    const timer = window.setTimeout(fail, 12_000);
    pendingAckTimersRef.current.set(clientId, timer);
    socket.emit(
      "message",
      {
        text: value,
        replyToId: replyToId || undefined,
        clientId,
        chatId: room,
      },
      (ack: { ok?: boolean; message?: ChatMessage; error?: string }) => {
        const active = pendingAckTimersRef.current.get(clientId);
        if (active) {
          window.clearTimeout(active);
          pendingAckTimersRef.current.delete(clientId);
        }
        if (!ack?.ok) {
          fail();
          if (ack?.error) setComposerError(ack.error);
          return;
        }
        setMessages((prev) =>
          prev.map((item) =>
            item.id === clientId
              ? {
                  ...(ack.message || item),
                  clientKey: item.clientKey || clientId,
                  status: undefined,
                }
              : item,
          ),
        );
      },
    );
    return true;
  }, [historyLoading]);

  const retryMessage = useCallback((messageId: string) => {
    const socket = socketRef.current;
    const session = sessionRef.current;
    if (!socket?.connected || !session?.room || !expectedRoomRef.current) {
      setComposerError("Нет соединения");
      return;
    }

    const message = messagesRef.current.find((item) => item.id === messageId);
    if (!message || message.status !== "failed") return;

    setMessages((prev) =>
      prev.map((item) =>
        item.id === messageId ? { ...item, status: "pending" } : item,
      ),
    );

    const fail = () => {
      pendingAckTimersRef.current.delete(messageId);
      setMessages((current) =>
        current.map((item) =>
          item.id === messageId ? { ...item, status: "failed" } : item,
        ),
      );
    };

    const timer = window.setTimeout(fail, 12_000);
    pendingAckTimersRef.current.set(messageId, timer);
    socket.emit(
      "message",
      {
        text: message.text,
        replyToId: message.replyTo?.id,
        clientId: message.id,
        chatId: session.room,
      },
      (ack: { ok?: boolean; message?: ChatMessage; error?: string }) => {
        const active = pendingAckTimersRef.current.get(messageId);
        if (active) {
          window.clearTimeout(active);
          pendingAckTimersRef.current.delete(messageId);
        }
        if (!ack?.ok) {
          fail();
          if (ack?.error) setComposerError(ack.error);
          return;
        }
        setMessages((current) =>
          current.map((item) =>
            item.id === messageId
              ? { ...(ack.message || item), status: undefined }
              : item,
          ),
        );
      },
    );
  }, []);

  const cancelUpload = useCallback(() => {
    uploadAbortRef.current?.abort();
  }, []);

  const sendFiles = useCallback(
    async (
      files: File[],
      options?: {
        caption?: string;
        replyToId?: string;
        onProgress?: (ratio: number) => void;
      },
    ): Promise<{ ok: boolean; completed: File[] }> => {
      if (!account?.token) {
        setComposerError("Нужен вход");
        return { ok: false, completed: [] };
      }
      if (!files.length) return { ok: false, completed: [] };

      const chatId = sessionRef.current?.room;
      if (!chatId || !expectedRoomRef.current || expectedRoomRef.current !== chatId) {
        setComposerError("Чат ещё открывается — подождите");
        return { ok: false, completed: [] };
      }
      if (!socketRef.current?.connected) {
        setComposerError("Нет соединения — подождите и попробуйте снова");
        return { ok: false, completed: [] };
      }

      const batchRaw = files.slice(0, MAX_FILES_AT_ONCE);
      const batch = await compressUploadBatch(batchRaw);
      for (const file of batch) {
        const invalid = validateFile(file);
        if (invalid) {
          setComposerError(invalid);
          return { ok: false, completed: [] };
        }
      }

      setComposerError(null);
      const caption = options?.caption?.trim() || "";
      const totalBytes = batch.reduce((sum, file) => sum + file.size, 0) || 1;
      let loadedBytes = 0;
      const completed: File[] = [];
      const uploadedFiles: {
        url: string;
        name: string;
        size: number;
        mime: string;
      }[] = [];

      const controller = new AbortController();
      uploadAbortRef.current = controller;

      const asAlbum =
        batch.length > 1 &&
        batch.every((file) => isMediaAttachment(file));

      try {
        if (asAlbum) {
          const loadedParts = new Array(batch.length).fill(0);
          const reportProgress = () => {
            const current = loadedParts.reduce((sum, part) => sum + part, 0);
            options?.onProgress?.(Math.min(0.97, current / totalBytes));
          };
          const uploadedList = await runPool(batch, 3, async (file, index) => {
            if (controller.signal.aborted) {
              throw new Error("Загрузка отменена");
            }
            const uploaded = await uploadFileWithRetry(file, account.token, {
              signal: controller.signal,
              onProgress: (ratio) => {
                loadedParts[index] = file.size * ratio;
                reportProgress();
              },
            });
            loadedParts[index] = file.size;
            completed.push(batchRaw[index] ?? file);
            reportProgress();
            return uploaded;
          });
          uploadedFiles.push(...uploadedList);
          options?.onProgress?.(0.99);
        } else {
          for (let index = 0; index < batch.length; index += 1) {
          if (controller.signal.aborted) {
            throw new Error("Загрузка отменена");
          }

          const file = batch[index];
          const uploaded = await uploadFileWithRetry(file, account.token, {
            signal: controller.signal,
            onProgress: (ratio) => {
              const current = loadedBytes + file.size * ratio;
              // Leave a little room for the socket send after HTTP finishes.
              options?.onProgress?.(Math.min(0.97, current / totalBytes));
            },
          });
          loadedBytes += file.size;
          uploadedFiles.push(uploaded);
          // Composer tracks pending by original File refs; compression may replace them.
          completed.push(batchRaw[index] ?? file);
          options?.onProgress?.(Math.min(0.99, loadedBytes / totalBytes));

          await new Promise<void>((resolve, reject) => {
            const socket = socketRef.current;
            if (!socket?.connected) {
              reject(new Error("Нет соединения"));
              return;
            }

            const timer = window.setTimeout(() => {
              reject(new Error("Сервер не ответил на отправку файла"));
            }, 15_000);

            socket.emit(
              "message:file",
              {
                chatId,
                file: uploaded,
                text: caption
                  ? caption
                  : isMediaAttachment(uploaded)
                    ? ""
                    : isAudioAttachment(uploaded)
                      ? isVoiceNote(uploaded)
                        ? "Голосовое сообщение"
                        : audioDisplayName(uploaded)
                      : uploaded.name,
                replyToId: options?.replyToId || undefined,
              },
              (ack: { ok: boolean; error?: string }) => {
                window.clearTimeout(timer);
                if (!ack?.ok) {
                  reject(new Error(ack?.error || "Файл не отправился"));
                  return;
                }
                resolve();
              },
            );
          });
        }
        }

        if (asAlbum) {
          await new Promise<void>((resolve, reject) => {
            const socket = socketRef.current;
            if (!socket?.connected) {
              reject(new Error("Нет соединения"));
              return;
            }

            const timer = window.setTimeout(() => {
              reject(new Error("Сервер не ответил на отправку альбома"));
            }, 20_000);

            socket.emit(
              "message:file",
              {
                chatId,
                files: uploadedFiles,
                file: uploadedFiles[0],
                text: caption,
                replyToId: options?.replyToId || undefined,
              },
              (ack: { ok: boolean; error?: string }) => {
                window.clearTimeout(timer);
                if (!ack?.ok) {
                  reject(new Error(ack?.error || "Альбом не отправился"));
                  return;
                }
                resolve();
              },
            );
          });
        }

        options?.onProgress?.(1);
        return { ok: true, completed };
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : completed.length
              ? "Часть файлов не отправилась"
              : "Не удалось загрузить файл";
        setComposerError(message);
        return { ok: false, completed };
      } finally {
        if (uploadAbortRef.current === controller) {
          uploadAbortRef.current = null;
        }
      }
    },
    [account?.token],
  );

  const sendFile = useCallback(
    async (file: File) => {
      await sendFiles([file]);
    },
    [sendFiles],
  );

  const logCall = useCallback((chatId: string, text: string) => {
    socketRef.current?.emit("call:log", { chatId, text });
  }, []);

  const togglePin = useCallback((chatId: string) => {
    socketRef.current?.emit("chats:pin", { chatId });
  }, []);

  const reconnect = useCallback(() => {
    const socket = socketRef.current;
    if (!socket) return;
    setReconnecting(true);
    if (socket.connected) {
      socket.disconnect();
    }
    socket.connect();
  }, []);

  const markAllRead = useCallback(() => {
    const socket = socketRef.current;
    if (!socket) return;
    const unread = chats.filter((chat) => chat.unreadCount > 0);
    for (const chat of unread) {
      socket.emit("chats:read", { chatId: chat.id });
    }
  }, [chats]);

  const reactToMessage = useCallback(
    (chatId: string, messageId: string, emoji: string) => {
      socketRef.current?.emit("message:react", { chatId, messageId, emoji });
    },
    [],
  );

  const setTyping = useCallback((isTyping: boolean) => {
    socketRef.current?.emit("typing", isTyping);
  }, []);

  const clearComposerError = useCallback(() => setComposerError(null), []);
  const clearProfileError = useCallback(() => setProfileError(null), []);

  const othersTyping = useMemo(() => {
    const self = new Set(
      [account?.username, account?.displayName, session?.name]
        .filter(Boolean)
        .map((name) => String(name).toLowerCase()),
    );
    return typingUsers.filter((name) => !self.has(name.toLowerCase()));
  }, [account?.displayName, account?.username, session?.name, typingUsers]);

  const currentChat = useMemo(
    () => chats.find((chat) => chat.id === session?.room) ?? null,
    [chats, session?.room],
  );

  const unreadTotal = useMemo(
    () => chats.reduce((sum, chat) => sum + (chat.unreadCount || 0), 0),
    [chats],
  );

  useEffect(() => {
    if (typeof document === "undefined") return;
    document.title = unreadTotal > 0 ? `(${unreadTotal}) Pulse` : "Pulse";
  }, [unreadTotal]);

  useEffect(() => {
    function markVisibleRead() {
      if (typeof document === "undefined" || document.hidden) return;
      const room = expectedRoomRef.current || sessionRef.current?.room;
      if (!room) return;
      socketRef.current?.emit("chats:read", { chatId: room });
    }

    document.addEventListener("visibilitychange", markVisibleRead);
    window.addEventListener("focus", markVisibleRead);
    return () => {
      document.removeEventListener("visibilitychange", markVisibleRead);
      window.removeEventListener("focus", markVisibleRead);
    };
  }, []);

  const discardMessage = useCallback((messageId: string) => {
    const timer = pendingAckTimersRef.current.get(messageId);
    if (timer) {
      window.clearTimeout(timer);
      pendingAckTimersRef.current.delete(messageId);
    }
    setMessages((prev) =>
      prev.filter(
        (item) => !(item.id === messageId && item.status === "failed"),
      ),
    );
  }, []);

  const deleteMessage = useCallback((chatId: string, messageId: string) => {
    const optimistic = () => {
      const cached = historyCacheRef.current.get(chatId);
      if (cached) {
        historyCacheRef.current.set(
          chatId,
          cached.filter((item) => item.id !== messageId),
        );
      }
      const currentRoom = expectedRoomRef.current || sessionRef.current?.room;
      if (currentRoom === chatId) {
        setMessages((prev) => prev.filter((item) => item.id !== messageId));
      }
    };

    optimistic();
    socketRef.current?.emit(
      "message:delete",
      { chatId, messageId },
      (result: { ok?: boolean; error?: string }) => {
        if (!result?.ok) {
          setComposerError(result?.error || "Не удалось удалить сообщение");
        }
      },
    );
  }, []);

  const editMessage = useCallback(
    (chatId: string, messageId: string, text: string) => {
      socketRef.current?.emit(
        "message:edit",
        { chatId, messageId, text },
        (result: { ok?: boolean; error?: string }) => {
          if (!result?.ok) {
            setComposerError(result?.error || "Не удалось изменить сообщение");
          }
        },
      );
    },
    [],
  );

  const pinMessage = useCallback((chatId: string, messageId: string) => {
    socketRef.current?.emit(
      "message:pin",
      { chatId, messageId },
      (result: { ok?: boolean; error?: string }) => {
        if (!result?.ok) {
          setComposerError(result?.error || "Не удалось закрепить");
        }
      },
    );
  }, []);

  const forwardMessage = useCallback(
    (fromChatId: string, messageId: string, toChatId: string) => {
      return new Promise<boolean>((resolve) => {
        socketRef.current?.emit(
          "message:forward",
          { fromChatId, messageId, toChatId },
          (result: { ok?: boolean; error?: string }) => {
            if (!result?.ok) {
              setComposerError(result?.error || "Не удалось переслать");
              resolve(false);
              return;
            }
            resolve(true);
          },
        );
      });
    },
    [],
  );

  const markChatVisibleRead = useCallback((chatId?: string) => {
    const room =
      chatId || expectedRoomRef.current || sessionRef.current?.room || "";
    if (!room) return;
    if (typeof document !== "undefined" && document.hidden) return;
    socketRef.current?.emit("chats:read", { chatId: room });
  }, []);

  const refreshChatMembers = useCallback((chatId?: string) => {
    const room =
      chatId || expectedRoomRef.current || sessionRef.current?.room || "";
    if (!room) {
      setChatMembers([]);
      return;
    }
    socketRef.current?.emit(
      "chats:members",
      { chatId: room },
      (result: { ok?: boolean; members?: PeopleUser[] }) => {
        if (result?.ok && Array.isArray(result.members)) {
          setChatMembers(result.members);
        }
      },
    );
  }, []);

  useEffect(() => {
    if (!session?.room) {
      setChatMembers([]);
      return;
    }
    refreshChatMembers(session.room);
  }, [session?.room, currentChat?.members, refreshChatMembers]);

  // Keep guild roster presence in sync with global people updates.
  useEffect(() => {
    if (!people.length) return;
    setChatMembers((prev) => {
      if (!prev.length) return prev;
      let changed = false;
      const next = prev.map((member) => {
        const live = people.find((user) => user.id === member.id);
        if (!live || live.online === member.online) return member;
        changed = true;
        return { ...member, online: live.online };
      });
      return changed ? next : prev;
    });
  }, [people]);

  const deleteGroup = useCallback((chatId: string) => {
    return new Promise<boolean>((resolve) => {
      setSidebarError(null);
      socketRef.current?.emit(
        "group:delete",
        { chatId },
        (result: { ok?: boolean; error?: string }) => {
          if (!result?.ok) {
            setSidebarError(result?.error || "Не удалось удалить группу");
            resolve(false);
            return;
          }
          historyCacheRef.current.delete(chatId);
          setChats((prev) => prev.filter((chat) => chat.id !== chatId));
          const currentRoom =
            expectedRoomRef.current || sessionRef.current?.room;
          if (currentRoom === chatId) {
            switchSeqRef.current += 1;
            expectedRoomRef.current = null;
            setSession(null);
            setMessages([]);
            setTypingUsers([]);
          }
          resolve(true);
        },
      );
    });
  }, []);

  const leaveGroup = useCallback((chatId: string) => {
    return new Promise<boolean>((resolve) => {
      setSidebarError(null);
      socketRef.current?.emit(
        "group:leave",
        { chatId },
        (result: { ok?: boolean; error?: string }) => {
          if (!result?.ok) {
            setSidebarError(result?.error || "Не удалось выйти из группы");
            resolve(false);
            return;
          }
          historyCacheRef.current.delete(chatId);
          setChats((prev) => prev.filter((chat) => chat.id !== chatId));
          const currentRoom =
            expectedRoomRef.current || sessionRef.current?.room;
          if (currentRoom === chatId) {
            switchSeqRef.current += 1;
            expectedRoomRef.current = null;
            setSession(null);
            setMessages([]);
            setTypingUsers([]);
          }
          resolve(true);
        },
      );
    });
  }, []);

  const searchPeople = useCallback((query: string) => {
    return new Promise<PeopleUser[]>((resolve) => {
      const socket = socketRef.current;
      if (!socket?.connected) {
        resolve([]);
        return;
      }
      socket.emit(
        "people:search",
        { query },
        (result: { ok?: boolean; users?: PeopleUser[] }) => {
          resolve(result?.ok && Array.isArray(result.users) ? result.users : []);
        },
      );
    });
  }, []);

  const suggestPeople = useCallback(() => {
    return new Promise<PeopleUser[]>((resolve) => {
      const socket = socketRef.current;
      if (!socket?.connected) {
        resolve([]);
        return;
      }
      const timer = window.setTimeout(() => resolve([]), 8_000);
      socket.emit(
        "people:suggest",
        {},
        (result: { ok?: boolean; users?: PeopleUser[] }) => {
          window.clearTimeout(timer);
          resolve(result?.ok && Array.isArray(result.users) ? result.users : []);
        },
      );
    });
  }, []);

  const searchPublicGroups = useCallback((query: string) => {
    return new Promise<{
      ok: boolean;
      groups: PublicGroupHit[];
    }>((resolve) => {
      const socket = socketRef.current;
      if (!socket?.connected) {
        resolve({ ok: false, groups: [] });
        return;
      }
      const timer = window.setTimeout(
        () => resolve({ ok: false, groups: [] }),
        8_000,
      );
      socket.emit(
        "groups:search",
        { query },
        (result: { ok?: boolean; groups?: PublicGroupHit[] }) => {
          window.clearTimeout(timer);
          const groups =
            result?.ok && Array.isArray(result.groups) ? result.groups : [];
          resolve({ ok: Boolean(result?.ok), groups });
        },
      );
    });
  }, []);

  return {
    socket,
    connected,
    reconnecting,
    authReady,
    unreadTotal,
    account,
    session,
    messages,
    historyLoading,
    online,
    chats,
    people,
    currentChat,
    othersTyping,
    peerReadAt,
    chatMembers,
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
    leave,
    sendMessage,
    retryMessage,
    discardMessage,
    deleteMessage,
    editMessage,
    pinMessage,
    forwardMessage,
    markChatVisibleRead,
    refreshChatMembers,
    deleteGroup,
    leaveGroup,
    searchPeople,
    suggestPeople,
    searchPublicGroups,
    sendFile,
    sendFiles,
    cancelUpload,
    logCall,
    togglePin,
    reconnect,
    markAllRead,
    reactToMessage,
    setTyping,
    clearComposerError,
    clearProfileError,
  };
}

