"use client";

import { useState, useCallback, useRef, useEffect, useMemo, useLayoutEffect } from "react";
import { motion } from "motion/react";
import { IconSearch, IconClose } from "@/lib/icons";
import { layoutGifMosaic } from "@/lib/gifMosaic";
import { ChatImage } from "@/components/chat/ChatImage";
import { sessionHeaders } from "@/lib/sessionHeaders";

type GifResult = {
  id: string;
  title: string;
  url: string;
  preview: string;
  width: number;
  height: number;
};

type GifPickerProps = {
  onSelect: (url: string, size?: { width: number; height: number }) => void;
  onClose: () => void;
  open: boolean;
};

// ============================================
// Клиентский кэш (живёт в памяти, сбрасывается при перезагрузке)
// ============================================
type ClientCacheEntry = {
  results: GifResult[];
  next: string;
  timestamp: number;
};

const clientCache = new Map<string, ClientCacheEntry>();

// TTL для клиентского кэша
const CLIENT_TTL_TRENDING = 10 * 60 * 1000;  // 10 минут
const CLIENT_TTL_SEARCH = 5 * 60 * 1000;      // 5 минут

function getClientCacheKey(query: string, offset: number): string {
  return `${query.toLowerCase()}:${offset}`;
}

function getClientCache(key: string, ttl: number): ClientCacheEntry | null {
  const entry = clientCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > ttl) {
    clientCache.delete(key);
    return null;
  }
  return entry;
}

