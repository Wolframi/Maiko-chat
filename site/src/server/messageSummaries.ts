import type { AnyBulkWriteOperation, Collection, Db, Filter } from "mongodb";

type Message = { id: string; room: string; createdAt: number; kind?: string; authorId?: string; hiddenFor?: string[] };
export type SummarySource<T> = { _id: string; room: string; position: number; message: T };
export type SavedSummary<T> = {
  _id: string; room: string; viewerId: string; readAt: number;
  count: number; unreadCount: number; last: T | null; lastPosition: number; maxCreatedAt: number;
};
type SummaryPlan<T> = SavedSummary<T> & { needsLast?: boolean };
type DirtyRoom = { _id: string; room?: string; all?: boolean };
type Maintenance = {
  $addToSet?: { "message.hiddenFor"?: string };
  $set?: { "message.replyTo.text"?: string; "message.text"?: string; "message.invite.status"?: string };
};
type MaintenanceMessage = Message & { text?: string; replyTo?: { id: string; text: string }; invite?: { groupId: string; status: string } };

function visible(message: Message | undefined, viewerId: string) {
  return Boolean(message && message.kind !== "system" && !message.hiddenFor?.includes(viewerId));
}
function unread(message: Message | undefined, summary: SavedSummary<unknown>) {
  return visible(message, summary.viewerId) && message!.authorId !== summary.viewerId && message!.createdAt > summary.readAt;
}

/** Apply one before/after pair, in stored order. No history scan or timestamp ordering. */
export function applySummaryChange<T extends Message>(summary: SummaryPlan<T>, before?: SummarySource<T>, after?: SummarySource<T>) {
  summary.count += Number(visible(after?.message, summary.viewerId)) - Number(visible(before?.message, summary.viewerId));
  summary.unreadCount += Number(unread(after?.message, summary)) - Number(unread(before?.message, summary));
  if (after && visible(after.message, summary.viewerId)) {
    summary.maxCreatedAt = Math.max(summary.maxCreatedAt, after.message.createdAt);
    if (after.position >= summary.lastPosition) {
      summary.last = after.message;
      summary.lastPosition = after.position;
    }
  } else if (before && summary.last?.id === before.message.id) {
    summary.last = null;
    summary.lastPosition = -1;
    summary.needsLast = true;
  }
}

/** Durable, lazily initialized per-viewer counters. One application writer. */
export class MessageSummaries<T extends Message> {
  private saved: Collection<SavedSummary<T>>;
  private dirty: Collection<DirtyRoom>;
  private lane: Promise<unknown> = Promise.resolve();
  private prepared?: { operations: readonly AnyBulkWriteOperation<SummarySource<T>>[]; plans: SummaryPlan<T>[]; markers: DirtyRoom[]; messagesWritten?: boolean };

  constructor(db: Db, private messages: () => Collection<SummarySource<T>>) {
    this.saved = db.collection<SavedSummary<T>>("message_summaries");
    this.dirty = db.collection<DirtyRoom>("message_summary_dirty");
  }

  private serial<R>(work: () => Promise<R>): Promise<R> {
    const result = this.lane.then(work);
    this.lane = result.catch(() => undefined);
    return result;
  }

  idle() { return this.lane; }

  forgetViewer(rooms: readonly string[], viewerId: string) {
    return this.serial(() => {
      if (this.prepared) throw new Error("Unfinished message summary batch");
      return this.saved.deleteMany({ room: { $in: [...rooms] }, viewerId });
    });
  }

  async initialize() {
    await this.saved.createIndex({ room: 1 });
    await this.saved.createIndex({ "last.invite.groupId": 1, "last.invite.status": 1 }, { sparse: true });
    const interrupted = await this.dirty.find({}).toArray();
    // Only derived data is discarded. The next reader reconstructs it from durable messages.
    if (interrupted.length) {
      await this.saved.deleteMany(interrupted.some(marker => marker.all) ? {} : { room: { $in: interrupted.map(marker => marker.room!) } });
      await this.dirty.deleteMany({ _id: { $in: interrupted.map(marker => marker._id) } });
    }
  }

