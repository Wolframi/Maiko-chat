import assert from "node:assert/strict";
import { test } from "node:test";
import { configureRingtoneAccount } from "../src/lib/ringtoneAccount";
import { loadRingtoneAudio, ringtoneBlob } from "../src/lib/ringtonePlayback";

const url = "/api/ringtones/audio?u=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DI48Yz36NoC8&v=4";

test("audio uses a session header, coalesces downloads and isolates the cache by session", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (input: string, init: RequestInit) => {
    calls++;
    assert.equal(input, url);
    assert.equal(init.cache, "no-store");
    assert.equal((init.headers as Record<string, string>)["x-pulse-token"], calls === 1 ? "first-token" : "second-token");
    return new Response(new Blob(["audio"], { type: "audio/mpeg" }));
  });
  t.after(() => configureRingtoneAccount(null));
  configureRingtoneAccount({ userId: "first", token: "first-token" });
  const [first, duplicate] = await Promise.all([ringtoneBlob(url), ringtoneBlob(url)]);
  assert.equal(first, duplicate);
  assert.equal(await ringtoneBlob(url), first);
  assert.equal(calls, 1);
  configureRingtoneAccount({ userId: "second", token: "second-token" });
  assert.notEqual(await ringtoneBlob(url), first);
  assert.equal(calls, 2);
  configureRingtoneAccount(null);
  await assert.rejects(ringtoneBlob(url), /войдите/);
  await assert.rejects(ringtoneBlob("https://evil.example/audio"), /адрес/);
});

test("cancelling a pending preview never starts audio and each player releases its own Blob URL", async t => {
  configureRingtoneAccount({ userId: "preview", token: "preview-token" });
  t.after(() => configureRingtoneAccount(null));
  let finish!: (response: Response) => void;
  t.mock.method(globalThis, "fetch", () => new Promise<Response>(resolve => { finish = resolve; }));
  const revoked: string[] = [];
  t.mock.method(URL, "createObjectURL", () => "blob:preview");
  t.mock.method(URL, "revokeObjectURL", (value: string) => revoked.push(value));
  const first = { src: "" } as HTMLAudioElement;
  const pending = loadRingtoneAudio(first, url);
  pending.stop();
  finish(new Response(new Blob(["audio"])));
  assert.equal(await pending.ready, false);
  assert.equal(first.src, "");
  assert.deepEqual(revoked, []);
  const second = { src: "" } as HTMLAudioElement;
  const player = loadRingtoneAudio(second, url);
  assert.equal(await player.ready, true);
  assert.equal(second.src, "blob:preview");
  player.stop();
  assert.deepEqual(revoked, ["blob:preview"]);
});
