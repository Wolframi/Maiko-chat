/** `/help`, `/roll@echo_bot` — Telegram-style clickable command tokens. */
const COMMAND_TOKEN_PATTERN =
  /(^|[\s(])(\/([a-zA-Z0-9_]{1,32})(?:@([a-zA-Z0-9_-]{2,32}(?:\.[a-zA-Z0-9_-]{1,32})*))?)(?=$|[\s.,!?…:;)])/g;

/** The whole draft is a command being typed (`/`, `/he`, …). */
const DRAFT_COMMAND_PATTERN = /^\/([a-zA-Z0-9_]*)$/;

export type CommandTextPart = { type: "text" | "command"; value: string };

/** Query passed to the composer autocomplete, or undefined when it is closed. */
export function commandQueryFromDraft(text: string): string | undefined {
  return DRAFT_COMMAND_PATTERN.exec(text)?.[1];
}

/** Prefix match for the `/` dropdown (case-insensitive, capped). */
export function filterBotCommands<T extends { command: string }>(
  commands: readonly T[],
  query: string,
  limit = 8,
): T[] {
  const needle = query.trim().toLowerCase();
  return commands
    .filter((item) => !needle || item.command.toLowerCase().startsWith(needle))
    .slice(0, Math.max(1, limit));
}

/**
 * Split message text into plain fragments and clickable commands.
 * Only known command names (without slash) become clickable, so ordinary
 * `/paths` and URLs are left alone.
 */
export function splitCommandText(
  text: string,
  commandNames: readonly string[],
): CommandTextPart[] {
  const commands = new Set(commandNames.map((name) => name.toLowerCase()));
  const parts: CommandTextPart[] = [];
  let cursor = 0;
  COMMAND_TOKEN_PATTERN.lastIndex = 0;
  let match = COMMAND_TOKEN_PATTERN.exec(text);
  while (match) {
    const token = match[2];
    const name = match[3].toLowerCase();
    if (commands.has(name)) {
      const start = match.index + match[1].length;
      if (start > cursor) parts.push({ type: "text", value: text.slice(cursor, start) });
      parts.push({ type: "command", value: token });
      cursor = start + token.length;
    }
    match = COMMAND_TOKEN_PATTERN.exec(text);
  }
  if (cursor < text.length) parts.push({ type: "text", value: text.slice(cursor) });
  return parts;
}
