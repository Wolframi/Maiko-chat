import assert from "node:assert/strict";
import { test } from "node:test";
import { applySummaryChange, type SavedSummary, type SummarySource } from "../src/server/messageSummaries";

type Message = { id: string; room: string; createdAt: number; kind?: string; authorId?: string; hiddenFor?: string[] };
const doc = (message: Message, position: number): SummarySource<Message> => ({ _id: JSON.stringify([message.room, message.id]), room: message.room, position, message });
const empty = (): SavedSummary<Message> & { needsLast?: boolean } => ({
  _id: "summary", room: "room", viewerId: "a", readAt: 20,
  count: 0, unreadCount: 0, last: null, lastPosition: -1, maxCreatedAt: 0,
});

test("summary deltas preserve read boundaries, viewer visibility and stored order", () => {
  const summary = empty();
  const peer = doc({ id: "peer", room: "room", authorId: "b", createdAt: 30 }, 0);
  const mine = doc({ id: "mine", room: "room", authorId: "a", createdAt: 40 }, 1);
  const backdated = doc({ id: "backdated", room: "room", createdAt: 20 }, 2);
  const hidden = doc({ id: "hidden", room: "room", createdAt: 50, hiddenFor: ["a"] }, 3);
  for (const message of [peer, mine, backdated, hidden]) applySummaryChange(summary, undefined, message);
  assert.equal(summary.count, 3);
  assert.equal(summary.unreadCount, 1);
  assert.equal(summary.last, backdated.message);
  assert.equal(summary.maxCreatedAt, 40);
  const hiddenPeer = { ...peer, message: { ...peer.message, hiddenFor: ["a"] } };
  applySummaryChange(summary, peer, hiddenPeer);
  assert.equal(summary.count, 2);
  assert.equal(summary.unreadCount, 0);
  applySummaryChange(summary, hiddenPeer, peer);
  assert.equal(summary.count, 3);
  assert.equal(summary.unreadCount, 1);
  assert.equal(summary.last, backdated.message, "an older newly visible message must not replace the preview");
  applySummaryChange(summary, backdated, { ...backdated, message: { ...backdated.message, kind: "system" } });
  assert.equal(summary.count, 2);
  assert.equal(summary.needsLast, true, "deleting the preview requests one indexed predecessor lookup");
});

test("edits update preview and unread contribution without changing message count", () => {
  const summary = empty();
  const original = doc({ id: "m", room: "room", authorId: "b", createdAt: 30 }, 5);
  applySummaryChange(summary, undefined, original);
  const edited = { ...original, message: { ...original.message, authorId: "a" } };
  applySummaryChange(summary, original, edited);
  assert.equal(summary.count, 1);
  assert.equal(summary.unreadCount, 0);
  assert.equal(summary.last, edited.message);
  applySummaryChange(summary, edited, undefined);
  assert.equal(summary.count, 0);
  assert.equal(summary.unreadCount, 0);
  assert.equal(summary.last, null);
});
