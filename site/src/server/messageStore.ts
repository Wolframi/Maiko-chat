import { MongoClient, type Collection, type AnyBulkWriteOperation } from "mongodb";
import { readFileSync } from "node:fs";

export type StoredMessage = { id: string; room: string; createdAt: number };
type MessageDocument<T> = { _id: string; room: string; position: number; message: T };
type Migration = { _id: string; count: number; completedAt: number };

/** One application writer, with ordered incremental writes and journaled acknowledgements. */
export class MessageStore<T extends StoredMessage> {
  private client: MongoClient;
  private collection: Collection<MessageDocument<T>>;
  private migrations: Collection<Migration>;
  private saved = new Map<string, string>();
  private chain: Promise<void> = Promise.resolve();
  private latest?: Map<string, MessageDocument<T>>;
  private retry?: ReturnType<typeof setTimeout>;
  private failure?: Error;
  private closing = false;

  constructor(uri: string, database = "maiko") {
    this.client = new MongoClient(uri, {
      appName: "maiko-messages", maxPoolSize: 10,
      serverSelectionTimeoutMS: 5_000, connectTimeoutMS: 5_000,
      socketTimeoutMS: 10_000, writeConcern: { w: "majority", journal: true },
    });
    const db = this.client.db(database);
    this.collection = db.collection<MessageDocument<T>>("messages");
    this.migrations = db.collection<Migration>("migrations");
  }

  async connect() {
    await this.client.connect();
    await this.collection.createIndex({ room: 1, position: 1 });
    await this.collection.createIndex({ "message.authorId": 1, "message.clientId": 1 });
  }

  async migrated() {
    return Boolean(await this.migrations.findOne({ _id: "json-messages-v1" }));
  }

  /** Explicit, restartable import. Never overwrite already imported records. */
  async migrate(file: string) {
    if (await this.migrated()) throw new Error("Message migration already completed");
    const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid messages snapshot");
    const rooms = new Map<string, T[]>();
    for (const [room, items] of Object.entries(raw)) {
      if (!Array.isArray(items)) throw new Error(`Invalid message room: ${room}`);
      rooms.set(room, items as T[]);
    }
    const docs = this.snapshot(rooms);
    // Refuse a conflicting partial import; a retry may only contain identical data.
    for await (const existing of this.collection.find({})) {
      const expected = docs.get(existing._id);
      if (!expected || JSON.stringify(existing.message) !== JSON.stringify(expected.message) || existing.position !== expected.position) {
        throw new Error("MongoDB contains messages that differ from the import snapshot");
      }
    }
    const values = [...docs.values()];
    for (let i = 0; i < values.length; i += 500) {
      await this.collection.bulkWrite(values.slice(i, i + 500).map((doc) => ({
        updateOne: { filter: { _id: doc._id }, update: { $setOnInsert: doc }, upsert: true },
      })), { ordered: true });
    }
    if (await this.collection.countDocuments() !== values.length) throw new Error("Imported message count mismatch");
    await this.migrations.insertOne({ _id: "json-messages-v1", count: values.length, completedAt: Date.now() });
    return { rooms: rooms.size, messages: values.length };
  }

  async load() {
    if (!await this.migrated()) throw new Error("Run npm run messages:migrate -- --apply before enabling MongoDB");
    const rooms = new Map<string, T[]>();
    this.saved.clear();
    for await (const doc of this.collection.find({}).sort({ room: 1, position: 1 })) {
      const list = rooms.get(doc.room) || [];
      list.push(doc.message);
      rooms.set(doc.room, list);
      this.saved.set(doc._id, JSON.stringify(doc));
    }
    return rooms;
  }

  private snapshot(rooms: Map<string, T[]>) {
    const docs = new Map<string, MessageDocument<T>>();
    for (const [room, messages] of rooms) {
      messages.forEach((message, position) => {
        if (!message || typeof message.id !== "string" || !message.id || message.room !== room || !Number.isFinite(message.createdAt)) {
          throw new Error(`Invalid message in room ${room} at ${position}`);
        }
        const _id = JSON.stringify([room, message.id]);
        if (docs.has(_id)) throw new Error(`Duplicate message in room ${room}`);
        // Capture mutations now, before any asynchronous operation.
        docs.set(_id, JSON.parse(JSON.stringify({ _id, room, position, message })));
      });
    }
    return docs;
  }

  save(rooms: Map<string, T[]>) {
    if (this.closing) throw new Error("Message store is closing");
    this.latest = this.snapshot(rooms);
    this.schedule();
  }

  private schedule() {
    this.chain = this.chain.then(async () => {
      const snapshot = this.latest;
      if (!snapshot) return;
      const next = new Map<string, string>();
      const operations: AnyBulkWriteOperation<MessageDocument<T>>[] = [];
      for (const [id, doc] of snapshot) {
        const value = JSON.stringify(doc);
        next.set(id, value);
        if (this.saved.get(id) !== value) operations.push({ replaceOne: { filter: { _id: id }, replacement: doc, upsert: true } });
      }
      for (const id of this.saved.keys()) {
        if (!snapshot.has(id)) operations.push({ deleteOne: { filter: { _id: id } } });
      }
      for (let i = 0; i < operations.length; i += 500) {
        await this.collection.bulkWrite(operations.slice(i, i + 500), { ordered: true });
      }
      this.saved = next;
      this.failure = undefined;
    }).catch((error: Error) => {
      this.failure = error;
      console.error("[persist:mongodb]", error.name);
      if (!this.retry && !this.closing) {
        this.retry = setTimeout(() => { this.retry = undefined; this.schedule(); }, 2_000);
        this.retry.unref();
      }
    });
  }

  async idle() {
    await this.chain;
    if (this.failure) throw this.failure;
  }

  async healthy() {
    if (this.failure) return false;
    try { await this.client.db().command({ ping: 1 }); return true; }
    catch { return false; }
  }

  async close() {
    this.closing = true;
    if (this.retry) clearTimeout(this.retry);
    try { await this.idle(); } finally { await this.client.close(); }
  }
}
