import baseData from "@emoji-mart/data";
import ruCompact from "emojibase-data/ru/compact.json";

type MartEmoji = {
  id: string;
  name: string;
  keywords?: string[];
  emoticons?: string[];
  aliases?: string[];
  skins?: Array<{ unified?: string; native?: string }>;
  search?: string;
  version?: number;
};

type MartData = {
  categories: Array<{ id: string; emojis: string[] }>;
  emojis: Record<string, MartEmoji>;
  aliases: Record<string, string>;
  sheet: unknown;
};

type RuCompactItem = {
  hexcode?: string;
  label?: string;
  tags?: string[];
  unicode?: string;
};

function normHex(hex: string) {
  return hex.toLowerCase().replace(/-?fe0f/g, "").replace(/-/g, "");
}

function normNative(value: string) {
  return value.normalize("NFC").replace(/\uFE0F/g, "").trim();
}

function russianTokens(label: string, tags: string[] = []) {
  const fromLabel = label
    .toLowerCase()
    .split(/[\s,.;:!?#«»„“"'`()[\]{}<>|/\\_+*=~^$@%]+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 2);
  const fromTags = tags
    .map((tag) => tag.toLowerCase().trim())
    .filter((tag) => tag.length >= 2);
  return [...new Set([...fromLabel, ...fromTags])];
}

function buildRuIndex(items: RuCompactItem[]) {
  const byHex = new Map<string, string[]>();
  const byNative = new Map<string, string[]>();

  for (const item of items) {
    if (!item.label) continue;
    const tokens = russianTokens(item.label, item.tags);
    if (!tokens.length) continue;
    if (item.hexcode) byHex.set(normHex(item.hexcode), tokens);
    if (item.unicode) byNative.set(normNative(item.unicode), tokens);
  }

  return { byHex, byNative };
}

function withRussianKeywords(source: MartData): MartData {
  const data = structuredClone(source) as MartData;
  const { byHex, byNative } = buildRuIndex(ruCompact as RuCompactItem[]);

  for (const emoji of Object.values(data.emojis)) {
    const skin = emoji.skins?.[0];
    const tokens =
      (skin?.unified ? byHex.get(normHex(skin.unified)) : undefined) ||
      (skin?.native ? byNative.get(normNative(skin.native)) : undefined);
    if (!tokens?.length) continue;

    const keywords = new Set([...(emoji.keywords || []), ...tokens]);
    emoji.keywords = [...keywords];
    // Prefer Russian label words in name so prefix search ranks naturally.
    if (tokens[0] && !emoji.name.toLowerCase().includes(tokens[0])) {
      emoji.name = `${tokens[0]} ${emoji.name}`;
    }
  }

  return data;
}

/** Emoji Mart dataset with Russian CLDR labels/tags for search. */
export const emojiMartRuData = withRussianKeywords(baseData as MartData);