  read(room: string, viewerId: string, readAt: number) {
    return this.serial(async () => {
      if (this.prepared) throw new Error("Unfinished message summary batch");
      const key = JSON.stringify([room, viewerId]);
      let summary = await this.saved.findOne({ _id: key });
      const filter = { room, "message.hiddenFor": { $ne: viewerId }, "message.kind": { $ne: "system" } } as Filter<SummarySource<T>>;
      if (!summary) {
        // Once per viewer/room (or crash repair), not once per chat-list notification.
        const [initial] = await this.messages().aggregate<Pick<SavedSummary<T>, "count" | "unreadCount" | "last" | "lastPosition" | "maxCreatedAt">>([
          { $match: filter }, { $sort: { position: 1 } },
          { $group: { _id: null, count: { $sum: 1 },
            unreadCount: { $sum: { $cond: [{ $and: [{ $gt: ["$message.createdAt", readAt] }, { $ne: [{ $ifNull: ["$message.authorId", null] }, viewerId] }] }, 1, 0] } },
            last: { $last: "$message" }, lastPosition: { $last: "$position" }, maxCreatedAt: { $max: "$message.createdAt" },
          } }, { $project: { _id: 0 } },
        ], { allowDiskUse: true }).toArray();
        summary = { _id: key, room, viewerId, readAt, ...(initial ?? { count: 0, unreadCount: 0, last: null, lastPosition: -1, maxCreatedAt: 0 }) };
        await this.saved.replaceOne({ _id: key }, summary, { upsert: true });
      } else if (summary.readAt !== readAt) {
        // Normal reads advance past all stored timestamps: no message query is needed.
        summary.unreadCount = readAt >= summary.maxCreatedAt ? 0 : await this.messages().countDocuments({ ...filter,
          "message.createdAt": { $gt: readAt }, "message.authorId": { $ne: viewerId },
        } as Filter<SummarySource<T>>);
        summary.readAt = readAt;
        await this.saved.replaceOne({ _id: key }, summary);
      }
      return { count: summary.count, unreadCount: summary.unreadCount, last: summary.last ?? undefined };
    });
  }

