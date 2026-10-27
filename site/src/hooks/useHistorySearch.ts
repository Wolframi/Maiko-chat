"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Socket } from "socket.io-client";

type SearchPage = { ids: string[]; after: string | null; hasMore: boolean };
type SearchAck = Partial<SearchPage> & { ok?: boolean; chatId?: string; error?: string };
const emptyPage: SearchPage = { ids: [], after: null, hasMore: false };

/** Search transfers IDs only; opening a hit loads its context separately. */
export function useHistorySearch(socket: Socket | null, connected: boolean, chatId: string | undefined, query: string) {
  const [page, setPage] = useState<SearchPage>(emptyPage);
  const [index, setIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef({ value: 0 });
  const busy = useRef(false);
  const current = useRef({ page, index });
  current.current = { page, index };

  const fetchPage = useCallback((after?: string): Promise<SearchPage | null> => {
    if (!socket?.connected || !chatId || !query.trim()) return Promise.resolve(null);
    const epoch = generation.current.value;
    busy.current = true;
    setLoading(true);
    setError(null);
    return new Promise(resolve => socket.timeout(15_000).emit("history:search", { chatId, query, after },
      (timeout: Error | null, result: SearchAck) => {
        if (epoch !== generation.current.value) { resolve(null); return; }
        busy.current = false;
        setLoading(false);
        if (timeout || !result?.ok || result.chatId !== chatId || !Array.isArray(result.ids)) {
          setError(result?.error || "Не удалось выполнить поиск"); resolve(null); return;
        }
        resolve({ ids: result.ids, after: result.after ?? null, hasMore: Boolean(result.hasMore) });
      }));
  }, [socket, chatId, query]);

  useEffect(() => {
    const lifecycle = generation.current;
    lifecycle.value++;
    busy.current = false;
    setPage(emptyPage);
    setIndex(0);
    setError(null);
    setLoading(Boolean(query.trim() && connected));
    const timer = setTimeout(() => { void fetchPage().then(result => { if (result) setPage(result); }); }, 300);
    return () => { clearTimeout(timer); lifecycle.value++; };
  }, [fetchPage, connected, query]);

  const move = useCallback(async (direction: -1 | 1) => {
    if (busy.current) return;
    const { page: previous, index: at } = current.current;
    if (direction === 1 && (at === previous.ids.length - 1 || !previous.ids.length) && previous.hasMore) {
      const result = await fetchPage(previous.after ?? undefined);
      if (!result) return;
      const ids = [...previous.ids, ...result.ids.filter(id => !previous.ids.includes(id))];
      setPage({ ...result, ids });
      setIndex(Math.min(at + 1, Math.max(0, ids.length - 1)));
    } else if (previous.ids.length) {
      setIndex((at + direction + previous.ids.length) % previous.ids.length);
    } else {
      const result = await fetchPage();
      if (result) setPage(result);
    }
  }, [fetchPage]);

  return { ids: page.ids, index, activeId: page.ids[index] ?? null, hasMore: page.hasMore, loading, error, move };
}
