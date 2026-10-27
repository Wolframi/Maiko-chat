import assert from "node:assert/strict";
import { test } from "node:test";
import { MessageTasks } from "../src/server/messageTasks";

test("room mutations wait for earlier reads and writes while another room can proceed", async () => {
  const tasks = new MessageTasks();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const order: string[] = [];
  const first = tasks.run(["a"], async () => { order.push("first"); await gate; order.push("saved"); });
  const next = tasks.run(["a", "a"], async () => { order.push("next"); });
  await tasks.run(["b"], async () => { order.push("other room"); });
  assert.deepEqual(order, ["first", "other room"]);
  release();
  await Promise.all([first, next]);
  assert.deepEqual(order, ["first", "other room", "saved", "next"]);
  await tasks.idle();
});

test("cross-room membership changes wait for active operations and block later work", async () => {
  const tasks = new MessageTasks();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const order: string[] = [];
  const first = tasks.run(["a"], async () => { await gate; order.push("sent"); });
  const deletion = tasks.exclusive(async () => { order.push("deleted"); });
  const later = tasks.run(["b"], async () => { order.push("checked access"); });
  release();
  await Promise.all([first, deletion, later]);
  assert.deepEqual(order, ["sent", "deleted", "checked access"]);
  await assert.rejects(tasks.exclusive(async () => { throw new Error("offline"); }), /offline/);
  await tasks.run(["a"], async () => { order.push("recovered"); });
  await tasks.idle();
  assert.equal(order.at(-1), "recovered");
});

test("shutdown also drains room work queued behind an active membership change", async () => {
  const tasks = new MessageTasks();
  let releaseBarrier!: () => void, releaseRoom!: () => void;
  const barrier = new Promise<void>(resolve => { releaseBarrier = resolve; });
  const room = new Promise<void>(resolve => { releaseRoom = resolve; });
  void tasks.exclusive(async () => { await barrier; });
  let finished = false;
  const idle = tasks.idle().then(() => { finished = true; });
  void tasks.run(["a"], async () => { await room; });
  releaseBarrier();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false);
  releaseRoom();
  await idle;
  assert.equal(finished, true);
});
