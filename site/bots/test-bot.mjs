#!/usr/bin/env node
/**
 * Тестовый бот Майко — демонстрирует всё, что умеет Bot API:
 * команды с описаниями, инлайн-кнопки (callback и ссылка), правку сообщений,
 * файлы, сгенерированную картинку, аватар, описание, историю, typing,
 * голосовые каналы, музыку и видео прямым потоком (ffmpeg → LiveKit).
 *
 *   node site/bots/test-bot.mjs --token maiko_bot_...
 *   MAIKO_URL=http://127.0.0.1:3000 MAIKO_BOT_TOKEN=... node site/bots/test-bot.mjs
 *
 * Список команд подхватывается автокомплитом в поле ввода: начните с «/».
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { createBot } from "./maiko-bot.mjs";

const args = process.argv.slice(2);
function arg(name) {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

const BOT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_VIDEO_FILE = path.join(
  BOT_DIR,
  "Music BANANA! (Minions) _ Minion song.mp4",
);
const DEFAULT_AUDIO_FILE = path.join(BOT_DIR, "ЛИТВИНЕНКО - Оп, мусорок.mp3");
const VIDEO_FILE =
  arg("video-file") || process.env.TEST_BOT_VIDEO || DEFAULT_VIDEO_FILE;
const AUDIO_FILE =
  arg("audio-file") || process.env.TEST_BOT_AUDIO || DEFAULT_AUDIO_FILE;
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const CHANNEL = arg("channel") || process.env.TEST_BOT_CHANNEL || "";

const token = arg("token") || process.env.MAIKO_BOT_TOKEN;
const url = arg("url") || process.env.MAIKO_URL || "http://127.0.0.1:3000";
const checkMediaOnly = args.includes("--check-media");
if (!token && !checkMediaOnly) {
  console.error("Нужен токен: node site/bots/test-bot.mjs --token maiko_bot_...");
  console.error("Создать бота: npm run bots:add -- --name \"Тестовый бот\"");
  process.exit(1);
}

const bot = checkMediaOnly
  ? null
  : createBot({
      token: token || `maiko_bot_${"0".repeat(48)}`,
      url,
    });

const DEFAULT_COMMANDS = [
  { command: "start", description: "Приветствие и меню" },
  { command: "join", description: "Войти в группу по коду приглашения" },
  { command: "menu", description: "Меню на кнопках" },
  { command: "help", description: "Все команды бота" },
  { command: "buttons", description: "Демо инлайн-кнопок" },
  { command: "edit", description: "Бот правит своё сообщение" },
  { command: "image", description: "Прислать сгенерированную картинку" },
  { command: "file", description: "Прислать текстовый файл" },
  { command: "avatar", description: "Обновить аватар бота" },
  { command: "commands", description: "Сократить список команд" },
  { command: "echo", description: "Повторить текст: /echo привет" },
  { command: "roll", description: "Случайное число: /roll 20" },
  { command: "time", description: "Время сервера" },
  { command: "whoami", description: "Профиль бота и чат" },
  { command: "history", description: "Последние сообщения чата" },
  { command: "table", description: "Таблицы в сообщении (сворачиваемые)" },
  { command: "voice", description: "Голосовые каналы и кто в них" },
  { command: "voice_join", description: "Войти в первый голосовой канал" },
  { command: "voice_leave", description: "Выйти из голосового канала" },
  { command: "voice_msg", description: "Голосовое сообщение от бота" },
  { command: "audio", description: "Играть музыку в голосовом канале" },
  { command: "video", description: "Включить видео (демонстрация) со звуком" },
  { command: "media_stop", description: "Остановить видео/музыку" },
];

function describe(name) {
  return DEFAULT_COMMANDS.find((item) => item.command === name)?.description || "";
}

/* ── Генерация PNG без зависимостей ───────────────────────────────────── */

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const kind = Buffer.from(type, "ascii");
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([kind, data])));
  return Buffer.concat([length, kind, data, checksum]);
}

