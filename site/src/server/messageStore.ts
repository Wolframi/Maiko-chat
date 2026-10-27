import { MongoClient, type Collection, type AnyBulkWriteOperation, type Filter, type UpdateFilter } from "mongodb";
import { readFileSync } from "node:fs";
import { MessageSummaries } from "./messageSummaries";

export type StoredMessage = { id: string; room: string; createdAt: number };
type MessageDocument<T> = { _id: string; room: string; position: number; message: T };
type Migration = { _id: string; count: number; completedAt: number };

/** One application writer, with ordered incremental writes and journaled acknowledgements. */
export class MessageStore<T extends StoredMessage> {
  private client: MongoClient;
  private collection: Collection<MessageDocument<T>>;
  private migrations: Collection<Migration>;
  private summaries: MessageSummaries<T>;
  private nextPosition = new Map<string, number>();
  private chain: Promise<void> = Promise.resolve();
  private pending: AnyBulkWriteOperation<MessageDocument<T>>[] = [];
  private batch?: AnyBulkWriteOperation<MessageDocument<T>>[];
  private retry?: ReturnType<typeof setTimeout>;
  private failure?: Error;
  private closing = false;
  private flushing = false;
  private healthCheck?: Promise<boolean>;

  constructor(uri: string, database = "maiko") {
    this.client = new MongoClient(uri, {
      appName: "maiko-messages", maxPoolSize: 10,
      serverSelectionTimeoutMS: 5_000, connectTimeoutMS: 5_000,
      socketTimeoutMS: 10_000, writeConcern: { w: "majority", journal: true },
    });
    const db = this.client.db(database);
    this.collection = db.collection<MessageDocument<T>>("messages");
    this.migrations = db.collection<Migration>("migrations");
    this.summaries = new MessageSummaries<T>(db, () => this.collection);
  }

  async connect() {
    await this.client.connect();
    await this.collection.createIndex({ room: 1, position: 1 });
    await this.collection.createIndex({ "message.authorId": 1, "message.clientId": 1 });
    await this.collection.createIndex({ room: 1, "message.replyTo.id": 1 });
    await this.collection.createIndex({ "message.invite.groupId": 1, "message.invite.status": 1 });
    await this.collection.createIndex({ room: 1, "message.kind": 1, position: 1 });
    await this.summaries.initialize();
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
    this.nextPosition.clear();
    for await (const doc of this.collection.find({}).sort({ room: 1, position: 1 })) {
      const list = rooms.get(doc.room) || [];
      list.push(doc.message);
      rooms.set(doc.room, list);
      this.nextPosition.set(doc.room, Math.max(this.nextPosition.get(doc.room) ?? 0, doc.position + 1));
    }
    return rooms;
  }

  /** Startup reads only room counters, never message bodies. */
  async initialize() {
    if (!await this.migrated()) throw new Error("Run npm run messages:migrate -- --apply before enabling MongoDB");
    this.nextPosition.clear();
    for await (const room of this.collection.aggregate<{ _id: string; position: number }>([
      { $group: { _id: "$room", position: { $max: "$position" } } },
    ], { allowDiskUse: true })) this.nextPosition.set(room._id, room.position + 1);
    return this.nextPosition.size;
  }

  private filter(query: Record<string, unknown>) { return query as Filter<MessageDocument<T>>; }

  async get(room: string, id: string, viewerId?: string) {
    await this.idle();
    const doc = await this.collection.findOne(this.filter({
      _id: JSON.stringify([room, id]),
      ...(viewerId ? { "message.hiddenFor": { $ne: viewerId } } : {}),
    }));
    return doc?.message;
  }

  async findClient(room: string, authorId: string, clientId: string, viewerId?: string) {
    await this.idle();
    const doc = await this.collection.findOne(this.filter({ room, "message.authorId": authorId, "message.clientId": clientId,
      ...(viewerId ? { "message.hiddenFor": { $ne: viewerId } } : {}),
    }));
    return doc?.message;
  }

  async getMany(room: string, ids: readonly string[]) {
    if (!ids.length) return [];
    if (ids.length > 200) throw new Error("Message lookup exceeds page size");
    await this.idle();
    const docs = await this.collection.find(this.filter({ _id: { $in: [...new Set(ids)].map(id => JSON.stringify([room, id])) } })).limit(ids.length).toArray();
    return docs.map(doc => doc.message);
  }

