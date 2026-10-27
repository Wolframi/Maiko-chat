import assert from "node:assert/strict";
import { test } from "node:test";
import { searchHistory, selectHistoryWindow, selectNewerHistory } from "../src/server/historyNavigation";

const messages = Array.from({ length: 2500 }, (_, i) => ({
  id: `m-${i}`, text: `Message ${i}`, author: "Автор", kind: "text", createdAt: 1,
  ...(i === 5 ? { hiddenFor: ["viewer"] } : {}),
  ...(i === 6 ? { kind: "system", text: "Автор в чате" } : {}),
}));

test("navigation windows stay bounded, follow stored order and paginate both edges", () => {
  const page = selectHistoryWindow(messages, "viewer", "m-1234");
  assert.equal(page.messages.length, 81);
  assert.equal(page.before, "m-1194");
  assert.equal(page.after, "m-1274");
  assert.equal(page.hasMore, true);
  assert.equal(page.hasNewer, true);
  const forward = selectNewerHistory(messages, "viewer", page.after);
  assert.equal(forward.messages.length, 80);
  assert.equal(forward.messages[0].id, "m-1275");
  assert.equal(forward.after, "m-1354");
  assert.equal(forward.hasNewer, true);
  const start = selectHistoryWindow(messages, "viewer", "m-12");
  assert.equal(start.messages.length, 51);
  assert.equal(start.hasMore, false);
  assert.equal(start.messages.some(message => ["m-5", "m-6"].includes(message.id)), false);
  assert.equal(selectHistoryWindow(messages, "viewer", "m-2499").hasNewer, false);
  assert.deepEqual(selectNewerHistory(messages, "viewer", "m-2499"), { messages: [], after: "m-2499", hasNewer: false });
  for (const id of ["m-5", "m-6", "missing"]) {
    assert.throws(() => selectHistoryWindow(messages, "viewer", id));
    assert.throws(() => selectNewerHistory(messages, "viewer", id));
    assert.throws(() => searchHistory(messages, "viewer", "Message", id));
  }
});

test("search pages return only matching IDs without offsets or timestamp ambiguity", () => {
  const ids: string[] = [];
  let after: string | undefined;
  do {
    const page = searchHistory(messages, "viewer", " MESSAGE ", after);
    assert.ok(page.ids.length <= 40);
    assert.deepEqual(Object.keys(page).sort(), ["after", "hasMore", "ids"]);
    ids.push(...page.ids);
    after = page.hasMore ? page.after! : undefined;
  } while (after);
  assert.equal(ids.length, 2498);
  assert.equal(new Set(ids).size, 2498);
  assert.deepEqual(searchHistory(messages, "viewer", "Message 1234").ids, ["m-1234"]);
  assert.deepEqual(searchHistory(messages, "viewer", "").ids, []);
  assert.deepEqual(searchHistory(messages, "viewer", ".*").ids, []);
  assert.equal(searchHistory(messages, "viewer", "автор").ids.length, 40);
  const files = [{ id: "file", text: "", kind: "file", file: { name: "Report [2026].pdf" } },
    { id: "call", text: "Report [2026].pdf", kind: "call" }];
  assert.deepEqual(searchHistory(files, "viewer", "[2026]").ids, ["file"]);
});