/** Minimal RGB PNG encoder — enough to demo bot images and avatars. */
function createPng(width, height, paint) {
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    raw[row] = 0; // filter: none
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = paint(x, y, width, height);
      const offset = row + 1 + x * 3;
      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

const clamp = (value) => Math.max(0, Math.min(255, Math.round(value)));

function avatarPng(seed = 0) {
  return createPng(256, 256, (x, y, width, height) => {
    const t = (x + y) / (width + height);
    const dx = x - width / 2;
    const dy = y - height / 2;
    const distance = Math.sqrt(dx * dx + dy * dy) / (width / 2);
    if (distance < 0.34) {
      // «глаз» в центре
      return [clamp(235 + seed), clamp(240), clamp(255)];
    }
    if (distance < 0.44) {
      return [clamp(150 + seed), clamp(110), clamp(220)];
    }
    return [clamp(45 + 90 * t), clamp(70 + 40 * (1 - t)), clamp(140 + 80 * t)];
  });
}

function cardPng() {
  return createPng(640, 360, (x, y, width, height) => {
    const t = (x + y) / (width + height);
    const grid = (x % 40 < 2 || y % 40 < 2) ? 26 : 0;
    const bar = y > height - 70 && y < height - 40 && x > 40 && x < width - 40
      ? 70
      : 0;
    return [
      clamp(30 + 70 * t + grid + bar * 0.2),
      clamp(40 + 50 * (1 - t) + grid + bar * 0.4),
      clamp(90 + 110 * t + grid + bar),
    ];
  });
}

/* ── Мелкие помощники ─────────────────────────────────────────────────── */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Короткая WAV-запись для демонстрации голосового сообщения. */
function createWavVoice(seconds = 1.2, frequency = 440) {
  const sampleRate = 24000;
  const count = Math.floor(sampleRate * seconds);
  const buffer = Buffer.alloc(44 + count * 2);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + count * 2, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(count * 2, 40);
  for (let index = 0; index < count; index += 1) {
    const time = index / sampleRate;
    const envelope = Math.min(1, time * 10, (seconds - time) * 10);
    const sample = Math.sin(2 * Math.PI * frequency * time) * 0.3 * envelope;
    buffer.writeInt16LE(Math.round(sample * 32767), 44 + index * 2);
  }
  return buffer;
}

/* ── Медиа в голосовом канале: прямой ffmpeg-поток → LiveKit ──────────── */

const VIDEO_WIDTH = 960;
const VIDEO_HEIGHT = 540;
const VIDEO_FPS = 30;
const AUDIO_RATE = 48000;
const AUDIO_CHANNELS = 2;
const AUDIO_FRAME_SAMPLES = 960; // 20 мс
const AUDIO_FRAME_BYTES = AUDIO_FRAME_SAMPLES * AUDIO_CHANNELS * 2;

let rtc = null;
let voiceRoom = null;
let voiceChannelId = null;
let voiceChannelMeta = null;
let playback = null;

async function loadRtc() {
  if (rtc) return rtc;
  try {
    rtc = await import("@livekit/rtc-node");
  } catch {
    throw new Error(
      "Нужен пакет @livekit/rtc-node: npm install @livekit/rtc-node",
    );
  }
  return rtc;
}

function ffmpegAvailable() {
  try {
    return spawnSync(FFMPEG, ["-version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

function runFfmpeg(ffmpegArgs) {
  const result = spawnSync(
    FFMPEG,
    ["-y", "-hide_banner", "-loglevel", "error", ...ffmpegArgs],
    { stdio: "ignore" },
  );
  return result.status === 0;
}

/** Есть ли в файле звуковая дорожка (быстрая проверка без вывода картинок). */
function hasAudioStream(file) {
  return runFfmpeg([
    "-i", file,
    "-map", "0:a:0",
    "-t", "0.05",
    "-f", "null",
    "-",
  ]);
}

/** ffmpeg с stdout-пайпом: кадры/сэмплы идут напрямую в LiveKit. */
function spawnFfmpeg(ffmpegArgs) {
  const child = spawn(
    FFMPEG,
    ["-hide_banner", "-loglevel", "error", ...ffmpegArgs],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stderrText = "";
  child.stderr?.on("data", (chunk) => {
    child.stderrText = (child.stderrText + chunk.toString()).slice(-2000);
  });
  child.on("error", (error) => {
    child.spawnError = error;
    console.warn("[test-bot] ffmpeg:", error?.message || error);
  });
  return child;
}

/** Читает из потока ровно frameSize байт за раз без промежуточных файлов. */
async function* readFrames(stream, frameSize) {
  let pending = null;
  for await (const chunk of stream) {
    let offset = 0;
    if (pending) {
      const need = frameSize - pending.length;
      if (chunk.length < need) {
        pending = Buffer.concat([pending, chunk]);
        continue;
      }
      yield Buffer.concat([pending, chunk.subarray(0, need)]);
      pending = null;
      offset = need;
    }
    while (offset + frameSize <= chunk.length) {
      yield chunk.subarray(offset, offset + frameSize);
      offset += frameSize;
    }
    if (offset < chunk.length) {
      pending = Buffer.from(chunk.subarray(offset));
    }
  }
}

/** Встроенный тон на случай, если медиафайла нет под рукой. */
function tonePcm(seconds = 4) {
  const frames = AUDIO_RATE * seconds;
  const pcm = new Int16Array(frames * AUDIO_CHANNELS);
  const notes = [440, 554, 659, 554];
  for (let index = 0; index < frames; index += 1) {
    const time = index / AUDIO_RATE;
    const note = notes[Math.floor(time * 2) % notes.length];
    const envelope = Math.min(1, (time % 0.5) * 8, (0.5 - (time % 0.5)) * 8);
    const value = Math.round(
      Math.sin(2 * Math.PI * note * time) * 0.22 * envelope * 32767,
    );
    pcm[index * AUDIO_CHANNELS] = value;
    pcm[index * AUDIO_CHANNELS + 1] = value;
  }
  return pcm;
}

/** Простой анимированный кадр для демо-видео без файла. */
function generatedVideoFrame(index) {
  const data = new Uint8Array(VIDEO_WIDTH * VIDEO_HEIGHT * 3);
  const shift = index * 5;
  for (let y = 0; y < VIDEO_HEIGHT; y += 1) {
    const row = y * VIDEO_WIDTH * 3;
    for (let x = 0; x < VIDEO_WIDTH; x += 1) {
      const pixel = row + x * 3;
      data[pixel] = (x + shift) % 256;
      data[pixel + 1] = (y * 2 + index * 3) % 256;
      data[pixel + 2] = 110 + (((x + y + shift) >> 3) % 120);
    }
  }
  for (let y = VIDEO_HEIGHT - 120; y < VIDEO_HEIGHT - 60; y += 1) {
    for (let x = 60; x < VIDEO_WIDTH - 60; x += 1) {
      const pixel = (y * VIDEO_WIDTH + x) * 3;
      data[pixel] = 20;
      data[pixel + 1] = 20;
      data[pixel + 2] = 24;
    }
  }
  return data;
}

function prepareAudio() {
  if (existsSync(AUDIO_FILE) && ffmpegAvailable()) {
    return {
      file: AUDIO_FILE,
      label: path.basename(AUDIO_FILE),
      generated: false,
    };
  }
  return {
    file: null,
    label: "встроенный тон (файл не найден или ffmpeg недоступен)",
    generated: true,
  };
}

function prepareVideo() {
  if (existsSync(VIDEO_FILE) && ffmpegAvailable()) {
    return {
      file: VIDEO_FILE,
      label: path.basename(VIDEO_FILE),
      generated: false,
      hasAudio: hasAudioStream(VIDEO_FILE),
    };
  }
  return {
    file: null,
    label: "встроенный демо-ролик (файл не найден)",
    generated: true,
    hasAudio: true,
  };
}

/** Голосовой канал + подключение к LiveKit; бот один канал за раз. */
async function ensureVoice() {
  if (voiceRoom && voiceChannelId && voiceChannelMeta) {
    return {
      room: voiceRoom,
      channelId: voiceChannelId,
      channel: voiceChannelMeta,
    };
  }
  const channels = await bot.voiceChannels();
  if (!channels.length) {
    throw new Error("Нет голосовых каналов — добавьте бота в группу");
  }
  const channel =
    (CHANNEL &&
      channels.find(
        (item) =>
          item.id === CHANNEL ||
          String(item.title || "")
            .toLowerCase()
            .includes(CHANNEL.toLowerCase()),
      )) ||
    channels[0];
  const joined = await bot.joinVoice(channel.id);
  if (!joined.livekit?.token) {
    throw new Error("LiveKit не настроен на сервере — запустите npm run livekit");
  }
  const api = await loadRtc();
  const room = new api.Room();
  await room.connect(joined.livekit.url, joined.livekit.token, {
    autoSubscribe: false,
  });
  voiceRoom = room;
  voiceChannelId = channel.id;
  voiceChannelMeta = channel;
  await bot.voiceMedia({ muted: true, cameraOff: true, sharingScreen: false });
  return { room, channelId: channel.id, channel };
}

/** Опции публикации аудио: для музыки нужен высокий битрейт Opus. */
async function audioPublishOptions(api, source) {
  const options = new api.TrackPublishOptions();
  options.source = source;
  // DTX выключает передачу в паузах — на музыке это даёт рваный,
  // «роботизированный» звук. Для музыки/демонстрации он не нужен.
  options.dtx = false;
  try {
    const { AudioEncoding } = await import("@livekit/rtc-ffi-bindings");
    options.audioEncoding = new AudioEncoding({ maxBitrate: 160000 });
  } catch {
    /* оставляем дефолт, если пакет недоступен */
  }
  return options;
}

async function playTone(api, source, pcm, signal) {
  const frameSamples = AUDIO_FRAME_SAMPLES * AUDIO_CHANNELS;
  while (!signal.aborted) {
    for (let offset = 0; offset + frameSamples <= pcm.length; offset += frameSamples) {
      if (signal.aborted) return;
      const chunk = pcm.subarray(offset, offset + frameSamples);
      await source.captureFrame(
        new api.AudioFrame(
          chunk,
          AUDIO_RATE,
          AUDIO_CHANNELS,
          AUDIO_FRAME_SAMPLES,
        ),
      );
      await sleep(20);
    }
  }
}

/** mp3/звук видео → PCM-поток → LiveKit AudioSource. */
async function playAudioFile(api, source, file, signal) {
  while (!signal.aborted) {
    const child = spawnFfmpeg([
      "-re",
      "-i", file,
      "-vn",
      "-af", "volume=0.85",
      "-f", "s16le",
      "-acodec", "pcm_s16le",
      "-ac", String(AUDIO_CHANNELS),
      "-ar", String(AUDIO_RATE),
      "pipe:1",
    ]);
    playback?.processes.add(child);
    try {
      if (!child.stdout) throw new Error("ffmpeg не отдал аудиопоток");
      for await (const chunk of readFrames(child.stdout, AUDIO_FRAME_BYTES)) {
        if (signal.aborted) return;
        const aligned =
          chunk.byteOffset % 2 === 0 ? chunk : Buffer.from(chunk);
        const view = new Int16Array(
          aligned.buffer,
          aligned.byteOffset,
          AUDIO_FRAME_SAMPLES * AUDIO_CHANNELS,
        );
        // Копия на каждый кадр: буфер пайпа не должен переиспользоваться,
        // пока LiveKit ещё держит ссылку на сэмплы.
        const pcm = Int16Array.from(view);
        await source.captureFrame(
          new api.AudioFrame(
            pcm,
            AUDIO_RATE,
            AUDIO_CHANNELS,
            AUDIO_FRAME_SAMPLES,
          ),
        );
      }
    } catch (error) {
      if (!signal.aborted) {
        console.warn("[test-bot] аудио-поток:", error?.message || error);
      }
      return;
    } finally {
      child.kill("SIGKILL");
      playback?.processes.delete(child);
    }
  }
}

/** mp4 → rawvideo RGB24 в pipe → VideoFrame без JPEG и без кэша картинок. */
async function playVideoFile(api, source, file, signal) {
  const frameSize = VIDEO_WIDTH * VIDEO_HEIGHT * 3;
  const filter =
    `fps=${VIDEO_FPS},scale=${VIDEO_WIDTH}:${VIDEO_HEIGHT}:` +
    `force_original_aspect_ratio=decrease,` +
    `pad=${VIDEO_WIDTH}:${VIDEO_HEIGHT}:(ow-iw)/2:(oh-ih)/2`;
  while (!signal.aborted) {
    const child = spawnFfmpeg([
      "-re",
      "-i", file,
      "-an",
      "-vf", filter,
      "-pix_fmt", "rgb24",
      "-f", "rawvideo",
      "pipe:1",
    ]);
    playback?.processes.add(child);
    try {
      if (!child.stdout) throw new Error("ffmpeg не отдал видеопоток");
      for await (const frame of readFrames(child.stdout, frameSize)) {
        if (signal.aborted) return;
        source.captureFrame(
          new api.VideoFrame(
            frame,
            VIDEO_WIDTH,
            VIDEO_HEIGHT,
            api.VideoBufferType.RGB24,
          ),
          BigInt(Math.round(performance.now() * 1000)),
        );
      }
    } catch (error) {
      if (!signal.aborted) {
        console.warn("[test-bot] видео-поток:", error?.message || error);
      }
      return;
    } finally {
      child.kill("SIGKILL");
      playback?.processes.delete(child);
    }
  }
}

async function playGeneratedVideo(api, source, signal) {
  let index = 0;
  while (!signal.aborted) {
    source.captureFrame(
      new api.VideoFrame(
        generatedVideoFrame(index),
        VIDEO_WIDTH,
        VIDEO_HEIGHT,
        api.VideoBufferType.RGB24,
      ),
      BigInt(Math.round(performance.now() * 1000)),
    );
    index += 1;
    await sleep(1000 / VIDEO_FPS);
  }
}

function watchLoop(promise, label) {
  promise.catch((error) => {
    console.warn(`[test-bot] ${label}:`, error?.message || error);
  });
}

async function startAudio() {
  if (playback) await stopPlayback();
  const { room, channel } = await ensureVoice();
  const api = await loadRtc();
  const media = prepareAudio();

  const audioSource = new api.AudioSource(
    AUDIO_RATE,
    AUDIO_CHANNELS,
    1000,
  );
  const track = api.LocalAudioTrack.createAudioTrack("bot-music", audioSource);
  const options = await audioPublishOptions(
    api,
    api.TrackSource.SOURCE_MICROPHONE,
  );
  await room.localParticipant.publishTrack(track, options);

  const controller = new AbortController();
  playback = {
    kind: "audio",
    controller,
    tracks: [track],
    loops: [],
    processes: new Set(),
    label: media.label,
  };
  if (media.file) {
    watchLoop(
      playAudioFile(api, audioSource, media.file, controller.signal),
      "audio",
    );
  } else {
    watchLoop(
      playTone(api, audioSource, tonePcm(), controller.signal),
      "audio",
    );
  }
  await bot.voiceMedia({ muted: false, cameraOff: true, sharingScreen: false });
  return { channel, label: media.label, generated: media.generated };
}

async function startVideo() {
  if (playback) await stopPlayback();
  const { room, channel } = await ensureVoice();
  const api = await loadRtc();
  const media = prepareVideo();

  const videoSource = new api.VideoSource(VIDEO_WIDTH, VIDEO_HEIGHT);
  const videoTrack = api.LocalVideoTrack.createVideoTrack("screen", videoSource);
  const videoOptions = new api.TrackPublishOptions();
  videoOptions.source = api.TrackSource.SOURCE_SCREENSHARE;
  // Без симулкаста зритель сразу получает полный кадр,
  // а не нижний слой 320×180.
  videoOptions.simulcast = false;
  try {
    const { VideoEncoding } = await import("@livekit/rtc-ffi-bindings");
    videoOptions.videoEncoding = new VideoEncoding({
      maxBitrate: 2_500_000n,
      maxFramerate: VIDEO_FPS,
    });
  } catch {
    /* дефолтный битрейт, если пакет недоступен */
  }
  await room.localParticipant.publishTrack(videoTrack, videoOptions);

  const controller = new AbortController();
  playback = {
    kind: "video",
    controller,
    tracks: [videoTrack],
    loops: [],
    processes: new Set(),
    label: media.label,
  };
  if (media.file) {
    watchLoop(
      playVideoFile(api, videoSource, media.file, controller.signal),
      "video",
    );
  } else {
    watchLoop(
      playGeneratedVideo(api, videoSource, controller.signal),
      "video",
    );
  }

  if (media.hasAudio) {
    const audioSource = new api.AudioSource(
      AUDIO_RATE,
      AUDIO_CHANNELS,
      1000,
    );
    const audioTrack = api.LocalAudioTrack.createAudioTrack(
      "screen-audio",
      audioSource,
    );
    const audioOptions = await audioPublishOptions(
      api,
      api.TrackSource.SOURCE_SCREENSHARE_AUDIO,
    );
    await room.localParticipant.publishTrack(audioTrack, audioOptions);
    playback.tracks.push(audioTrack);
    if (media.file) {
      watchLoop(
        playAudioFile(api, audioSource, media.file, controller.signal),
        "screen-audio",
      );
    } else {
      watchLoop(
        playTone(api, audioSource, tonePcm(), controller.signal),
        "screen-audio",
      );
    }
  }

  await bot.voiceMedia({
    muted: false,
    cameraOff: false,
    sharingScreen: true,
  });
  return {
    channel,
    label: media.label,
    generated: media.generated,
    hasAudio: media.hasAudio,
  };
}

async function stopPlayback({ reset = true } = {}) {
  const current = playback;
  if (!current) {
    if (reset && voiceRoom) {
      try {
        await bot.voiceMedia({
          muted: true,
          cameraOff: true,
          sharingScreen: false,
        });
      } catch {
        /* presence may already be gone */
      }
    }
    return false;
  }
  playback = null;
  current.controller.abort();
  for (const child of [...current.processes]) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already stopped */
    }
  }
  await Promise.allSettled(current.loops);
  if (voiceRoom) {
    for (const track of current.tracks) {
      if (!track.sid) continue;
      try {
        await voiceRoom.localParticipant.unpublishTrack(track.sid, true);
      } catch {
        /* publication may already be gone */
      }
    }
  }
  for (const track of current.tracks) {
    try {
      await track.close();
    } catch {
      /* already closed */
    }
  }
  if (reset && voiceRoom) {
    try {
      await bot.voiceMedia({
        muted: true,
        cameraOff: true,
        sharingScreen: false,
      });
    } catch {
      /* ignore */
    }
  }
  return true;
}

async function leaveVoiceFully() {
  await stopPlayback({ reset: false });
  if (voiceRoom) {
    try {
      await voiceRoom.disconnect();
    } catch {
      /* ignore */
    }
    voiceRoom = null;
  }
  voiceChannelId = null;
  voiceChannelMeta = null;
  try {
    await bot.leaveVoice();
  } catch {
    /* ignore */
  }
}

if (args.includes("--check-media")) {
  try {
    console.log("ffmpeg:", ffmpegAvailable());
    const audio = prepareAudio();
    console.log(
      `audio: ${audio.label}; режим=${audio.generated ? "тон" : "прямой поток"}`,
    );
    const video = prepareVideo();
    console.log(
      `video: ${video.label}; звук=${video.hasAudio}; ` +
        `${VIDEO_WIDTH}x${VIDEO_HEIGHT}@${VIDEO_FPS} (прямой rawvideo-поток)`,
    );
    process.exit(0);
  } catch (error) {
    console.error("media check failed:", error?.message || error);
    process.exit(1);
  }
}

async function typing(ctx, ms = 350) {
  try {
    await ctx.typing();
    await sleep(ms);
  } catch {
    /* индикатор необязателен */
  }
}

function mainKeyboard() {
  return [
    [
      { text: "🎲 Бросок", data: "roll" },
      { text: "🕒 Время", data: "time" },
    ],
    [
      { text: "🖼 Картинка", data: "image" },
      { text: "📎 Файл", data: "file" },
    ],
    [
      { text: "✏️ Правка", data: "edit" },
      { text: "🖼 Аватар", data: "avatar" },
    ],
    [
      { text: "🎬 Видео", data: "video" },
      { text: "🎵 Музыка", data: "audio" },
      { text: "⏹ Стоп", data: "stop" },
    ],
    [
      { text: "ℹ️ О боте", data: "about" },
      { text: "🌐 Пример ссылки", url: "https://example.com/" },
    ],
  ];
}

function backKeyboard() {
  return [
    [
      { text: "🎲 Ещё", data: "roll" },
      { text: "↩️ В меню", data: "menu" },
    ],
  ];
}

function helpText() {
  const list = DEFAULT_COMMANDS.map((item) => `/${item.command} — ${item.description}`).join("\n");
  return `Тестовый бот Майко. Команды:\n${list}\n\nВ группе адресуйте: /help@${bot.me?.username || "bot"}\nНачните ввод с «/» — появится список.`;
}

async function sendImage(ctx) {
  return ctx.sendFile(
    { name: "maiko-test-card.png", type: "image/png", data: cardPng() },
    { caption: "Картинка сгенерирована ботом на лету (PNG без зависимостей)." },
  );
}

async function sendReport(ctx) {
  const body = [
    "Тестовый бот Майко: файл",
    `Создан: ${new Date().toISOString()}`,
    `Чат: ${ctx.chatId}`,
    `Пользователь: ${ctx.from?.name || "—"} (${ctx.from?.id || "—"})`,
    "",
    "Проверяются команды, кнопки, правка, файлы, картинки, аватар и история.",
  ].join("\n");
  return ctx.sendFile(
    { name: `maiko-test-${Date.now()}.txt`, type: "text/plain", data: Buffer.from(body, "utf8") },
    { caption: "Текстовый файл от бота." },
  );
}

let avatarSeed = 0;
async function updateProfileAvatar(ctx) {
  avatarSeed += 40;
  const result = await bot.setProfile({
    description:
      "Тестовый бот Майко: все возможности API — команды, кнопки, правка, файлы, картинки, аватар.",
    avatar: { name: "maiko-test-avatar.png", type: "image/png", data: avatarPng(avatarSeed) },
  });
  if (ctx) {
    await ctx.reply(
      `Аватар и описание обновлены из скрипта.\nАватар: ${result?.avatarUrl ? "да" : "нет"}\nКоманд: ${result?.commands?.length ?? 0}`,
    );
  }
}

/* ── Команды ──────────────────────────────────────────────────────────── */

const INVITE_CODE_RE = /^[A-HJ-NP-Z2-9]{12}$/;

function normalizeInviteCode(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[\s-]/g, "");
}

async function joinGroupByInviteCode(ctx, rawCode) {
  const code = normalizeInviteCode(rawCode);
  if (!INVITE_CODE_RE.test(code)) {
    await ctx.reply(
      "Нужен код приглашения из 12 символов (буквы и цифры).\n" +
        "Откройте группу → «Пригласить» → скопируйте код и пришлите его сюда.",
    );
    return;
  }
  try {
    const result = await bot.joinGroup(code);
    const title = result.chat?.title || "группа";
    await ctx.reply(
      `✅ Я вступил в группу «${title}».\n` +
        "Там уже работают /help, /table, /voice, /video и остальные команды.",
    );
    if (result.chat?.id) {
      await bot
        .sendMessage(
          result.chat.id,
          "Привет! Я тестовый бот Майко. Умею команды, кнопки, таблицы, " +
            "голосовые каналы, музыку и видео. Начните с /help.",
        )
        .catch(() => {});
    }
  } catch (error) {
    await ctx.reply(`Не удалось войти в группу: ${error?.message || error}`);
  }
}

bot.onCommand("start", async (ctx) => {
  await typing(ctx);
  await ctx.reply(
    `Привет, ${ctx.from.name || "друг"}! Я тестовый бот Майко.\n\n` +
      "Внизу — кнопки, а если начать ввод с «/», появится список команд.\n" +
      "Чтобы добавить меня в группу, пришлите код приглашения (12 символов) " +
      "или используйте /join КОД.",
    { buttons: mainKeyboard() },
  );
}, describe("start"));

bot.onCommand("join", async (ctx) => {
  await joinGroupByInviteCode(ctx, ctx.command?.args || "");
}, describe("join"));

bot.onCommand("menu", async (ctx) => {
  await ctx.reply("Что проверим?", { buttons: mainKeyboard() });
}, describe("menu"));

bot.onCommand("help", async (ctx) => {
  await ctx.reply(helpText());
}, describe("help"));

bot.onCommand("buttons", async (ctx) => {
  await ctx.reply("Инлайн-кнопки: callback-кнопки и одна ссылка.", {
    buttons: mainKeyboard(),
  });
}, describe("buttons"));

bot.onCommand("edit", async (ctx) => {
  const messageId = await ctx.reply("Это сообщение изменится через секунду…", {
    buttons: [[{ text: "⏳ Ждём", data: "noop" }]],
  });
  await sleep(1200);
  await bot.editMessage(ctx.chatId, messageId, {
    text: "Сообщение изменено событием bot:edit ✅",
    buttons: [
      [{ text: "✏️ Ещё раз", data: "edit" }],
      [{ text: "↩️ В меню", data: "menu" }],
    ],
  });
}, describe("edit"));

bot.onCommand("image", async (ctx) => {
  await typing(ctx);
  await sendImage(ctx);
}, describe("image"));

bot.onCommand("file", async (ctx) => {
  await typing(ctx);
  await sendReport(ctx);
}, describe("file"));

bot.onCommand("avatar", async (ctx) => {
  await typing(ctx);
  await updateProfileAvatar(ctx);
}, describe("avatar"));

bot.onCommand("commands", async (ctx) => {
  const reduce = ctx.command.args.trim().toLowerCase() !== "full";
  const wanted = new Set(["start", "help", "menu", "commands"]);
  const commands = reduce
    ? DEFAULT_COMMANDS.filter((item) => wanted.has(item.command))
    : DEFAULT_COMMANDS;
  await bot.setCommands(commands);
  await ctx.reply(
    reduce
      ? "Список команд сокращён до 4 — начните ввод с «/».\nВернуть всё: /commands full"
      : "Полный список команд восстановлен.",
  );
}, describe("commands"));

bot.onCommand("echo", async (ctx) => {
  if (!ctx.command.args) {
    await ctx.reply("Напишите так: /echo привет");
    return;
  }
  await ctx.reply(ctx.command.args);
}, describe("echo"));

bot.onCommand("roll", async (ctx) => {
  const raw = Number.parseInt(ctx.command.args, 10);
  const max = Number.isFinite(raw) ? Math.min(Math.max(raw, 2), 1_000_000) : 100;
  const value = 1 + Math.floor(Math.random() * max);
  await ctx.reply(`🎲 ${value} (из ${max})`);
}, describe("roll"));

bot.onCommand("time", async (ctx) => {
  const now = new Date();
  await ctx.reply(
    `Сервер: ${now.toLocaleString("ru-RU", { timeZoneName: "short" })}\nUTC: ${now.toISOString()}`,
  );
}, describe("time"));

bot.onCommand("whoami", async (ctx) => {
  const me = bot.me || {};
  await ctx.reply(
    [
      `Логин: @${me.username}`,
      `Имя: ${me.displayName}`,
      `Описание: ${me.description || "—"}`,
      `Команд: ${me.commands?.length ?? 0}`,
      `Аватар: ${me.avatarUrl ? "есть" : "нет"}`,
      `Чат: ${ctx.chatId} (${ctx.chatType})`,
      `Вы: ${ctx.from.name} (${ctx.from.id})`,
    ].join("\n"),
  );
}, describe("whoami"));

bot.onCommand("history", async (ctx) => {
  const page = await ctx.history();
  const lines = page.messages
    .slice(-5)
    .map((message) => `${message.author}: ${String(message.text || "").slice(0, 60)}`)
    .join("\n");
  await ctx.reply(`Последние сообщения (${page.messages.length}):\n${lines || "пусто"}`);
}, describe("history"));

/* ── Таблицы ──────────────────────────────────────────────────────────── */

bot.onCommand("table", async (ctx) => {
  const small = [
    "| Параметр | Значение |",
    "|---|---|",
    "| Формат | Markdown |",
    "| Сворачивание | больше 5 строк |",
  ].join("\n");
  const big = [
    "| Команда | Описание |",
    "|---|---|",
    ...DEFAULT_COMMANDS.map((item) => `| /${item.command} | ${item.description} |`),
  ].join("\n");
  await ctx.reply(`Маленькая таблица:\n\n${small}\n\nБольшая таблица (сворачивается):\n\n${big}`);
}, describe("table"));

/* ── Голосовые каналы ─────────────────────────────────────────────────── */

bot.onCommand("voice", async (ctx) => {
  const channels = await bot.voiceChannels();
  if (!channels.length) {
    await ctx.reply("Голосовых каналов нет — добавьте бота в группу.");
    return;
  }
  const table = [
    "| Канал | Человек | Состав |",
    "|---|---|---|",
    ...channels.map((channel) => {
      const users = channel.users || [];
      const names = users
        .map((user) => `${user.name}${user.muted ? " (mute)" : ""}`)
        .join(", ")
        .replace(/\|/g, "\\|") || "пусто";
      const title = String(channel.title || "").replace(/\|/g, "\\|");
      return `| ${title} | ${users.length} | ${names} |`;
    }),
  ].join("\n");
  await ctx.reply(`Голосовые каналы:\n\n${table}`);
}, describe("voice"));

bot.onCommand("voice_join", async (ctx) => {
  const channels = await bot.voiceChannels();
  const channel = channels[0];
  if (!channel) {
    await ctx.reply("Нет голосовых каналов — добавьте бота в группу.");
    return;
  }
  const joined = await bot.joinVoice(channel.id);
  const members = joined.members || [];
  await ctx.reply(
    `Вошёл в «${channel.title}».\n` +
      `Сейчас в канале: ${members.length}.\n` +
      `LiveKit: ${joined.livekit ? "токен выдан, можно публиковать аудио/видео" : "не настроен (только присутствие)"}.`,
  );
}, describe("voice_join"));

bot.onCommand("voice_leave", async (ctx) => {
  await leaveVoiceFully();
  await ctx.reply("Вышел из голосового канала.");
}, describe("voice_leave"));

bot.onCommand("voice_msg", async (ctx) => {
  await ctx.sendVoice({
    name: "voice-test.wav",
    type: "audio/wav",
    data: createWavVoice(),
  });
}, describe("voice_msg"));

/* ── Музыка и видео в канале ──────────────────────────────────────────── */

bot.onCommand("audio", async (ctx) => {
  await ctx.reply("🎵 Включаю музыку в голосовом канале…");
  try {
    const info = await startAudio();
    await ctx.reply(
      `🎵 Играю «${info.label}» в «${info.channel?.title || "голосовом канале"}».` +
        (info.generated
          ? "\nФайл не найден — играю встроенный тон."
          : "\nОстановить: /media_stop"),
    );
  } catch (error) {
    await ctx.reply(`Не удалось включить музыку: ${error?.message || error}`);
  }
}, describe("audio"));

bot.onCommand("video", async (ctx) => {
  await ctx.reply("🎬 Запускаю видео прямым потоком (ffmpeg → LiveKit)…");
  try {
    const info = await startVideo();
    await ctx.reply(
      [
        `🎬 Видео «${info.label}» включено в «${info.channel?.title || "голосовом канале"}».`,
        `Поток: ${VIDEO_WIDTH}×${VIDEO_HEIGHT}, ${VIDEO_FPS} fps.`,
        info.hasAudio
          ? "Звук видео публикуется как screen-share audio."
          : "У видео нет звуковой дорожки.",
        info.generated
          ? "Использован встроенный демо-ролик."
          : "Декодирование идёт на лету, без нарезки на картинки.",
        "Остановить: /media_stop",
      ].join("\n"),
    );
  } catch (error) {
    await ctx.reply(`Не удалось включить видео: ${error?.message || error}`);
  }
}, describe("video"));

bot.onCommand("media_stop", async (ctx) => {
  const stopped = await stopPlayback();
  await ctx.reply(stopped ? "⏹ Остановил видео/музыку." : "Сейчас ничего не играет.");
}, describe("media_stop"));

/* ── Кнопки ───────────────────────────────────────────────────────────── */

bot.onButton(async (ctx) => {
  if (ctx.data === "roll") {
    await ctx.edit({
      text: `🎲 Выпало ${1 + Math.floor(Math.random() * 100)} (из 100)`,
      buttons: backKeyboard(),
    });
    return;
  }
  if (ctx.data === "time") {
    const now = new Date();
    await ctx.edit({
      text: `🕒 ${now.toLocaleString("ru-RU", { timeZoneName: "short" })}\nUTC: ${now.toISOString()}`,
      buttons: [[{ text: "↩️ В меню", data: "menu" }]],
    });
    return;
  }
  if (ctx.data === "image") {
    await sendImage(ctx);
    return;
  }
  if (ctx.data === "file") {
    await sendReport(ctx);
    return;
  }
  if (ctx.data === "avatar") {
    await updateProfileAvatar(null);
    await ctx.edit({
      text: "Аватар и описание обновлены. Откройте профиль бота.",
      buttons: [[{ text: "↩️ В меню", data: "menu" }]],
    });
    return;
  }
  if (ctx.data === "edit") {
    await ctx.edit({
      text: `Правка из callback ✅ (${new Date().toLocaleTimeString("ru-RU")})`,
      buttons: [[{ text: "✏️ Ещё", data: "edit" }], [{ text: "↩️ В меню", data: "menu" }]],
    });
    return;
  }
  if (ctx.data === "about") {
    await ctx.edit({
      text:
        "Тестовый бот Майко на JavaScript.\n" +
        "Проверяет: команды с описаниями, автокомплит «/», инлайн-кнопки, " +
        "callback, правку сообщений, файлы, картинки, таблицы, голосовые " +
        "сообщения, голосовые каналы, музыку и видео (демонстрацию со звуком).\n" +
        "Исходник: site/bots/test-bot.mjs",
      buttons: [[{ text: "↩️ В меню", data: "menu" }]],
    });
    return;
  }
  if (ctx.data === "video" || ctx.data === "audio") {
    const isVideo = ctx.data === "video";
    await ctx.reply(isVideo ? "🎬 Запускаю видео…" : "🎵 Включаю музыку…");
    try {
      const info = isVideo ? await startVideo() : await startAudio();
      await ctx.reply(
        isVideo
          ? `🎬 «${info.label}» в «${info.channel?.title || "голосовом канале"}»${info.hasAudio ? " (со звуком)" : " (без звука)"}.`
          : `🎵 «${info.label}» в «${info.channel?.title || "голосовом канале"}».`,
      );
    } catch (error) {
      await ctx.reply(`Не удалось: ${error?.message || error}`);
    }
    return;
  }
  if (ctx.data === "stop") {
    const stopped = await stopPlayback();
    await ctx.reply(stopped ? "⏹ Остановил." : "Сейчас ничего не играет.");
    return;
  }
  if (ctx.data === "menu") {
    await ctx.edit({ text: "Что проверим?", buttons: mainKeyboard() });
  }
});

/* ── Обычные сообщения и профиль ──────────────────────────────────────── */

bot.onMessage(async (ctx) => {
  if (ctx.command) return;
  if (ctx.chatType === "dm") {
    if (INVITE_CODE_RE.test(normalizeInviteCode(ctx.text))) {
      await joinGroupByInviteCode(ctx, ctx.text);
      return;
    }
    if (ctx.text.trim()) {
      await ctx.reply("Напишите /help или начните ввод с «/».", {
        buttons: [[{ text: "📋 Меню", data: "menu" }]],
      });
    }
  }
});

bot.onVoiceState((payload) => {
  for (const channel of payload.channels || []) {
    const users = channel.users || [];
    console.log(`[test-bot] голосовой «${channel.title}»: ${users.length}`);
  }
});

bot.onReady(async () => {
  try {
    const result = await bot.setProfile({
      description:
        "Тестовый бот Майко: команды, кнопки, таблицы, голосовые каналы, музыка и видео со звуком, голосовые сообщения, файлы и аватар.",
      avatar: { name: "maiko-test-avatar.png", type: "image/png", data: avatarPng(0) },
    });
    console.log(
      `[test-bot] профиль: команд ${result?.commands?.length ?? 0}, аватар ${result?.avatarUrl ? "есть" : "нет"}`,
    );
    console.log(
      `[test-bot] медиа: видео ${existsSync(VIDEO_FILE) ? path.basename(VIDEO_FILE) : "нет файла (демо)"}; ` +
        `аудио ${existsSync(AUDIO_FILE) ? path.basename(AUDIO_FILE) : "нет файла (демо)"}; ` +
        `ffmpeg ${ffmpegAvailable() ? "есть" : "нет"}`,
    );
    console.log(
      `[test-bot] видео-режим: прямой rawvideo ${VIDEO_WIDTH}x${VIDEO_HEIGHT}@${VIDEO_FPS}, ` +
        "трек SOURCE_SCREENSHARE, без JPEG",
    );
  } catch (error) {
    console.warn("[test-bot] профиль не обновлён:", error?.message || error);
  }
  if (bot.chats.length) {
    console.log("[test-bot] чаты:");
    for (const chat of bot.chats) {
      console.log(`  ${chat.type === "dm" ? "ЛС" : "группа"}: ${chat.title} (${chat.id})`);
    }
  } else {
    console.log("[test-bot] пока нет чатов — напишите боту в «Людях» или добавьте в группу.");
  }
});

async function shutdown() {
  try {
    await stopPlayback({ reset: false });
    if (voiceRoom) await voiceRoom.disconnect();
  } catch {
    /* best effort */
  }
  bot.stop();
}

process.once("SIGINT", () => {
  void shutdown();
});
process.once("SIGTERM", () => {
  void shutdown();
});

