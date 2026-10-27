import assert from "node:assert/strict";
import { test } from "node:test";
import { selectHistoryPage } from "../src/server/historyPage";
import { prependHistory, applyChatUpdate } from "../src/lib/chatUpdates";
import type { ChatInfo, ChatMessage } from "../src/lib/types";

test("history pages follow stored order through equal timestamps, hidden messages and presence notices", () => {
  const messages = Array.from({ length: 250 }, (_, i) => ({ id: String(i), text: `message ${i}`, createdAt: 1, hiddenFor: i === 5 ? ["viewer"] : undefined }));
  const ids: string[] = [];
  let before: string | undefined;
  do {
    const page = selectHistoryPage(messages, "viewer", before);
    assert.ok(page.messages.length <= 80);
    ids.unshift(...page.messages.map(message => message.id));
    before = page.hasMore ? page.before! : undefined;
  } while (before);
  assert.deepEqual(ids, messages.filter(message => message.id !== "5").map(message => message.id));
  assert.throws(() => selectHistoryPage(messages, "viewer", "5"));
  assert.throws(() => selectHistoryPage(messages, "viewer", "missing"));
  assert.equal(selectHistoryPage(messages, "viewer", undefined, Infinity).messages.length, 200);
  assert.equal(selectHistoryPage([{ id: "presence", text: "User в чате", kind: "system" }], "viewer").messages.length, 0);
});

test("older pages cannot overwrite a live edit or duplicate a live message", () => {
  const old = { id: "old", room: "room", author: "A", text: "old", createdAt: 1 } as ChatMessage;
  const current = { ...old, id: "current", text: "edited live", createdAt: 2 };
  const pending = { ...old, id: "pending", status: "pending" as const, createdAt: 3 };
  assert.deepEqual(prependHistory([old, { ...current, text: "stale" }], [current, pending]), [old, current, pending]);
});

test("chat patches preserve pinned ordering, update a single chat and remove hidden DMs", () => {
  const chat = (id: string, time: number, pinned = false) => ({ id, createdAt: time, pinned } as ChatInfo);
  const pinned = chat("pinned", 1, true), first = chat("first", 10), second = chat("second", 20);
  const updated = { ...first, lastMessage: { createdAt: 30 } } as ChatInfo;
  assert.deepEqual(applyChatUpdate([pinned, second, first], first.id, updated), [pinned, updated, second]);
  assert.deepEqual(applyChatUpdate([pinned, updated, second], first.id, null), [pinned, second]);
  assert.equal(applyChatUpdate([second], first.id, updated)[1], second);
});
