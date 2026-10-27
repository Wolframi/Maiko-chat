const PALETTE = [
  "#355070",
  "#4c6da9",
  "#2d446d",
  "#5d7aa0",
  "#3a5578",
  "#4a6288",
  "#2a3f65",
  "#5d6d8f",
];

export function avatarColor(name: string) {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  }
  return PALETTE[hash % PALETTE.length];
}

export function avatarInitials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0] ?? ""}${parts[1][0] ?? ""}`.toUpperCase();
}

/** Stable identity for comparing avatars; never use this URL to fetch a photo. */
export function bareAvatarUrl(src?: string | null) {
  if (!src) return null;
  const bare = String(src).split("?")[0].split("#")[0];
  return bare || null;
}

/** Cache-bust after a failed load — browsers reuse a broken-image cache for the same URL. */
export function avatarDisplaySrc(bare: string, attempt = 0) {
  if (attempt <= 0) return bare;
  const sep = bare.includes("?") ? "&" : "?";
  return `${bare}${sep}retry=${attempt}`;
}