// ============================================
// Компонент
// ============================================
export function GifPicker({ onSelect, onClose, open }: GifPickerProps) {
  const [query, setQuery] = useState<string>("");
  const [gifs, setGifs] = useState<GifResult[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [nextPos, setNextPos] = useState<string>("");
  const [hasMore, setHasMore] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const searchQuery = query.trim().length >= 2 ? query.trim() : "";

  const gridRef = useRef<HTMLDivElement>(null);
  const widthProbeRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const requestRef = useRef<{ id: number; controller: AbortController | null }>({ id: 0, controller: null });
  const lastQueryRef = useRef<string>("");
  const isLoadingMoreRef = useRef<boolean>(false);
  const [mosaicWidth, setMosaicWidth] = useState(0);

  useEffect(() => {
    if (!open) return;
    // На телефоне autoFocus открывал клавиатуру сразу — фокус только с мышью.
    if (window.matchMedia("(pointer: coarse)").matches) return;
    searchInputRef.current?.focus();
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const el = widthProbeRef.current;
    if (!el) return;

    const apply = (nextWidth: number) => {
      const next = Math.max(0, Math.floor(nextWidth));
      setMosaicWidth((prev) => (prev === next ? prev : next));
    };

    apply(el.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => {
      apply(entries[0]?.contentRect.width ?? 0);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [open]);

  const mosaic = useMemo(
    () => layoutGifMosaic(gifs, mosaicWidth),
    [gifs, mosaicWidth],
  );

  // ============================================
  // Загрузка с кэшированием
  // ============================================
  const loadGifs = useCallback(async (reset: boolean, currentQuery: string, offset = 0) => {
    if (isLoadingMoreRef.current && !reset) return;
    requestRef.current.controller?.abort();
    const controller = new AbortController();
    const id = ++requestRef.current.id;
    requestRef.current.controller = controller;
    isLoadingMoreRef.current = true;
    setLoading(true);
    setError(null);
    const current = () => requestRef.current.id === id && !controller.signal.aborted;
    const cacheKey = getClientCacheKey(currentQuery, offset);
    const ttl = currentQuery ? CLIENT_TTL_SEARCH : CLIENT_TTL_TRENDING;
    try {
      let entry = getClientCache(cacheKey, ttl);
      if (!entry) {
        const params = new URLSearchParams({ limit: "20" });
        if (currentQuery) params.set("q", currentQuery);
        if (offset) params.set("pos", String(offset));
        const response = await fetch(`/api/gif?${params}`, {
          headers: sessionHeaders(), cache: "no-store", signal: controller.signal,
        });
        if (!response.ok) throw new Error("Не удалось загрузить GIF. Попробуйте ещё раз.");
        const data = await response.json();
        if (!current()) return;
        entry = { results: data.results || [], next: data.next || "", timestamp: Date.now() };
        while (clientCache.size >= 64) clientCache.delete(clientCache.keys().next().value!);
        clientCache.set(cacheKey, entry);
      }
      if (!current()) return;
      const { results, next } = entry;
      setGifs(previous => {
        if (reset) return results;
        const ids = new Set(previous.map(gif => gif.id));
        return [...previous, ...results.filter(gif => !ids.has(gif.id))];
      });
      setNextPos(next);
      setHasMore(Boolean(next) && results.length > 0);
    } catch (error) {
      if (current()) setError(error instanceof Error ? error.message : "Не удалось загрузить GIF");
    } finally {
      if (current()) {
        setLoading(false);
        isLoadingMoreRef.current = false;
      }
    }
  }, []);

  // Cancel stale searches immediately, including during the debounce interval.
  useEffect(() => {
    if (!open) return;
    const request = requestRef.current;
    const currentQuery = searchQuery;
    lastQueryRef.current = currentQuery;
    isLoadingMoreRef.current = true;
    setLoading(true);
    setError(null);
    const delay = getClientCache(getClientCacheKey(currentQuery, 0), currentQuery ? CLIENT_TTL_SEARCH : CLIENT_TTL_TRENDING)
      ? 0 : currentQuery ? 300 : 0;
    const timer = setTimeout(() => {
      setGifs([]);
      setNextPos("");
      setHasMore(true);
      void loadGifs(true, currentQuery);
    }, delay);
    return () => {
      clearTimeout(timer);
      request.controller?.abort();
      request.id++;
      isLoadingMoreRef.current = false;
    };
  }, [open, searchQuery, loadGifs]);

  useEffect(() => {
    if (!open || !gridRef.current) return;

    if (observerRef.current) {
      observerRef.current.disconnect();
    }

    observerRef.current = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (
          entry?.isIntersecting &&
          !loading &&
          !isLoadingMoreRef.current &&
          hasMore &&
          gifs.length > 0
        ) {
          void loadGifs(false, lastQueryRef.current, Number(nextPos) || 0);
        }
      },
      {
        threshold: 0.1,
        rootMargin: '200px', // Начинаем грузить заранее
        root: gridRef.current,
      }
    );

    if (sentinelRef.current) {
      observerRef.current.observe(sentinelRef.current);
    }

    return () => {
      if (observerRef.current) {
        observerRef.current.disconnect();
      }
    };
  }, [open, gifs, loading, hasMore, loadGifs, nextPos]);

  // ============================================
  // Обработчик выбора GIF
  // ============================================
  const handleSelect = useCallback(
    (gif: GifResult) => {
      onSelect(gif.url, { width: gif.width, height: gif.height });
      onClose();
    },
    [onSelect, onClose]
  );

  if (!open) return null;

  return (
    <motion.div
      className="gif-picker"
      initial={{ opacity: 0, y: 10, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 10, scale: 0.95 }}
      transition={{ duration: 0.2 }}
    >
      <div className="gif-picker__header">
        <div className="gif-picker__search">
          <IconSearch size={18} />
          <input
            ref={searchInputRef}
            type="text"
            placeholder="Поиск GIF..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && (
            <button onClick={() => setQuery("")} aria-label="Очистить">
              <IconClose size={16} />
            </button>
          )}
        </div>
        <button className="gif-picker__close" onClick={onClose} aria-label="Закрыть">
          <IconClose size={20} />
        </button>
      </div>

      {error ? (
        <div className="gif-picker__error">
          {error}
          <button type="button" onClick={() => void loadGifs(gifs.length === 0, lastQueryRef.current, gifs.length ? Number(nextPos) || 0 : 0)}>
            Повторить загрузку
          </button>
        </div>
      ) : (
        <div ref={gridRef} className="gif-picker__grid">
          <div ref={widthProbeRef} className="gif-picker__mosaic-width" />
          {gifs.length > 0 && mosaicWidth > 0 && (
            <div
              className="gif-picker__mosaic"
              style={{ height: mosaic.height }}
            >
              {gifs.map((gif, index) => {
                const tile = mosaic.tiles[index];
                if (!tile) return null;
                return (
                  <button
                    key={`${gif.id}-${index}`}
                    type="button"
                    className="gif-picker__item"
                    onClick={() => handleSelect(gif)}
                    style={{
                      left: tile.x,
                      top: tile.y,
                      width: tile.width,
                      height: tile.height,
                    }}
                    title={gif.title}
                  >
                    <ChatImage
                      src={gif.preview}
                      alt={gif.title || "GIF"}
                      loading="lazy"
                      className="gif-picker__item-image"
                    />
                  </button>
                );
              })}
            </div>
          )}

          <div ref={sentinelRef} className="gif-picker__sentinel" aria-hidden />

          {loading && (
            <div className="gif-picker__loader">
              <span className="gif-picker__spinner" />
            </div>
          )}

          {!loading && gifs.length === 0 && query.length >= 2 && (
            <div className="gif-picker__empty">
              По запросу «{query}» ничего не найдено
            </div>
          )}

          {!loading && gifs.length === 0 && query.length < 2 && (
            <div className="gif-picker__empty">
              Введите минимум 2 символа для поиска
            </div>
          )}
        </div>
      )}
    </motion.div>
  );
}
