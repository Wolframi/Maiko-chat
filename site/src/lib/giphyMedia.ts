export type GiphyMediaRef = {
  url: string;
  name: string;
  mime: string;
  size: number;
};

type GiphyRendition = {
  url?: string;
  webp?: string;
  size?: string | number;
  webp_size?: string | number;
};

type GiphyImageSet = {
  original?: GiphyRendition;
  downsized?: GiphyRendition;
  downsized_medium?: GiphyRendition;
  fixed_width?: GiphyRendition;
};

const GIPHY_HOST = /^(media\d*\.giphy\.com|i\.giphy\.com)$/i;
const GIPHY_EXT = /\.(gif|webp|png|jpe?g)$/i;

function mimeFromExt(ext: string) {
  const lower = ext.toLowerCase();
  if (lower === "webp") return "image/webp";
  if (lower === "png") return "image/png";
  if (lower === "jpg" || lower === "jpeg") return "image/jpeg";
  return "image/gif";
}

function mimeFromPath(url: string) {
  const path = url.split("?")[0].split("#")[0].toLowerCase();
  const ext = path.split(".").pop() || "gif";
  return mimeFromExt(ext);
}

/** Only Giphy CDN image URLs — never HTML pages or arbitrary hosts. */
export function parseGiphyMediaUrl(url: string): GiphyMediaRef | null {
  const raw = String(url || "").trim();
  if (!raw || raw.length > 2048) return null;

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }

  if (parsed.protocol !== "https:") return null;
  if (parsed.username || parsed.password || parsed.port) return null;
  if (!GIPHY_HOST.test(parsed.hostname)) return null;
  if (parsed.pathname.includes("..")) return null;

  const extMatch = parsed.pathname.toLowerCase().match(GIPHY_EXT);
  if (!extMatch) return null;

  const ext = extMatch[1];
  const base = parsed.pathname.split("/").pop() || `gif.${ext}`;
  const name = base.replace(/[^a-zA-Z0-9._-]+/g, "") || `gif.${ext}`;
  return {
    url: `${parsed.origin}${parsed.pathname}${parsed.search}`,
    name,
    mime: mimeFromExt(ext),
    size: 0,
  };
}

export function isGiphyMediaUrl(url: string) {
  return parseGiphyMediaUrl(url) !== null;
}

function asAsset(url?: string, size?: string | number, mime?: string) {
  const href = String(url || "").trim();
  if (!href || !isGiphyMediaUrl(href)) return null;
  return {
    url: href,
    mime: mime || mimeFromPath(href),
    size: Math.max(0, Number(size) || 0),
  };
}

/**
 * Prefer animated WebP / downsized over the multi-MB original GIF.
 * Recipients load this from Giphy CDN — no Pulse upload.
 */
export function pickGiphySendAsset(images?: GiphyImageSet | null) {
  if (!images) return null;
  return (
    asAsset(images.original?.webp, images.original?.webp_size, "image/webp") ||
    asAsset(images.downsized?.url, images.downsized?.size) ||
    asAsset(images.downsized_medium?.url, images.downsized_medium?.size) ||
    asAsset(images.original?.url, images.original?.size)
  );
}

export function pickGiphyPreviewUrl(images?: GiphyImageSet | null) {
  if (!images) return "";
  return (
    String(images.fixed_width?.webp || "").trim() ||
    String(images.fixed_width?.url || "").trim() ||
    String(images.downsized?.url || "").trim() ||
    String(images.original?.webp || "").trim() ||
    String(images.original?.url || "").trim()
  );
}