  private async prepare(operations: readonly AnyBulkWriteOperation<SummarySource<T>>[]) {
    const ids = new Set<string>(), rooms = new Set<string>();
    const inviteGroups = new Set<string>();
    for (const operation of operations) {
      const filter = "updateOne" in operation ? operation.updateOne.filter : "deleteOne" in operation ? operation.deleteOne.filter
        : "updateMany" in operation ? operation.updateMany.filter : "deleteMany" in operation ? operation.deleteMany.filter : undefined;
      if (!filter) throw new Error("Unsupported summary mutation");
      if (typeof filter._id === "string") {
        ids.add(filter._id);
        rooms.add(JSON.parse(filter._id)[0]);
      } else if (typeof filter.room === "string") rooms.add(filter.room);
      else if ("updateMany" in operation && typeof filter["message.invite.groupId"] === "string") inviteGroups.add(filter["message.invite.groupId"]);
      else throw new Error("Unsupported summary mutation scope");
    }
    const scopes: Filter<SavedSummary<T>>[] = [{ room: { $in: [...rooms] } }];
    if (inviteGroups.size) scopes.push({ "last.kind": "invite", "last.invite.groupId": { $in: [...inviteGroups] }, "last.invite.status": "pending" } as Filter<SavedSummary<T>>);
    const plans: SummaryPlan<T>[] = await this.saved.find({ $or: scopes }).toArray();
    // Point preimages are bounded by the writer batch, never by thread length.
    const existing = ids.size ? await this.messages().find({ _id: { $in: [...ids] } } as Filter<SummarySource<T>>).limit(ids.size).toArray() : [];
    const documents = new Map(existing.map(doc => [doc._id, doc]));
    for (const operation of operations) {
      if ("updateOne" in operation || "deleteOne" in operation) {
        const entry = "updateOne" in operation ? operation.updateOne : operation.deleteOne;
        const id = String(entry.filter._id), before = documents.get(id);
        const update = "updateOne" in operation ? operation.updateOne.update as { $setOnInsert?: SummarySource<T>; $set?: { message: T } } : undefined;
        const after = update ? before ? update.$set ? { ...before, message: update.$set.message } : before : update.$setOnInsert : undefined;
        if (after) documents.set(id, after); else documents.delete(id);
        const room = (after ?? before)?.room;
        if (before !== after) for (const summary of plans) if (summary.room === room) applySummaryChange(summary, before, after);
      } else if ("deleteMany" in operation) {
        const room = operation.deleteMany.filter.room;
        for (const [id, doc] of documents) if (doc.room === room) documents.delete(id);
        for (const summary of plans) if (summary.room === room) Object.assign(summary, { count: 0, unreadCount: 0, last: null, lastPosition: -1, maxCreatedAt: 0, needsLast: false });
      } else if ("updateMany" in operation) {
        const filter = operation.updateMany.filter as { room?: string; "message.replyTo.id"?: string; "message.invite.groupId"?: string };
        const update = operation.updateMany.update as Maintenance;
        const apply = (message: T | null) => {
          if (!message || filter.room && message.room !== filter.room) return message;
          const next = structuredClone(message) as T & MaintenanceMessage;
          const hiddenFor = update.$addToSet?.["message.hiddenFor"];
          if (hiddenFor) next.hiddenFor = [...new Set([...(next.hiddenFor ?? []), hiddenFor])];
          if (filter["message.replyTo.id"] && next.replyTo?.id === filter["message.replyTo.id"]) next.replyTo.text = update.$set!["message.replyTo.text"]!;
          if (filter["message.invite.groupId"] && next.kind === "invite" && next.invite?.groupId === filter["message.invite.groupId"] && next.invite.status === "pending") {
            next.text = update.$set!["message.text"]!;
            next.invite.status = update.$set!["message.invite.status"]!;
          }
          return next;
        };
        for (const [id, doc] of documents) documents.set(id, { ...doc, message: apply(doc.message)! });
        for (const summary of plans) {
          summary.last = apply(summary.last);
          if (filter.room === summary.room && update.$addToSet?.["message.hiddenFor"] === summary.viewerId) {
            Object.assign(summary, { count: 0, unreadCount: 0, last: null, lastPosition: -1, maxCreatedAt: 0, needsLast: false });
          }
        }
      }
    }
    for (const summary of plans) rooms.add(summary.room);
    const markers: DirtyRoom[] = [...rooms].map(room => ({ _id: JSON.stringify([room]), room }));
    return { operations, plans, markers };
  }

  writeBatch(operations: readonly AnyBulkWriteOperation<SummarySource<T>>[], writeMessages: () => Promise<unknown>) {
    return this.serial(async () => {
      this.prepared ??= await this.prepare(operations);
      const { plans, markers } = this.prepared;
      if (this.prepared.operations !== operations) throw new Error("Retry the unfinished message batch first");
      // Durable marker precedes message writes. Keep the same absolute summary plan on retry.
      if (markers.length) await this.dirty.bulkWrite(markers.map(marker => ({ replaceOne: { filter: { _id: marker._id }, replacement: marker, upsert: true } })), { ordered: true });
      if (!this.prepared.messagesWritten) {
        await writeMessages();
        this.prepared.messagesWritten = true;
      }
      for (const summary of plans) if (summary.needsLast) {
        const last = await this.messages().findOne({ room: summary.room, "message.hiddenFor": { $ne: summary.viewerId }, "message.kind": { $ne: "system" } } as Filter<SummarySource<T>>, { sort: { position: -1 } });
        summary.last = last?.message ?? null;
        summary.lastPosition = last?.position ?? -1;
      }
      if (plans.length) await this.saved.bulkWrite(plans.map(plan => {
        const summary = { ...plan };
        delete summary.needsLast;
        return { replaceOne: { filter: { _id: summary._id }, replacement: summary, upsert: true } };
      }), { ordered: true });
      await this.dirty.deleteMany({ _id: { $in: markers.map(marker => marker._id) } });
      this.prepared = undefined;
    });
  }
}
