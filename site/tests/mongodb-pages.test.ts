import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MongoClient, type Collection } from "mongodb";
import { MessageStore } from "../src/server/messageStore";
import { selectHistoryPage } from "../src/server/historyPage";
import { searchHistory, selectHistoryWindow, selectNewerHistory } from "../src/server/historyNavigation";
import { summarizeMessages } from "../src/server/messageSummary";

type Message = {
  id: string; room: string; createdAt: number; text: string; kind: string; authorId: string;
  hiddenFor?: string[]; clientId?: string; author?: string; file?: { name: string };
};
type Doc = { _id: string; room: string; position: number; message: Message };

test("MongoDB page cursors, visibility, summaries and restart order match stored history", {
  skip: !process.env.TEST_MONGODB_URI, timeout: 120_000,
}, async () => {
  const uri = process.env.TEST_MONGODB_URI!;
  const database = `maiko_test_pages_${Date.now()}`;
  const folder = mkdtempSync(path.join(tmpdir(), "maiko-mongo-pages-"));
  const file = path.join(folder, "messages.json");
  const admin = new MongoClient(uri);
  let store = new MessageStore<Message>(uri, database);
  const messages: Message[] = Array.from({ length: 2500 }, (_, index) => ({
    id: `message-${index}`, room: "room", createdAt: 1700000000000 + Math.floor(index / 3),
    text: `text ${index}`, kind: "text", authorId: index % 2 ? "a" : "b",
    ...(index % 7 === 0 ? { hiddenFor: ["a"] } : {}),
    ...(index % 6 === 0 ? { kind: "system", text: "Name в чате \n" } : {}),
  }));
  messages[1].kind = "system";
  messages[1].text = " в чате "; // trim() leaves no prefix: this is a visible tombstone-like notice.
  messages[10].clientId = "durable-client-id";
  messages[11].file = { name: "Report [2026].pdf" };
  messages[13].author = "Тестовый Автор";
  writeFileSync(file, JSON.stringify({ room: messages, other: [{ ...messages[10], room: "other" }] }));
  try {
    await store.connect();
    await store.migrate(file);
    assert.equal(await store.initialize(), 2);
    const internals = store as unknown as { collection: Collection<Doc> };
    const find = internals.collection.find.bind(internals.collection);
    let pageLimits: number[] = [];
    internals.collection.find = ((...args: Parameters<typeof find>) => {
      const cursor = find(...args);
      const limit = cursor.limit.bind(cursor);
      cursor.limit = (value: number) => { pageLimits.push(value); return limit(value); };
      return cursor;
    }) as typeof find;
    for (const viewer of ["a", "b"]) {
      let before: string | undefined;
      do {
        const expected = selectHistoryPage(messages, viewer, before);
        const actual = await store.page("room", viewer, before);
        assert.deepEqual(actual, expected);
        before = actual.hasMore ? actual.before! : undefined;
      } while (before);
      assert.deepEqual(await store.summary("room", viewer, 1700000000500), summarizeMessages(messages, viewer, 1700000000500));
    }
    assert.ok(pageLimits.filter(value => value > 1).every(value => value === 81), "each page fetches only the page and one lookahead record");
    pageLimits = [];
    assert.equal((await store.page("room", "b", undefined, 99999)).messages.length, 200);
    assert.deepEqual(pageLimits.filter(value => value > 1), [201]);
    pageLimits = [];
    for (const viewer of ["a", "b"]) {
      for (const id of ["message-11", "message-1003", "message-2498"]) {
        const expected = selectHistoryWindow(messages, viewer, id);
        assert.deepEqual(await store.window("room", viewer, id), expected);
        assert.deepEqual(await store.newerPage("room", viewer, expected.after), selectNewerHistory(messages, viewer, expected.after));
      }
      for (const query of ["text 1", "[2026]", ".*", "ТЕСТОВЫЙ", "", "missing"]) {
        const expected = searchHistory(messages, viewer, query);
        assert.deepEqual(await store.search("room", viewer, query), expected);
        if (expected.hasMore) assert.deepEqual(await store.search("room", viewer, query, expected.after!), searchHistory(messages, viewer, query, expected.after!));
      }
    }
    assert.ok(pageLimits.filter(value => value > 1).every(value => value === 41 || value === 81), "navigation fetches only bounded pages and lookahead records");
    await assert.rejects(store.window("room", "a", "message-0"), /недоступно/);
    await assert.rejects(store.window("room", "a", "message-6"), /недоступно/);
    await assert.rejects(store.newerPage("room", "a", "missing"), /недоступно/);
    await assert.rejects(store.search("room", "a", "text", "message-0"), /недоступно/);
    await assert.rejects(store.page("room", "a", "message-0"), /История изменилась/);
    await assert.rejects(store.page("room", "a", "missing"), /История изменилась/);
    assert.equal((await store.get("room", "message-0", "a")), undefined);
    assert.equal((await store.findClient("room", "b", "durable-client-id"))?.id, "message-10");

    store.hide("room", "a");
    assert.deepEqual(await store.page("room", "a"), { messages: [], before: null, hasMore: false });
    assert.deepEqual((await store.page("room", "b")).messages, selectHistoryPage(messages, "b").messages.map(message => ({ ...message, hiddenFor: [...(message.hiddenFor || []), "a"].filter((value, index, items) => items.indexOf(value) === index) })));
    const newest: Message = { id: "new", room: "room", kind: "text", text: "new", authorId: "a", createdAt: Date.now() };
    store.append(newest);
    assert.deepEqual((await store.page("room", "a")).messages, [newest]);
    await store.close();
    store = new MessageStore<Message>(uri, database);
    await store.connect();
    await store.initialize();
    assert.equal((await store.findClient("room", "b", "durable-client-id"))?.id, "message-10");
    store.append({ ...newest, id: "after-restart", createdAt: 1 });
    assert.deepEqual((await store.page("room", "a")).messages.map(message => message.id), ["new", "after-restart"]);
    const collection = admin.db(database).collection<Doc>("messages");
    assert.equal((await collection.findOne({ _id: JSON.stringify(["room", "after-restart"]) }))!.position, 2501);
    // An early exit must release the database cursor as well as its batch.
    for await (const message of store.scan({ room: "other" })) { assert.equal(message.room, "other"); break; }
  } finally {
    await store.close();
    await admin.db(database).dropDatabase();
    await admin.close();
    rmSync(folder, { recursive: true, force: true });
  }
});
