import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MongoClient, type AnyBulkWriteOperation } from "mongodb";
import { MessageStore } from "../src/server/messageStore";

type TestMessage = { id: string; room: string; createdAt: number; text: string; reactions?: string[] };
type TestDocument = { _id: string; room: string; position: number; message: TestMessage };
type Operation = AnyBulkWriteOperation<TestDocument>;

function fixture(seed: TestDocument[] = []) {
  const store = new MessageStore<TestMessage>("mongodb://127.0.0.1:27017");
  const docs = new Map(seed.map(doc => [doc._id, doc]));
  const writes: Operation[][] = [];
  let intercept: ((operations: Operation[]) => Promise<void>) | undefined;
  function apply(operations: Operation[]) {
    for (const operation of operations) {
      if ("updateOne" in operation) {
        const { filter, update } = operation.updateOne;
        const change = update as { $setOnInsert?: TestDocument; $set?: { message: TestMessage } };
        const id = String(filter._id);
        const current = docs.get(id);
        if (!current && change.$setOnInsert) docs.set(id, structuredClone(change.$setOnInsert));
        if (current && change.$set) current.message = structuredClone(change.$set.message);
      } else if ("deleteOne" in operation) docs.delete(String(operation.deleteOne.filter._id));
      else if ("deleteMany" in operation) {
        for (const [id, doc] of docs) if (doc.room === operation.deleteMany.filter.room) docs.delete(id);
      }
    }
  }
  const internals = store as unknown as { collection: unknown };
  internals.collection = {
    find: () => ({ sort: () => ({ async *[Symbol.asyncIterator]() { yield* seed; } }) }),
    bulkWrite: async (operations: Operation[], options: { ordered: boolean }) => {
      assert.equal(options.ordered, true);
      writes.push(structuredClone(operations));
      if (intercept) await intercept(operations);
      else apply(operations);
    },
  };
  // These unit tests isolate the message writer. The derived summaries have real-DB tests.
  (store as unknown as { summaries: unknown }).summaries = {
    writeBatch: async (_operations: Operation[], write: () => Promise<unknown>) => write(),
    idle: async () => undefined,
  };
  store.migrated = async () => true;
  return { store, docs, writes, apply, intercept: (callback?: typeof intercept) => { intercept = callback; } };
}

function message(id: string, room = "room"): TestMessage {
  return { id, room, createdAt: 1700000000000, text: id };
}
function document(value: TestMessage, position: number): TestDocument {
  return { _id: JSON.stringify([value.room, value.id]), room: value.room, position, message: value };
}

test("startup initializes room positions without reading any message bodies", async () => {
  const { store, docs } = fixture();
  const internals = store as unknown as { collection: { find: () => never; aggregate: (pipeline: unknown[]) => AsyncIterable<{ _id: string; position: number }> } };
  internals.collection.find = () => { throw new Error("startup must not load history"); };
  internals.collection.aggregate = (pipeline) => {
    assert.deepEqual(pipeline, [{ $group: { _id: "$room", position: { $max: "$position" } } }]);
    return { async *[Symbol.asyncIterator]() { yield { _id: "room", position: 99999 }; yield { _id: "other", position: 8 }; } };
  };
  try {
    assert.equal(await store.initialize(), 2);
    store.append(message("new"));
    await store.idle();
    assert.equal(docs.get(JSON.stringify(["room", "new"]))!.position, 100000);
  } finally { await store.close(); }
});

test("one edit in 10000 messages writes only that message and keeps stored positions", async () => {
  const seed = Array.from({ length: 10000 }, (_, index) => document(message(String(index)), index * 2));
  // Unchanged history must never be serialized while saving a mutation.
  Object.defineProperty(seed[0].message, "toJSON", { value: () => { throw new Error("full snapshot"); } });
  const { store, writes, docs } = fixture(seed);
  try {
    const rooms = await store.load();
    const changed = rooms.get("room")![50];
    changed.text = "edited";
    store.update(changed);
    await store.idle();
    assert.equal(writes.flat().length, 1);
    assert.equal(docs.get(seed[50]._id)!.message.text, "edited");
    assert.equal(docs.get(seed[50]._id)!.position, 100);
    store.remove("room", "9999");
    store.append(message("new"));
    await store.idle();
    assert.equal(docs.get(JSON.stringify(["room", "new"]))!.position, 19999);
    assert.equal(writes.flat().length, 3);
  } finally { await store.close(); }
});