  async page(room: string, viewerId: string, before?: string, limit = 80) {
    await this.idle();
    const filter: Record<string, unknown> = { room, "message.hiddenFor": { $ne: viewerId },
      $nor: [{ "message.kind": "system", "message.text": /\S[\s\S]* (в чате|вышел)\s*$/ }],
    };
    if (before) {
      const cursor = await this.collection.findOne(this.filter({ _id: JSON.stringify([room, before]), "message.hiddenFor": { $ne: viewerId } }));
      if (!cursor) throw new Error("История изменилась. Откройте чат снова.");
      filter.position = { $lt: cursor.position };
    }
    const size = Math.max(1, Math.min(200, Math.floor(limit) || 80));
    const docs = await this.collection.find(this.filter(filter)).sort({ position: -1 }).limit(size + 1).toArray();
    const hasMore = docs.length > size;
    const messages = docs.slice(0, size).reverse().map(doc => doc.message);
    return { messages, hasMore, before: messages[0]?.id ?? null };
  }

  async summary(room: string, viewerId: string, readAt = 0) {
    await this.idle();
    return this.summaries.read(room, viewerId, readAt);
  }

  async forgetViewerSummaries(rooms: readonly string[], viewerId: string) {
    await this.idle();
    await this.summaries.forgetViewer(rooms, viewerId);
  }

  private threadFilter(room: string, viewerId: string) {
    return { room, "message.hiddenFor": { $ne: viewerId },
      $nor: [{ "message.kind": "system", "message.text": /\S[\s\S]* (в чате|вышел)\s*$/ }],
    };
  }

  private async navigationAnchor(room: string, viewerId: string, id: string) {
    const anchor = await this.collection.findOne(this.filter({ ...this.threadFilter(room, viewerId), _id: JSON.stringify([room, id]) }));
    if (!anchor) throw new Error("Сообщение недоступно в истории");
    return anchor;
  }

  async window(room: string, viewerId: string, id: string) {
    await this.idle();
    const anchor = await this.navigationAnchor(room, viewerId, id);
    const visible = this.threadFilter(room, viewerId);
    const [older, newer] = await Promise.all([
      this.collection.find(this.filter({ ...visible, position: { $lt: anchor.position } })).sort({ position: -1 }).limit(41).toArray(),
      this.collection.find(this.filter({ ...visible, position: { $gt: anchor.position } })).sort({ position: 1 }).limit(41).toArray(),
    ]);
    const messages = [...older.slice(0, 40).reverse(), anchor, ...newer.slice(0, 40)].map(doc => doc.message);
    return { messages, before: messages[0].id, after: messages.at(-1)!.id, hasMore: older.length > 40, hasNewer: newer.length > 40 };
  }

  async newerPage(room: string, viewerId: string, after: string) {
    await this.idle();
    const anchor = await this.navigationAnchor(room, viewerId, after);
    const docs = await this.collection.find(this.filter({ ...this.threadFilter(room, viewerId), position: { $gt: anchor.position } }))
      .sort({ position: 1 }).limit(81).toArray();
    const messages = docs.slice(0, 80).map(doc => doc.message);
    return { messages, after: messages.at(-1)?.id ?? after, hasNewer: docs.length > 80 };
  }

