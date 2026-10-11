export type TextEmojiPart = {
  type: "text" | "emoji";
  value: string;
};

/** Even 8px steps from TG-large down to just above inline-with-text (~22px). */
const SOLO_START_PX = 80;
const SOLO_STEP_PX = 8;
const INLINE_EMOJI_PX = 22;
const SOLO_MIN_PX = Math.ceil(INLINE_EMOJI_PX * 1.2);

function graphemes(text: string): string[] {
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].map(
      (part) => part.segment,
    );
  }
  return [...text];
}

export function isEmojiGrapheme(value: string): boolean {
  const g = String(value || "");
  if (!g || /^\s+$/.test(g)) return false;
  if (/^\p{Regional_Indicator}{2}$/u.test(g)) return true;
  if (/^[#*0-9]\uFE0F?\u20E3$/u.test(g)) return true;
  if (!/\p{Extended_Pictographic}/u.test(g)) return false;
  const rest = g
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/[\uFE0E\uFE0F\u200D\u20E3\p{M}]/gu, "");
  return !/[\p{L}\p{N}]/u.test(rest);
}

/** How many emoji if the whole message is only emoji. 0 = has text. */
export function emojiOnlyCount(text: string): number {
  const trimmed = String(text || "").trim();
  if (!trimmed) return 0;
  const clusters = graphemes(trimmed).filter((g) => !/^\s+$/.test(g));
  if (!clusters.length) return 0;
  if (!clusters.every(isEmojiGrapheme)) return 0;
  return clusters.length;
}

/**
 * Pixel size for a solo-emoji message.
 * 0 → render as a normal text bubble (mixed text, or so many emoji
 * that they would be about the same size as emoji-in-text).
 */
export function soloEmojiSizePx(text: string): number {
  const count = emojiOnlyCount(text);
  if (count < 1) return 0;
  const size = SOLO_START_PX - (count - 1) * SOLO_STEP_PX;
  if (size < SOLO_MIN_PX) return 0;
  return size;
}

export function splitTextAndEmoji(text: string): TextEmojiPart[] {
  const raw = String(text || "");
  if (!raw) return [];
  const parts: TextEmojiPart[] = [];
  let buffer = "";
  for (const g of graphemes(raw)) {
    if (isEmojiGrapheme(g)) {
      if (buffer) {
        parts.push({ type: "text", value: buffer });
        buffer = "";
      }
      parts.push({ type: "emoji", value: g });
    } else {
      buffer += g;
    }
  }
  if (buffer) parts.push({ type: "text", value: buffer });
  return parts;
}