test("queued changes capture nested values, preserve room identity and drain writes arriving in flight", async () => {
  const { store, docs, writes, intercept, apply } = fixture();
  let started!: () => void, release!: () => void;
  const began = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  intercept(async operations => { started(); await gate; apply(operations); });
  try {
    const first = message("same");
    store.append(first);
    await began;
    first.reactions = ["👍"];
    store.update(first);
    first.reactions.push("❤️");
    store.append(message("same", "other"));
    release();
    await store.idle();
    assert.deepEqual(docs.get(JSON.stringify(["room", "same"]))!.message.reactions, ["👍"]);
    assert.equal(docs.get(JSON.stringify(["other", "same"]))!.position, 0);
    assert.equal(writes.flat().length, 3);
  } finally { release(); await store.close(); }
});

test("partial failure retries the failed batch before newer edits and room deletion without resurrection", async () => {
  const { store, docs, writes, intercept, apply } = fixture();
  try {
    intercept(async operations => { apply(operations.slice(0, 1)); throw new Error("partial write"); });
    store.append(message("old"));
    store.append(message("old", "other"));
    await assert.rejects(store.idle(), /partial write/);
    assert.equal(await store.healthy(), false);
    intercept();
    store.clear("room");
    store.update({ ...message("old"), text: "late background result" });
    store.append(message("new"));
    await store.idle();
    assert.deepEqual(writes[1], writes[0], "retry the original batch first");
    assert.equal(docs.has(JSON.stringify(["room", "old"])), false);
    assert.equal(docs.has(JSON.stringify(["other", "old"])), true);
    assert.equal(docs.get(JSON.stringify(["room", "new"]))!.position, 1);
    store.remove("room", "new");
    store.update(message("new"));
    await store.idle();
    assert.equal(docs.has(JSON.stringify(["room", "new"])), false);
  } finally { intercept(); await store.close(); }
});

test("automatic retry also recovers without another incoming mutation", async () => {
  const { store, docs, intercept } = fixture();
  try {
    intercept(async () => { throw new Error("temporary failure"); });
    store.append(message("retry"));
    await assert.rejects(store.idle(), /temporary failure/);
    intercept();
    await new Promise(resolve => setTimeout(resolve, 2200));
    await store.idle();
    assert.equal(docs.has(JSON.stringify(["room", "retry"])), true);
  } finally { intercept(); await store.close(); }
});

test("bursts are batched and shutdown drains all writes and rejects late mutations", async () => {
  const { store, docs, writes } = fixture();
  for (let index = 0; index < 1201; index++) store.append(message(String(index)));
  await store.close();
  assert.deepEqual(writes.map(batch => batch.length), [500, 500, 201]);
  assert.equal(docs.size, 1201);
  assert.throws(() => store.append(message("late")), /closing/);
  assert.throws(() => store.update(message("late")), /closing/);
  assert.throws(() => store.clear("room"), /closing/);
  assert.throws(() => store.remove("room", "late"), /closing/);
});

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
    store.update(list[1]);
    const [removed] = list.splice(2, 1);
    store.remove("room", removed.id);
    // A later mutation must also be captured while the first write is pending.
    list.push({ id: "new", room: "room", createdAt: Date.now(), text: "После миграции" });
    store.append(list[list.length - 1]);
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
    store.update(restored.get("room")![0]);
    await assert.rejects(store.idle(), /simulated/);
    assert.equal(await store.healthy(), false);
    internals.collection.bulkWrite = original;
    store.update(restored.get("room")![0]);
    await store.idle();
    assert.equal(await store.healthy(), true);
    restored.set("room", []);
    store.clear("room");
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