  async search(room: string, viewerId: string, query: string, after?: string) {
    await this.idle();
    if (!query.trim()) return { ids: [], after: null, hasMore: false };
    // Treat the query as literal text, including regex operators. Only IDs leave MongoDB.
    const literal = new RegExp(query.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    const anchor = after ? await this.navigationAnchor(room, viewerId, after) : undefined;
    const docs = await this.collection.find(this.filter({ room, "message.hiddenFor": { $ne: viewerId },
      "message.kind": { $nin: ["system", "call"] },
      $or: [{ "message.text": literal }, { "message.author": literal }, { "message.file.name": literal }],
      ...(anchor ? { position: { $gt: anchor.position } } : {}),
    }), { projection: { "message.id": 1 } }).sort({ position: 1 }).limit(41).maxTimeMS(5_000).toArray();
    const ids = docs.slice(0, 40).map(doc => doc.message.id);
    return { ids, after: ids.at(-1) ?? null, hasMore: docs.length > 40 };
  }

  /** Bounded driver batches for maintenance and compatibility exports. Close on early exit. */
  async *scan(query: Record<string, unknown> = {}, newestFirst = false) {
    await this.idle();
    const cursor = this.collection.find(this.filter(query)).sort({ room: 1, position: newestFirst ? -1 : 1 }).batchSize(80);
    try { for await (const doc of cursor) yield doc.message; }
    finally { await cursor.close(); }
  }

  hide(room: string, viewerId: string) {
    this.enqueue({ updateMany: { filter: this.filter({ room, position: { $lt: this.nextPosition.get(room) ?? 0 }, "message.hiddenFor": { $ne: viewerId } }),
      update: { $addToSet: { "message.hiddenFor": viewerId } } as UpdateFilter<MessageDocument<T>>,
    } });
  }

  redactReplies(room: string, messageId: string, text: string) {
    this.enqueue({ updateMany: { filter: this.filter({ room, "message.replyTo.id": messageId }),
      update: { $set: { "message.replyTo.text": text } },
    } });
  }

  expireInvites(groupId: string, text: string) {
    this.enqueue({ updateMany: { filter: this.filter({ "message.kind": "invite", "message.invite.groupId": groupId, "message.invite.status": "pending" }),
      update: { $set: { "message.text": text, "message.invite.status": "expired" } },
    } });
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

  private enqueue(operation: AnyBulkWriteOperation<MessageDocument<T>>) {
    if (this.closing) throw new Error("Message store is closing");
    this.pending.push(operation);
    this.schedule();
  }

  private capture(message: T): T {
    if (!message || typeof message.id !== "string" || !message.id || typeof message.room !== "string" || !message.room || !Number.isFinite(message.createdAt)) {
      throw new Error("Invalid message");
    }
    // Capture only this mutation, before the caller can change nested fields.
    return JSON.parse(JSON.stringify(message));
  }

  /** Positions are monotonic per room; deletions never renumber other messages. */
  append(message: T) {
    const captured = this.capture(message);
    const position = this.nextPosition.get(captured.room) ?? 0;
    const doc = { _id: JSON.stringify([captured.room, captured.id]), room: captured.room, position, message: captured };
    this.enqueue({ updateOne: { filter: { _id: doc._id }, update: { $setOnInsert: doc }, upsert: true } });
    this.nextPosition.set(captured.room, position + 1);
  }

  /** Updates must not recreate messages deleted while background work was running. */
  update(message: T) {
    const captured = this.capture(message);
    this.enqueue({ updateOne: {
      filter: { _id: JSON.stringify([captured.room, captured.id]) },
      update: { $set: { message: captured } },
    } });
  }

  remove(room: string, messageId: string) {
    this.enqueue({ deleteOne: { filter: { _id: JSON.stringify([room, messageId]) } } });
  }

  clear(room: string) {
    this.enqueue({ deleteMany: { filter: { room } } });
  }

  private schedule() {
    if (this.flushing) return;
    this.flushing = true;
    this.chain = this.chain.then(async () => {
      while (this.batch || this.pending.length) {
        // Keep a failed (possibly partially applied) batch ahead of newer changes.
        // Every operation is idempotent, so replay preserves the original order.
        this.batch ??= this.pending.splice(0, 500);
        await this.summaries.writeBatch(this.batch, () => this.collection.bulkWrite(this.batch!, { ordered: true }));
        this.batch = undefined;
        this.failure = undefined;
        if (this.retry) { clearTimeout(this.retry); this.retry = undefined; }
      }
    }).catch((error: Error) => {
      this.failure = error;
      console.error("[persist:mongodb]", error.name);
      if (!this.retry && !this.closing) {
        this.retry = setTimeout(() => { this.retry = undefined; this.schedule(); }, 2_000);
        this.retry.unref();
      }
    }).finally(() => {
      this.flushing = false;
      if ((this.batch || this.pending.length) && !this.failure) this.schedule();
    });
  }

  async idle() {
    while (true) {
      const chain = this.chain;
      await chain;
      if (this.failure) throw this.failure;
      if (chain === this.chain && !this.batch && !this.pending.length) return;
    }
  }

  async healthy() {
    if (this.failure) return false;
    if (!this.healthCheck) {
      this.healthCheck = this.client.db().command({ ping: 1 }).then(() => true, () => false)
        .finally(() => { this.healthCheck = undefined; });
    }
    return this.healthCheck;
  }

  async close() {
    this.closing = true;
    if (this.retry) clearTimeout(this.retry);
    try { await this.idle(); await this.summaries.idle(); } finally { await this.client.close(); }
  }
}
