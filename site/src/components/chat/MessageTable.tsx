"use client";

import { useState } from "react";
import type { TableBlock } from "@/lib/tables";

const COLLAPSE_AFTER = 5;

/** Markdown table from a message; long tables start folded, all can be folded. */
export function MessageTable({ table }: { table: TableBlock }) {
  const [expanded, setExpanded] = useState(table.rows.length <= COLLAPSE_AFTER);
  const rows = expanded
    ? table.rows
    : table.rows.length > COLLAPSE_AFTER
      ? table.rows.slice(0, COLLAPSE_AFTER)
      : [];

  return (
    <div className="bubble-table">
      <div className="bubble-table__scroll">
        <table>
          <thead>
            <tr>
              {table.columns.map((column, index) => (
                <th key={index} scope="col">
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {table.columns.map((_, columnIndex) => (
                  <td key={columnIndex}>{row[columnIndex] ?? ""}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button
        type="button"
        className="bubble-table__toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        {expanded
          ? "Свернуть таблицу"
          : `Показать строки · ${table.rows.length}`}
      </button>
    </div>
  );
}
