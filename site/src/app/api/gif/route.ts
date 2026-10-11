import { NextRequest, NextResponse } from 'next/server';
import { fetchGiphyApi } from '@/lib/giphyFetch';
import { giphyApiKey } from '@/lib/giphyKey';
import { pickGiphyPreviewUrl, pickGiphySendAsset } from '@/lib/giphyMedia';

const GIPHY_BASE = 'https://api.giphy.com/v1/gifs';
const GIPHY_FETCH_MS = 8_000;

// ============================================
// Серверный кэш (живёт в памяти Node.js)
// ============================================
type CacheEntry = {
  data: any;
  expiresAt: number;
};

const serverCache = new Map<string, CacheEntry>();

// TTL разный для разных типов запросов
const TTL_TRENDING = 30 * 60 * 1000;  // 30 минут для трендов
const TTL_SEARCH = 15 * 60 * 1000;    // 15 минут для поиска

function getCacheKey(type: string, query: string, offset: number): string {
  return `${type}:${query.toLowerCase()}:${offset}`;
}

function getFromCache(key: string): any | null {
  const entry = serverCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    serverCache.delete(key);
    return null;
  }
  return entry.data;
}

function setCache(key: string, data: any, ttl: number): void {
  // Чистим старые записи, чтобы кэш не разрастался
  if (serverCache.size > 500) {
    const now = Date.now();
    for (const [k, v] of serverCache) {
      if (v.expiresAt < now) serverCache.delete(k);
    }
  }
  serverCache.set(key, { data, expiresAt: Date.now() + ttl });
}

// ============================================
// Основной обработчик
// ============================================
export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const query = (searchParams.get('q') || '').trim();
    const offset = Number(searchParams.get('pos')) || 0;
    const limit = Math.min(Number(searchParams.get('limit')) || 20, 50);

    const isSearch = query.length >= 2;
    const type = isSearch ? 'search' : 'trending';
    const cacheKey = getCacheKey(type, query, offset);

    // 1. Проверяем серверный кэш
    const cached = getFromCache(cacheKey);
    if (cached) {
      console.log(`⚡ Cache HIT: ${cacheKey}`);
      return NextResponse.json(cached, {
        headers: {
          'X-Cache': 'HIT',
          'Cache-Control': 'public, max-age=300',
        },
      });
    }

    console.log(`🔍 Cache MISS: ${cacheKey} — fetching from GIPHY`);

    const apiKey = giphyApiKey();
    if (!apiKey) {
      console.error("GIPHY_API_KEY is not set");
      return NextResponse.json(getFallbackGifs(), {
        headers: { "X-Cache": "NO_KEY" },
      });
    }

    // 2. Формируем запрос
    const params = new URLSearchParams();
    params.set('api_key', apiKey);
    params.set('limit', String(limit));
    params.set('offset', String(offset));
    params.set('rating', 'pg-13');
    params.set('lang', 'ru');

    let endpoint: string;
    if (isSearch) {
      endpoint = `${GIPHY_BASE}/search`;
      params.set('q', query);
    } else {
      endpoint = `${GIPHY_BASE}/trending`;
    }

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), GIPHY_FETCH_MS);
    let response: Response;
    try {
      response = await fetchGiphyApi(`${endpoint}?${params.toString()}`, {
        headers: { Accept: 'application/json' },
        signal: ac.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    // 3. Обработка ошибок GIPHY
    if (!response.ok) {
      const status = response.status;
      console.error('GIPHY API error:', status);

      // 429 — превышен лимит. Возвращаем кэш или fallback
      if (status === 429) {
        return NextResponse.json(getFallbackGifs(), {
          headers: { 'X-Cache': 'RATE_LIMITED' },
        });
      }

      return NextResponse.json(getFallbackGifs());
    }

    const data = await response.json();

    // 4. Парсим
    const results = (data.data || [])
      .map((item: any) => {
        const send = pickGiphySendAsset(item.images);
        if (!send) return null;
        return {
          id: item.id || '',
          title: item.title || '',
          url: send.url,
          preview: pickGiphyPreviewUrl(item.images) || send.url,
          width:
            Number(item.images?.original?.width) ||
            Number(item.images?.fixed_width?.width) ||
            320,
          height:
            Number(item.images?.original?.height) ||
            Number(item.images?.fixed_width?.height) ||
            180,
          size: send.size,
          mime: send.mime,
        };
      })
      .filter((item: { url: string } | null): item is { url: string } =>
        Boolean(item?.url),
      );

    const payload = {
      results,
      next: results.length > 0 ? String(offset + limit) : '',
      total: data.pagination?.total_count || results.length,
    };

    // 5. Сохраняем в кэш
    const ttl = isSearch ? TTL_SEARCH : TTL_TRENDING;
    setCache(cacheKey, payload, ttl);

    return NextResponse.json(payload, {
      headers: {
        'X-Cache': 'MISS',
        'Cache-Control': 'public, max-age=300',
      },
    });
  } catch (error) {
    console.error('💥 GIF API error:', error);
    return NextResponse.json(getFallbackGifs());
  }
}

// ============================================
// Fallback если GIPHY недоступен
// ============================================
function getFallbackGifs() {
  return {
    results: [
      {
        id: 'fb-1',
        title: 'Hello',
        url: 'https://media.giphy.com/media/3o7aD2SAalBkft6NVG/giphy.webp',
        preview: 'https://media.giphy.com/media/3o7aD2SAalBkft6NVG/giphy.webp',
        width: 480,
        height: 270,
      },
      {
        id: 'fb-2',
        title: 'Cool',
        url: 'https://media.giphy.com/media/3o6Ztqnj1hYhTfL9jO/giphy.webp',
        preview: 'https://media.giphy.com/media/3o6Ztqnj1hYhTfL9jO/giphy.webp',
        width: 480,
        height: 270,
      },
    ],
    next: '',
    total: 2,
  };
}