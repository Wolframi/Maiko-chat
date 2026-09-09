"use client";

import type { ReactNode } from "react";
import Linkify from "linkify-react";

export function linkifyText(text: string): ReactNode {
  return (
    <Linkify
      options={{
        target: "_blank",
        rel: "noopener noreferrer",
        className: "bubble__link",
        validate: {
          url: (value) => /^https?:\/\//i.test(value),
        },
        ignoreTags: ["a", "script", "style"],
      }}
    >
      {text}
    </Linkify>
  );
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
