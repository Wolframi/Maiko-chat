export type TableBlock = {
  columns: string[];
  rows: string[][];
};

export type TableTextPart =
  | { type: "text"; value: string }
  | { type: "table"; table: TableBlock };

const MAX_COLUMNS = 12;
const MAX_ROWS = 60;
const SEPARATOR_CELL = /^:?-{3,}:?$/;

/** Split a markdown table row; `\|` escapes a literal pipe. */
function splitRow(line: string): string[] {
  let value = line.trim();
  if (value.startsWith("|")) value = value.slice(1);
  if (value.endsWith("|") && !value.endsWith("\\|")) value = value.slice(0, -1);
  const cells: string[] = [];
  let current = "";
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === "\\" && value[index + 1] === "|") {
      current += "|";
      index += 1;
      continue;
    }
    if (char === "|") {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  cells.push(current.trim());
  return cells;
}

function isSeparator(line: string | undefined, columnCount: number) {
  if (!line || !line.includes("-")) return false;
  const cells = splitRow(line);
  if (cells.length !== columnCount) return false;
  return cells.every((cell) => SEPARATOR_CELL.test(cell));
}

/**
 * Split message text into plain paragraphs and GFM-style tables:
 *
 * ```text
 * | Команда | Что делает |
 * |---|---|
 * | /start | Приветствие |
 * ```
 *
 * Coexists with the rest of the message; consecutive text is merged.
 */
export function parseMarkdownTables(text: string): TableTextPart[] {
  const lines = String(text ?? "").split(/\r?\n/);
  const parts: TableTextPart[] = [];
  const buffer: string[] = [];

  const flush = () => {
    if (!buffer.length) return;
    parts.push({ type: "text", value: buffer.join("\n") });
    buffer.length = 0;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const separator = lines[index + 1];
    if (!line.includes("|") || !isSeparator(separator, splitRow(line).length)) {
      buffer.push(line);
      continue;
    }

    const columns = splitRow(line).slice(0, MAX_COLUMNS);
    if (!columns.some((cell) => cell.length > 0)) {
      buffer.push(line);
      continue;
    }

    const rows: string[][] = [];
    let cursor = index + 2;
    while (
      cursor < lines.length &&
      lines[cursor].trim() !== "" &&
      lines[cursor].includes("|")
    ) {
      const cells = splitRow(lines[cursor]);
      rows.push(columns.map((_, column) => cells[column] ?? ""));
      cursor += 1;
    }

    flush();
    parts.push({
      type: "table",
      table: { columns, rows: rows.slice(0, MAX_ROWS) },
    });
    index = cursor - 1;
  }

  flush();
  return parts;
}

export function hasMarkdownTable(text: string): boolean {
  return parseMarkdownTables(text).some((part) => part.type === "table");
}
