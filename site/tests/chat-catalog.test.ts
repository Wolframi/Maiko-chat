import assert from "node:assert/strict";
import { test } from "node:test";
import { createChatCatalogSelector } from "../src/lib/chatCatalog";
import type { ChatInfo } from "../src/lib/types";

const group: ChatInfo = { id: "group", type: "group", title: "Group", topic: "Topic", online: 1,
  messages: 1, members: 2, unreadCount: 0, pinned: false, lastMessage: null, createdAt: 1,
  memberIds: ["a", "b"], textChannels: [{ id: "text", title: "Text", unreadCount: 0 }] };

test("shell catalog ignores message summaries and voice activity but updates routing and membership", () => {
  const select = createChatCatalogSelector();
  const initial = select([group]);
  const activity: ChatInfo = { ...group, messages: 2, unreadCount: 1, online: 2,
    memberIds: [...group.memberIds!], textChannels: group.textChannels!.map(channel => ({ ...channel })),
    voiceChannels: [{ id: "voice", title: "Voice", users: [{ userId: "a", name: "A", speaking: true, muted: false, deafened: false }] }] };
  assert.equal(select([activity]), initial);
  const renamed = select([{ ...activity, title: "Renamed" }]);
  assert.notEqual(renamed, initial);
  assert.equal(renamed[0].title, "Renamed");
  assert.equal(renamed[0].memberIds, initial[0].memberIds);
  assert.equal(renamed[0].textChannels, initial[0].textChannels);
  const joined = select([{ ...activity, title: "Renamed", memberIds: ["a", "b", "c"], members: 3 }]);
  assert.deepEqual(joined[0].memberIds, ["a", "b", "c"]);
  const channel = select([{ ...group, textChannels: [{ ...group.textChannels![0], title: "Renamed text" }] }]);
  assert.equal(channel[0].textChannels?.[0].title, "Renamed text");
  assert.deepEqual(select([]), []);
  assert.notEqual(select([group])[0], initial[0]);
});

test("catalog instances do not share data and preserve chat order", () => {
  const select = createChatCatalogSelector(), other = createChatCatalogSelector();
  const dm: ChatInfo = { ...group, id: "dm", type: "dm", peerId: "b" };
  const initial = select([group, dm]);
  assert.notEqual(other([group])[0], initial[0]);
  const reordered = select([dm, group]);
  assert.equal(reordered[0], initial[1]);
  assert.equal(reordered[1], initial[0]);
});
