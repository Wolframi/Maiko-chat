"use client";

import { useState, useCallback, useRef, useEffect, useMemo, useLayoutEffect } from "react";
import { motion } from "motion/react";
import { IconSearch, IconClose } from "@/lib/icons";
import { layoutGifMosaic } from "@/lib/gifMosaic";

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

  const gridRef = useRef<HTMLDivElement>(null);
  const widthProbeRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const searchTimeout = useRef<NodeJS.Timeout | undefined>(undefined);
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
  const loadGifs = useCallback(
    async (reset: boolean = false, currentQuery: string) => {
      // Защита от параллельных запросов
      if (loading && !reset) return;
      if (isLoadingMoreRef.current && !reset) return;

      const ttl = currentQuery.trim().length >= 2
        ? CLIENT_TTL_SEARCH
        : CLIENT_TTL_TRENDING;

      const offset = reset ? 0 : Number(nextPos) || 0;
      const cacheKey = getClientCacheKey(currentQuery, offset);

      // 1. Проверяем клиентский кэш
      const cached = getClientCache(cacheKey, ttl);
      if (cached) {
        console.log(`⚡ Client cache HIT: ${cacheKey}`);
        if (reset) {
          setGifs(cached.results);
        } else {
          setGifs(prev => {
            // Защита от дубликатов
            const existingIds = new Set(prev.map(g => g.id));
            const newGifs = cached.results.filter(g => !existingIds.has(g.id));
            return [...prev, ...newGifs];
          });
        }
        setNextPos(cached.next);
        setHasMore(Boolean(cached.next));
        return;
      }

      if (reset) {
        setLoading(true);
      }
      isLoadingMoreRef.current = true;
      setError(null);

      try {
        const params = new URLSearchParams();
        if (currentQuery.trim()) {
          params.set('q', currentQuery.trim());
        }
        if (!reset && offset > 0) {
          params.set('pos', String(offset));
        }
        params.set('limit', '20');

        const res = await fetch(`/api/gif?${params.toString()}`);

        if (!res.ok) {
          throw new Error(`API error: ${res.status}`);
        }

        const data = await res.json();
        const newGifs: GifResult[] = data.results || [];

        // 2. Сохраняем в клиентский кэш
        clientCache.set(cacheKey, {
          results: newGifs,
          next: data.next || '',
          timestamp: Date.now(),
        });

        if (reset) {
          setGifs(newGifs);
        } else {
          // Защита от дубликатов
          setGifs(prev => {
            const existingIds = new Set(prev.map(g => g.id));
            const filtered = newGifs.filter(g => !existingIds.has(g.id));
            return [...prev, ...filtered];
          });
        }

        setNextPos(data.next || '');
        setHasMore(Boolean(data.next) && newGifs.length > 0);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : 'Не удалось загрузить GIF'
        );
      } finally {
        setLoading(false);
        isLoadingMoreRef.current = false;
      }
    },
    [loading, nextPos]
  );

  // ============================================
  // Загрузка при открытии (только один раз)
  // ============================================
  useEffect(() => {
    if (open && gifs.length === 0 && !loading) {
      lastQueryRef.current = "";
      loadGifs(true, "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // ============================================
  // Поиск с увеличенным debounce (600мс)
  // ============================================
  useEffect(() => {
    if (!open) return;

    // Не ищем, если запрос не изменился
    if (query === lastQueryRef.current) return;

    if (searchTimeout.current) {
      clearTimeout(searchTimeout.current);
    }

    // Минимум 2 символа для поиска
    const shouldSearch = query.trim().length >= 2;

    searchTimeout.current = setTimeout(() => {
      lastQueryRef.current = query;
      setGifs([]);
      setNextPos("");
      setHasMore(true);
      loadGifs(true, shouldSearch ? query : "");
    }, 600);

    return () => {
      if (searchTimeout.current) {
        clearTimeout(searchTimeout.current);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, open]);

  // ============================================
  // Бесконечная загрузка через Intersection Observer
  // ============================================
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
          // Небольшая задержка перед загрузкой, чтобы не спамить
          setTimeout(() => {
            loadGifs(false, lastQueryRef.current);
          }, 200);
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
  }, [open, gifs, loading, hasMore, loadGifs]);

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
        <div className="gif-picker__error">{error}</div>
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
                    <img
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