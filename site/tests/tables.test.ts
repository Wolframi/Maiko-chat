import assert from "node:assert/strict";
import { test } from "node:test";
import { hasMarkdownTable, parseMarkdownTables } from "../src/lib/tables";

test("markdown tables split into text and table blocks", () => {
  const parts = parseMarkdownTables(
    "Список команд:\n\n| Команда | Что делает |\n|---|---|\n| /start | Приветствие |\n| /help | Справка |\n\nКонец.",
  );
  assert.equal(parts.length, 3);
  assert.equal(parts[0].type, "text");
  assert.match(parts[0].type === "text" ? parts[0].value : "", /Список команд:/);
  assert.equal(parts[1].type, "table");
  assert.deepEqual(parts[1].type === "table" ? parts[1].table : null, {
    columns: ["Команда", "Что делает"],
    rows: [
      ["/start", "Приветствие"],
      ["/help", "Справка"],
    ],
  });
  assert.equal(parts[2].type, "text");
  assert.match(parts[2].type === "text" ? parts[2].value : "", /Конец\./);
});

test("alignment, outer pipes and escaped pipes are supported", () => {
  const [part] = parseMarkdownTables(
    "| a | b | c |\n|:---|:---:|---:|\n| 1 | 2 | 3 |",
  );
  assert.equal(part.type, "table");
  assert.deepEqual(part.type === "table" ? part.table.columns : [], ["a", "b", "c"]);
  assert.deepEqual(part.type === "table" ? part.table.rows : [], [["1", "2", "3"]]);

  const escaped = parseMarkdownTables("| a | b |\n|---|---|\n| x\\|y | z |");
  assert.deepEqual(escaped[0].type === "table" ? escaped[0].table.rows : [], [
    ["x|y", "z"],
  ]);
});

test("non-tables and malformed separators stay plain text", () => {
  for (const text of [
    "| a | b |\n| не разделитель |\n| 1 | 2 |",
    "| a | b |\n|---|",
    "просто текст | с палкой\nи вторая строка",
    "",
  ]) {
    assert.equal(hasMarkdownTable(text), false, text);
  }
  // Header without body is still a table.
  assert.equal(hasMarkdownTable("| a | b |\n|---|---|"), true);
});

test("multiple tables and limits", () => {
  const parts = parseMarkdownTables(
    "| a |\n|---|\n| 1 |\n\nмежду\n\n| b |\n|---|\n| 2 |",
  );
  assert.equal(parts.filter((part) => part.type === "table").length, 2);
  assert.ok(parts.some((part) => part.type === "text" && part.value.includes("между")));

  const wide = parseMarkdownTables(
    `| ${Array.from({ length: 20 }, (_, i) => `c${i}`).join(" | ")} |\n|${"---|".repeat(20)}\n`,
  );
  assert.equal(wide[0].type === "table" ? wide[0].table.columns.length : 0, 12);

  const manyRows = parseMarkdownTables(
    `| a |\n|---|\n${Array.from({ length: 80 }, (_, i) => `| ${i} |`).join("\n")}`,
  );
  assert.equal(manyRows[0].type === "table" ? manyRows[0].table.rows.length : 0, 60);
});
