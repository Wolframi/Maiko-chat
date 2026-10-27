import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MongoClient, type Collection } from "mongodb";
import { MessageStore } from "../src/server/messageStore";
import { summarizeMessages } from "../src/server/messageSummary";
import type { SavedSummary, SummarySource } from "../src/server/messageSummaries";

type Message = {
  id: string; room: string; createdAt: number; text: string; authorId?: string; kind?: string;
  hiddenFor?: string[]; replyTo?: { id: string; text: string }; invite?: { groupId: string; status: string };
};
type Internals = { collection: Collection<SummarySource<Message>>; summaries: {
  saved: Collection<SavedSummary<Message>>; dirty: Collection<{ _id: string; room?: string; all?: boolean }>;
  read: (room: string, viewer: string, readAt: number) => Promise<unknown>;
  forgetViewer: (rooms: string[], viewer: string) => Promise<unknown>;
} };

test("saved summaries match history through writes, reads, hides, maintenance, retries and crash recovery", {
  skip: !process.env.TEST_MONGODB_URI, timeout: 180_000,
}, async () => {
  const uri = process.env.TEST_MONGODB_URI!;
  const database = `maiko_test_summaries_${Date.now()}`;
  const folder = mkdtempSync(path.join(tmpdir(), "maiko-summary-test-"));
  const file = path.join(folder, "messages.json");
  const admin = new MongoClient(uri);
  let store = new MessageStore<Message>(uri, database);
  const messages: Message[] = Array.from({ length: 2500 }, (_, index) => ({
    id: `m-${index}`, room: "room", createdAt: 1700000000000 + index % 500,
    text: `Message ${index}`, authorId: index % 2 ? "a" : "b",
    ...(index % 7 === 0 ? { hiddenFor: ["a"] } : {}), ...(index % 11 === 0 ? { kind: "system" } : {}),
  }));
  const readAt = 1700000000250;
  const append = (id: string, extra: Partial<Message> = {}) => {
    const message = { id, room: "room", createdAt: Date.now(), text: id, authorId: "b", ...extra };
    messages.push(message); store.append(message); return message;
  };
  const check = async (at = readAt) => {
    for (const viewer of ["a", "b"]) assert.deepEqual(await store.summary("room", viewer, at), summarizeMessages(messages, viewer, at));
  };
  const other: Message = { id: "untouched", room: "other", createdAt: 1, text: "Other room" };
  writeFileSync(file, JSON.stringify({ room: messages, other: [other] }));
  try {
    await store.connect(); await store.migrate(file); await store.initialize();
    await check();
    assert.deepEqual(await store.summary("other", "a", 0), summarizeMessages([other], "a", 0));
    let internals = store as unknown as Internals;
    // Repeated list reads and a normal mark-read must not query message bodies or counts.
    const originals = { aggregate: internals.collection.aggregate, countDocuments: internals.collection.countDocuments, findOne: internals.collection.findOne, find: internals.collection.find };
    const forbidden = () => { throw new Error("A warm summary must not query messages"); };
    Object.assign(internals.collection, { aggregate: forbidden, countDocuments: forbidden, findOne: forbidden, find: forbidden });
    await check(); await check(); await check(Date.now());
    Object.assign(internals.collection, originals);
    await check(); // A historical read watermark still preserves exact timestamp semantics.

    const backdated = append("backdated", { createdAt: 1 });
    await check();
    store.append({ ...backdated, text: "duplicate must not overwrite" });
    await check();
    backdated.text = "edited preview"; store.update(backdated); await check();
    Object.assign(backdated, { kind: "system", text: "deleted" }); store.update(backdated); await check();
    const reply = append("reply", { replyTo: { id: "m-10", text: "old quote" } });
    await check();
    store.redactReplies("room", "m-10", "deleted quote"); reply.replyTo!.text = "deleted quote"; await check();
    const invite = append("invite", { kind: "invite", invite: { groupId: "group", status: "pending" } });
    await check();
    store.expireInvites("group", "expired invitation"); invite.text = "expired invitation"; invite.invite!.status = "expired"; await check();

    store.hide("room", "a");
    for (const message of messages) message.hiddenFor = [...new Set([...(message.hiddenFor ?? []), "a"])];
    append("after-hide"); await check();
    store.hide("room", "a");
    for (const message of messages) message.hiddenFor = [...new Set([...(message.hiddenFor ?? []), "a"])];
    append("after-second-hide"); await check();

    // A partially applied message batch must use its original preimages on retry.
    const sourceWrite = internals.collection.bulkWrite.bind(internals.collection);
    internals.collection.bulkWrite = async (operations, options) => {
      await sourceWrite(operations.slice(0, 2), options);
      throw new Error("partial message failure");
    };
    store.hide("room", "a");
    for (const message of messages) message.hiddenFor = [...new Set([...(message.hiddenFor ?? []), "a"])];
    append("partial-one"); append("partial-two");
    await assert.rejects(store.idle(), /partial message failure/);
    await assert.rejects(store.summary("room", "a", readAt), /partial message failure/);
    internals.collection.bulkWrite = sourceWrite;
    append("after-partial-retry"); await check();

    // A partial summary write retries absolute values, without replaying acknowledged messages.
    const savedWrite = internals.summaries.saved.bulkWrite.bind(internals.summaries.saved);
    let messageWrites = 0;
    internals.collection.bulkWrite = async (...args) => { messageWrites++; return sourceWrite(...args); };
    internals.summaries.saved.bulkWrite = async (operations, options) => {
      await savedWrite(operations.slice(0, 1), options); throw new Error("partial summary failure");
    };
    append("summary-failure");
    await assert.rejects(store.idle(), /partial summary failure/);
    await assert.rejects(internals.summaries.read("room", "a", readAt), /Unfinished/);
    await assert.rejects(internals.summaries.forgetViewer(["room"], "a"), /Unfinished/);
    assert.ok(await internals.summaries.dirty.countDocuments());
    internals.summaries.saved.bulkWrite = savedWrite;
    await new Promise(resolve => setTimeout(resolve, 2200));
    await check();
    assert.equal(messageWrites, 1, "a summary retry must not repeat the already acknowledged message batch");
    internals.collection.bulkWrite = sourceWrite;

    // A crash between source and derived writes leaves a durable recovery marker.
    internals.summaries.saved.bulkWrite = async () => { throw new Error("simulated crash"); };
    append("crash-survivor");
    await assert.rejects(store.idle(), /simulated crash/);
    await assert.rejects(store.close(), /simulated crash/);
    store = new MessageStore<Message>(uri, database);
    await store.connect(); await store.initialize(); await check();
    internals = store as unknown as Internals;
    assert.equal(await internals.summaries.dirty.countDocuments(), 0);
    await store.close();
    store = new MessageStore<Message>(uri, database);
    await store.connect(); await store.initialize();
    const aggregate = internals.collection.aggregate;
    internals = store as unknown as Internals;
    internals.collection.aggregate = forbidden as typeof aggregate;
    await check(); // Clean restarts keep the saved counters.
    assert.deepEqual(await store.summary("other", "a", 0), summarizeMessages([other], "a", 0));
    internals.collection.aggregate = aggregate.bind(internals.collection);

    const last = messages.pop()!; store.remove("room", last.id); await check();
    messages.length = 0; store.clear("room"); store.update(last); await check();
    append("after-clear"); await check();
    await store.forgetViewerSummaries(["room"], "a");
    assert.equal(await internals.summaries.saved.countDocuments({ room: "room", viewerId: "a" }), 0);
    append("after-member-left");
    assert.equal(await internals.summaries.saved.countDocuments({ room: "room", viewerId: "a" }), 0, "leavers must not remain in the write fanout");
    await check(); // Rejoining creates an accurate summary on demand.
    await store.forgetViewerSummaries(["room"], "a");
    const warming = store.summary("room", "a", readAt);
    append("while-cold-summary-warms");
    await warming; await check();
  } finally {
    await store.close().catch(() => undefined);
    await admin.db(database).dropDatabase(); await admin.close();
    if (path.dirname(folder) !== path.resolve(tmpdir()) || !path.basename(folder).startsWith("maiko-summary-test-")) throw new Error("Invalid fixture path");
    rmSync(folder, { recursive: true, force: true });
  }
});
