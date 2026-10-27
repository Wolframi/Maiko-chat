import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { Innertube, YTNodes } from "youtubei.js";
import { downloadYoutubeRingtone, normalizeRingtoneQuery, searchYoutubeRingtones, youtubeVideoId } from "../src/server/youtubeRingtones";

test("YouTube ringtone URLs accept video IDs without allowing arbitrary hosts", () => {
  const id = "I48Yz36NoC8";
  assert.equal(youtubeVideoId(`https://www.youtube.com/watch?v=${id}`), id);
  for (const url of [
    `http://www.youtube.com/watch?v=${id}`,
    `https://youtube.com.attacker.test/watch?v=${id}`,
    `https://youtube.com@127.0.0.1/watch?v=${id}`,
    `https://user:pass@youtube.com/watch?v=${id}`,
    `https://youtube.com:8443/watch?v=${id}`,
    `https://youtube.com/redirect?v=${id}`,
    "https://youtube.com/watch?v=../../file",
    "https://youtube.com/watch?v=short",
  ]) assert.equal(youtubeVideoId(url), null, url);
  assert.equal(normalizeRingtoneQuery("  Daft   Punk  "), "Daft Punk");
  assert.equal(normalizeRingtoneQuery("a".repeat(200)).length, 120);
});

test("catalog pagination, failed-request recovery and audio bounds work without external services", async (t) => {
  function video(id: string, seconds: number) {
    return new YTNodes.Video({
      videoId: id, title: { simpleText: "Test track" },
      lengthText: { simpleText: `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}` },
      thumbnailOverlays: [{ thumbnailOverlayTimeStatusRenderer: { style: "DEFAULT", text: { simpleText: "0:30" } } }],
    });
  }
  let requests = 0;
  let continuations = 0;
  let failSearch = false;
  let duration = 30;
  let payload = new Uint8Array([1, 2, 3]);
  let rejectClients: string[] = [];
  const audioClients: string[] = [];
  const last = { results: [video("ng_d4wnr2pI", 30)], has_continuation: false };
  const first = {
    results: [video("I48Yz36NoC8", 30), video("I48Yz36NoC8", 30), video("ng_d4wnr2pI", 601)],
    has_continuation: true,
    getContinuation: async () => { continuations++; return last; },
  };
  const create = mock.method(Innertube, "create", async () => ({
    search: async (_query: string, options: object) => {
      requests++;
      assert.deepEqual(options, { type: "video" });
      if (failSearch) { failSearch = false; throw new Error("temporary failure"); }
      return first;
    },
    getBasicInfo: async (id: string, options: { client: string }) => {
      assert.equal(id, "I48Yz36NoC8");
      audioClients.push(options.client);
      return {
        basic_info: { duration },
        download: async (options: object) => {
          assert.deepEqual(options, { type: "audio", quality: "bestefficiency", format: "any" });
          if (rejectClients.includes(audioClients.at(-1)!)) {
            let reads = 0;
            return new ReadableStream({
              pull(controller) {
                if (reads++ === 0) controller.enqueue(new Uint8Array([99]));
                else controller.error(Object.assign(new Error("The server responded with a non 2xx status code"), {
                  info: { error_type: "FETCH_FAILED", response: { status: 403 } },
                }));
              },
            });
          }
          return new ReadableStream({ start(controller) { controller.enqueue(payload); controller.close(); } });
        },
      };
    },
  }) as unknown as Innertube);
  t.after(() => create.mock.restore());
  assert.deepEqual(await searchYoutubeRingtones(1, "   "), { items: [], pages: 1 });
  assert.deepEqual(await searchYoutubeRingtones(1, "a"), { items: [], pages: 1 });
  assert.equal(create.mock.callCount(), 0);
  assert.equal(requests, 0);
  const page1 = await searchYoutubeRingtones(1, "fixture query");
  assert.equal(page1.items.length, 1);
  assert.equal(page1.items[0].id, "youtube:I48Yz36NoC8");
  assert.equal(new URL(page1.items[0].url, "https://localhost").searchParams.get("u"), "https://www.youtube.com/watch?v=I48Yz36NoC8");
  assert.equal(page1.pages, 2);
  const page2 = await searchYoutubeRingtones(2, "fixture query");
  assert.equal(page2.items[0].id, "youtube:ng_d4wnr2pI");
  assert.equal(page2.pages, 2);
  await searchYoutubeRingtones(2, "fixture query");
  assert.equal(requests, 1);
  assert.equal(continuations, 1);
  failSearch = true;
  await assert.rejects(searchYoutubeRingtones(1, "retry query"), /temporary failure/);
  assert.equal((await searchYoutubeRingtones(1, "retry query")).items.length, 1);

  const url = "https://www.youtube.com/watch?v=I48Yz36NoC8";
  assert.deepEqual(await downloadYoutubeRingtone(url), Buffer.from([1, 2, 3]));
  assert.deepEqual(audioClients.splice(0), ["VISIONOS"]);
  rejectClients = ["VISIONOS"];
  assert.deepEqual(await downloadYoutubeRingtone(url), Buffer.from([1, 2, 3]));
  assert.deepEqual(audioClients.splice(0), ["VISIONOS", "IOS"]);
  rejectClients = ["VISIONOS", "IOS"];
  await assert.rejects(downloadYoutubeRingtone(url), /YouTube временно не отдаёт/);
  assert.deepEqual(audioClients.splice(0), ["VISIONOS", "IOS"]);
  rejectClients = [];
  duration = 601;
  await assert.rejects(downloadYoutubeRingtone(url), /10 минут/);
  assert.deepEqual(audioClients.splice(0), ["VISIONOS"]);
  duration = 30;
  payload = new Uint8Array(12 * 1024 * 1024 + 1);
  await assert.rejects(downloadYoutubeRingtone(url), /12 МБ/);
  assert.deepEqual(audioClients.splice(0), ["VISIONOS"]);
  payload = new Uint8Array();
  await assert.rejects(downloadYoutubeRingtone(url), /пустое аудио/);
  assert.deepEqual(audioClients.splice(0), ["VISIONOS"]);
});
