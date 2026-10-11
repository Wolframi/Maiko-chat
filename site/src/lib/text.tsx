"use client";

import type { ReactNode } from "react";
import Linkify from "linkify-react";
import { splitTextAndEmoji } from "@/lib/emojiText";

const LINKIFY_OPTIONS = {
  target: "_blank",
  rel: "noopener noreferrer",
  className: "bubble__link",
  validate: {
    url: (value: string) => /^https?:\/\//i.test(value),
  },
  ignoreTags: ["a", "script", "style"] as string[],
};

export function linkifyText(text: string): ReactNode {
  return <Linkify options={LINKIFY_OPTIONS}>{text}</Linkify>;
}

export function highlightText(text: string, query: string): ReactNode {
  const q = query.trim();
  if (!q) return text;
  const lower = text.toLowerCase();
  const needle = q.toLowerCase();
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let match = lower.indexOf(needle, cursor);

  while (match !== -1) {
    if (match > cursor) nodes.push(text.slice(cursor, match));
    nodes.push(
      <mark key={`${match}-${needle}`} className="search-mark">
        {text.slice(match, match + needle.length)}
      </mark>,
    );
    cursor = match + needle.length;
    match = lower.indexOf(needle, cursor);
  }

  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

export function renderMessageText(text: string, query?: string): ReactNode {
  const parts = splitTextAndEmoji(text);
  if (!parts.length) return text;
  if (parts.length === 1 && parts[0].type === "text") {
    return query?.trim() ? highlightText(text, query) : linkifyText(text);
  }

  return parts.map((part, index) => {
    if (part.type === "emoji") {
      return (
        <span key={`e-${index}`} className="emoji-glyph">
          {part.value}
        </span>
      );
    }
    if (query?.trim()) {
      return <span key={`t-${index}`}>{highlightText(part.value, query)}</span>;
    }
    return (
      <Linkify key={`t-${index}`} options={LINKIFY_OPTIONS}>
        {part.value}
      </Linkify>
    );
  });
}
