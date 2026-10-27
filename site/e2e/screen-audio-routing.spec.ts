import { test, expect } from "@playwright/test";
import { build } from "esbuild";

test.use({ channel: "msedge", launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] } });
let bundle: string;
test.beforeAll(async () => {
  const result = await build({ stdin: { resolveDir: process.cwd(), contents: `
    import * as media from './src/lib/webrtcMedia';
    import { registerScreenAudio, setScreenAudioVolume, unregisterScreenAudio } from './src/lib/screenAudio';
    export async function run(withMic) {
      const a = new RTCPeerConnection();
      const b = new RTCPeerConnection();
      const context = new AudioContext();
      await context.resume();
      const oscillator = context.createOscillator();
      oscillator.frequency.value = 440;
      const rightOscillator = context.createOscillator();
      rightOscillator.frequency.value = 880;
      const merger = context.createChannelMerger(2);
      const destination = context.createMediaStreamDestination();
      oscillator.connect(merger, 0, 0); rightOscillator.connect(merger, 0, 1);
      merger.connect(destination); oscillator.start(); rightOscillator.start();
      const source = destination.stream.getAudioTracks()[0];
      const tracks = [];
      let screenPlayer;
      a.onicecandidate = e => { if (e.candidate) void b.addIceCandidate(e.candidate).catch(() => {}); };
      b.onicecandidate = e => { if (e.candidate) void a.addIceCandidate(e.candidate).catch(() => {}); };
      const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
      const wait = async fn => { for (let i=0; i<200; i++) { if (await fn()) return; await sleep(25); } throw new Error('media timeout'); };
      const negotiate = async () => {
        const offer = await a.createOffer();
        await media.setLocalDescriptionTuned(a, offer);
        await media.setRemoteDescriptionWithAudioRouting(b, media.withScreenAudioRouting(a, offer));
        const answer = await b.createAnswer();
        await media.setLocalDescriptionTuned(b, answer);
        const screenMids = media.localScreenAudioMids(a);
        for (const section of b.localDescription.sdp.split(/\\r?\\n(?=m=)/)) {
          const mid = /^a=mid:([^\\r\\n]+)/m.exec(section)?.[1];
          if (screenMids.has(mid) && (!section.includes('stereo=1') || !section.includes('maxaveragebitrate=192000'))) {
            throw new Error('receiver answered screen audio with speech settings');
          }
        }
        await media.setRemoteDescriptionWithAudioRouting(a, media.withScreenAudioRouting(b, answer));
        await wait(() => a.signalingState === 'stable' && b.signalingState === 'stable');
      };
      const screenBytes = async () => {
        const ids = media.remoteScreenAudioTrackIds(b);
        const receiver = b.getReceivers().find(r => ids.has(r.track.id));
        if (!receiver) return 0;
        const stats = await receiver.getStats();
        let bytes = 0; stats.forEach(s => { if (s.type === 'inbound-rtp') bytes += s.bytesReceived || 0; });
        return bytes;
      };
      try {
        if (withMic) {
          const mic = source.clone(); mic.enabled = false; tracks.push(mic);
          a.addTrack(mic, new MediaStream([mic]));
        }
        // A vacant video sender must never be mistaken for an audio sender.
        const video = a.addTransceiver('video', { direction: 'recvonly' });
        await negotiate();
        let originalSender;
        const snapshots = [];
        for (let cycle=0; cycle<4; cycle++) {
          const screen = source.clone(); tracks.push(screen);
          const sender = await media.attachLocalScreenAudioTrack(a, screen, new MediaStream([screen]));
          originalSender ||= sender;
          await negotiate();
          await media.applyAudioSenders([a]);
          await wait(() => b.getReceivers().some(r => media.remoteScreenAudioTrackIds(b)?.has(r.track.id)));
          const previous = await screenBytes();
          await wait(async () => await screenBytes() > previous);
          const remote = b.getReceivers().map(r => r.track).filter(t => t.kind === 'audio');
          const split = media.splitCallAudioTracks(remote, new Set(), media.remoteScreenAudioTrackIds(b));
          screenPlayer ||= document.body.appendChild(document.createElement('audio'));
          screenPlayer.srcObject = new MediaStream(split.screen);
          await screenPlayer.play();
          // Check decoded channel separation, not just SDP declarations.
          const input = context.createMediaStreamSource(new MediaStream(split.screen));
          const splitter = context.createChannelSplitter(2);
          const analysers = [context.createAnalyser(), context.createAnalyser()];
          const silent = context.createGain(); silent.gain.value = 0;
          input.connect(splitter); silent.connect(context.destination);
          analysers.forEach((analyser, channel) => {
            analyser.fftSize = 4096;
            splitter.connect(analyser, channel); analyser.connect(silent);
          });
          const energy = (analyser, frequency) => {
            const values = new Float32Array(analyser.frequencyBinCount);
            analyser.getFloatFrequencyData(values);
            const bin = Math.round(frequency * analyser.fftSize / context.sampleRate);
            return Math.max(...values.slice(bin - 2, bin + 3));
          };
          try {
            await wait(() => energy(analysers[0], 440) > energy(analysers[0], 880) + 15 &&
              energy(analysers[1], 880) > energy(analysers[1], 440) + 15);
          } catch {
            throw new Error(JSON.stringify({ energy: analysers.map(item => [energy(item, 440), energy(item, 880)]),
              source: source.getSettings(), remote: split.screen[0].getSettings(),
              contextState: context.state }));
          }
          input.disconnect(); splitter.disconnect(); analysers.forEach(item => item.disconnect()); silent.disconnect();
          registerScreenAudio(screenPlayer, 'peer');
          setScreenAudioVolume(0.25, 'peer');
          snapshots.push({ sameSender: sender === originalSender, audioSections: (a.localDescription.sdp.match(/^m=audio /gm) || []).length,
            voice: split.voice.length, screen: split.screen.length, hint: split.screen[0]?.contentHint,
            volume: screenPlayer.volume, noVideoTrack: video.sender.track === null,
            stereo: a.localDescription.sdp.includes('maxaveragebitrate=192000'),
            audioCap: sender.getParameters().encodings[0].maxBitrate,
            audioPriority: sender.getParameters().encodings[0].priority });
          if (!withMic && cycle === 3) {
            const mic = source.clone(); tracks.push(mic);
            await media.replaceAudioSenders([a], new MediaStream([mic, screen]), mic);
            if (sender.track !== screen) throw new Error('microphone replaced screen audio');
            await negotiate();
            const routed = media.splitCallAudioTracks(b.getReceivers().map(r => r.track).filter(t => t.kind === 'audio'),
              new Set(), media.remoteScreenAudioTrackIds(b));
            if (routed.voice.length !== 1 || routed.screen.length !== 1) throw new Error('new mic routing failed');
          }
          await media.detachLocalScreenAudioTrack(a, screen); screen.stop();
          await negotiate();
          const stoppedSplit = media.splitCallAudioTracks(remote, new Set(), media.remoteScreenAudioTrackIds(b));
          if (stoppedSplit.screen.length) throw new Error('stopped share still routed to screen');
        }
        return snapshots;
      } finally {
        if (screenPlayer) { unregisterScreenAudio(screenPlayer); screenPlayer.srcObject = null; screenPlayer.remove(); }
        a.close(); b.close(); tracks.forEach(t => t.stop()); source.stop(); oscillator.stop(); rightOscillator.stop(); await context.close();
      }
    }
  ` }, bundle: true, write: false, platform: "browser", format: "iife", globalName: "audioTest" });
  bundle = result.outputFiles[0].text;
});

for (const withMic of [false, true]) {
  test(`screen audio routes separately and restarts without extra senders (${withMic ? "muted mic" : "no mic"})`, async ({ page }) => {
    await page.route("**/audio-routing-harness", route => route.fulfill({ contentType: "text/html", body: "<body><title>Audio routing regression</title></body>" }));
    await page.goto("/audio-routing-harness");
    await page.addScriptTag({ content: bundle });
    const snapshots = await page.evaluate(async (mic) => {
      const harness = window as unknown as { audioTest: { run: (mic: boolean) => Promise<unknown[]> } };
      return harness.audioTest.run(mic);
    }, withMic);
    expect(snapshots).toHaveLength(4);
    for (const snapshot of snapshots) expect(snapshot).toMatchObject({ sameSender: true,
      audioSections: withMic ? 2 : 1, voice: withMic ? 1 : 0, screen: 1,
      hint: "", volume: 0.25, noVideoTrack: true, stereo: true, audioCap: 192000, audioPriority: "high" });
  });
}
