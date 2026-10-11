import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MongoClient } from "mongodb";
import { MessageStore } from "../src/server/messageStore";

test("MongoDB migration, full history, mutations, restart, failure recovery and no resurrection", {
  skip: !process.env.TEST_MONGODB_URI,
}, async () => {
  const uri = process.env.TEST_MONGODB_URI!;
  const database = `maiko_test_${Date.now()}`;
  const admin = new MongoClient(uri);
  const folder = mkdtempSync(path.join(tmpdir(), "maiko-messages-"));
  const file = path.join(folder, "messages.json");
  type Message = { id: string; room: string; createdAt: number; text: string; reactions?: string[]; files?: { url: string }[] };
  let store = new MessageStore<Message>(uri, database);
  try {
    await store.connect();
    await assert.rejects(store.load(), /messages:migrate/);
    writeFileSync(file, JSON.stringify({ room: [{ id: "bad" }] }));
    await assert.rejects(store.migrate(file), /Invalid message/);
    assert.equal(await store.migrated(), false);
    const messages: Message[] = Array.from({ length: 251 }, (_, i) => ({
      id: `msg_${i}`, room: "room", createdAt: 1700000000000 + i, text: `Привет ${i}`,
    }));
    messages[1].files = [{ url: "/uploads/a.png" }, { url: "/uploads/b.png" }];
    writeFileSync(file, JSON.stringify({ room: messages, empty: [] }));
    assert.deepEqual(await store.migrate(file), { rooms: 2, messages: 251 });
    await assert.rejects(store.migrate(file), /already completed/);
    const rooms = await store.load();
    assert.deepEqual(rooms.get("room"), messages);
    const list = rooms.get("room")!;
    list[1].text = "Изменено";
    list[1].reactions = ["❤️"];
    list.splice(2, 1);
    store.save(rooms);
    // A later mutation must also be captured while the first write is pending.
    list.push({ id: "new", room: "room", createdAt: Date.now(), text: "После миграции" });
    store.save(rooms);
    await store.idle();
    await store.close();
    store = new MessageStore<Message>(uri, database);
    await store.connect();
    const restored = await store.load();
    assert.deepEqual(restored.get("room"), list);
    assert.equal(restored.get("room")!.length, 251);
    const internals = store as unknown as { collection: { bulkWrite: (...args: unknown[]) => Promise<unknown> } };
    const original = internals.collection.bulkWrite.bind(internals.collection);
    internals.collection.bulkWrite = async () => { throw new Error("simulated write failure"); };
    restored.get("room")![0].text = "Повтор записи";
    store.save(restored);
    await assert.rejects(store.idle(), /simulated/);
    assert.equal(await store.healthy(), false);
    internals.collection.bulkWrite = original;
    store.save(restored);
    await store.idle();
    assert.equal(await store.healthy(), true);
    restored.set("room", []);
    store.save(restored);
    await store.idle();
    await store.close();
    store = new MessageStore<Message>(uri, database);
    await store.connect();
    assert.equal((await store.load()).size, 0);
    // The old JSON still contains 251 messages, but the marker prevents resurrection.
    await assert.rejects(store.migrate(file), /already completed/);
  } finally {
    await store.close();
    await admin.connect();
    await admin.db(database).dropDatabase();
    await admin.close();
    rmSync(folder, { recursive: true, force: true });
  }
});
