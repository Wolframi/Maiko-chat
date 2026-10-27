import assert from "node:assert/strict";
import { test } from "node:test";
import { summarizeMessages } from "../src/server/messageSummary";
import { messageVisibleTo } from "../src/server/dmHistory";

test("sidebar summary respects per-user deletion, read boundaries and non-text messages", () => {
  const messages = [
    { id: "old", createdAt: 10, authorId: "peer" },
    { id: "read-boundary", createdAt: 20, authorId: "peer", kind: "file" },
    { id: "mine", createdAt: 30, authorId: "viewer", kind: "text" },
    { id: "call", createdAt: 40, authorId: "peer", kind: "call" },
    { id: "sticker", createdAt: 50, authorId: "peer", kind: "sticker" },
    { id: "hidden", createdAt: 60, authorId: "peer", hiddenFor: ["viewer"] },
    { id: "system", createdAt: 70, kind: "system" },
  ];
  assert.deepEqual(summarizeMessages(messages, "viewer", 20), {
    count: 5, unreadCount: 2, last: messages[4],
  });
  assert.equal(summarizeMessages(messages, "other", 0).last, messages[5]);
  assert.deepEqual(summarizeMessages([], "viewer"), { count: 0, unreadCount: 0, last: undefined });
  assert.deepEqual(summarizeMessages(messages.slice(5), "viewer"), { count: 0, unreadCount: 0, last: undefined });
});

test("sidebar summary matches existing behavior across histories, viewers and read positions", () => {
  // Deliberately non-monotonic timestamps: the preview follows stored order.
  const messages = Array.from({ length: 400 }, (_, i) => ({
    id: String(i), createdAt: (i * 17) % 311,
    kind: [undefined, "system", "text", "file", "sticker", "call", "invite"][i % 7],
    authorId: i % 4 ? `user-${i % 3}` : undefined,
    hiddenFor: i % 5 ? undefined : [`user-${i % 3}`],
  }));
  for (const viewer of ["user-0", "user-1", "user-2", "other"]) {
    for (const readAt of [0, 1, 100, 200, 311]) {
      const visible = messages.filter(message => messageVisibleTo(message, viewer));
      const expected = {
        count: visible.filter(message => message.kind !== "system").length,
        unreadCount: visible.filter(message => message.kind !== "system" && message.createdAt > readAt && message.authorId !== viewer).length,
        last: [...visible].reverse().find(message => message.kind !== "system"),
      };
      assert.deepEqual(summarizeMessages(messages, viewer, readAt), expected);
    }
  }
});
