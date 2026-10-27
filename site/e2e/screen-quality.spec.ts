import { expect, test } from "@playwright/test";
import { build } from "esbuild";

test.use({ channel: "msedge", launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] } });

test("1440p screen reaches the receiver and restores fps/bitrate after a network downgrade", async ({ page }) => {
  const result = await build({ stdin: { resolveDir: process.cwd(), contents: `
    import * as media from './src/lib/webrtcMedia';
    export async function run() {
      const sender = new RTCPeerConnection();
      const receiver = new RTCPeerConnection();
      const canvas = document.createElement('canvas');
      canvas.width = 2560; canvas.height = 1440;
      const context = canvas.getContext('2d');
      let frame = 0;
      const paint = () => {
        context.fillStyle = '#161820'; context.fillRect(0, 0, canvas.width, canvas.height);
        context.fillStyle = '#ffffff'; context.font = '24px sans-serif';
        context.fillText('Screen quality / 2560 x 1440 / small text', 30, 50);
        context.fillRect(30 + frame++ % 600, 100, 20, 20);
      };
      paint();
      const stream = canvas.captureStream(30);
      const track = stream.getVideoTracks()[0];
      media.prepareScreenTrack(track);
      const video = document.body.appendChild(document.createElement('video'));
      video.muted = true; video.autoplay = true;
      receiver.ontrack = event => { video.srcObject = new MediaStream([event.track]); void video.play(); };
      sender.onicecandidate = event => { if (event.candidate) void receiver.addIceCandidate(event.candidate); };
      receiver.onicecandidate = event => { if (event.candidate) void sender.addIceCandidate(event.candidate); };
      const timer = setInterval(paint, 33);
      const wait = async predicate => {
        for (let i = 0; i < 400; i++) {
          if (await predicate()) return;
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        throw new Error('screen media timeout');
      };
      try {
        const rtpSender = sender.addTrack(track, stream);
        await sender.setLocalDescription(await sender.createOffer());
        await receiver.setRemoteDescription(sender.localDescription);
        await receiver.setLocalDescription(await receiver.createAnswer());
        await sender.setRemoteDescription(receiver.localDescription);
        await wait(() => sender.connectionState === 'connected');
        const updates = [];
        for (const [level, hidden] of [['good', false], ['ok', false], ['good', true]]) {
          const quality = media.videoQualityForCall('screen', level, hidden);
          const applied = await media.applyVideoSenderParams(rtpSender, {
            ...quality, scaleResolutionDownBy: quality.scale, maintainResolution: true,
          });
          const params = rtpSender.getParameters();
          updates.push({ applied, bitrate: params.encodings[0].maxBitrate,
            fps: params.encodings[0].maxFramerate, scale: params.encodings[0].scaleResolutionDownBy,
            priority: params.encodings[0].priority, degradation: params.degradationPreference });
          await wait(() => video.videoWidth === 2560 && video.videoHeight === 1440);
        }
        await wait(async () => {
          const stats = await receiver.getStats();
          return [...stats.values()].some(stat => stat.type === 'inbound-rtp' && stat.framesDecoded > 2);
        });
        return { width: video.videoWidth, height: video.videoHeight, hint: track.contentHint, updates };
      } finally {
        clearInterval(timer); sender.close(); receiver.close(); track.stop(); video.srcObject = null; video.remove();
      }
    }
  ` }, bundle: true, write: false, platform: "browser", format: "iife", globalName: "screenQualityTest" });
  await page.route("**/screen-quality-harness", route => route.fulfill({ contentType: "text/html", body: "<body></body>" }));
  await page.goto("/screen-quality-harness");
  await page.addScriptTag({ content: result.outputFiles[0].text });
  const received = await page.evaluate(async () => {
    const harness = window as unknown as { screenQualityTest: { run(): Promise<unknown> } };
    return harness.screenQualityTest.run();
  });
  expect(received).toEqual({ width: 2560, height: 1440, hint: "detail", updates: [
    { applied: true, bitrate: 8000000, fps: 30, scale: 1, priority: "medium", degradation: "maintain-resolution" },
    { applied: true, bitrate: 3000000, fps: 15, scale: 1, priority: "medium", degradation: "maintain-resolution" },
    { applied: true, bitrate: 8000000, fps: 30, scale: 1, priority: "medium", degradation: "maintain-resolution" },
  ] });
});
