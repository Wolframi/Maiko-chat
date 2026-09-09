import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  openSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const VIDEO_EXT = new Set([".mp4", ".m4v", ".mov", ".webm"]);
const SCAN_BYTES = 4 * 1024 * 1024;
const TRANSCODE_TIMEOUT_MS = 6 * 60 * 1000;
const MAX_PARALLEL = 1;

let active = 0;
const queue: Array<() => void> = [];

function pumpQueue() {
  while (active < MAX_PARALLEL && queue.length) {
    const next = queue.shift();
    if (next) next();
  }
}

function enqueue<T>(job: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const runJob = () => {
      active += 1;
      job()
        .then(resolve, reject)
        .finally(() => {
          active -= 1;
          pumpQueue();
        });
    };
    queue.push(runJob);
    pumpQueue();
  });
}

function run(
  cmd: string,
  args: string[],
  timeoutMs: number,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > 200_000) stdout = stdout.slice(-100_000);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

function scanLooksIncompatible(filePath: string): boolean {
  try {
    const size = statSync(filePath).size;
    const fd = openSync(filePath, "r");
    const len = Math.min(SCAN_BYTES, size);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, 0);
    closeSync(fd);
    const text = buf.toString("latin1");
    return text.includes("hvc1") || text.includes("hev1");
  } catch {
    return false;
  }
}

async function probeNeedsTranscode(filePath: string, ext: string): Promise<boolean> {
  if (ext === ".mov") return true;
  // Fast path: byte scan before spawning ffprobe.
  if (scanLooksIncompatible(filePath)) return true;
  const probed = await run(
    "ffprobe",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=codec_name",
      "-of",
      "default=nw=1:nk=1",
      filePath,
    ],
    15_000,
  );
  if (probed.code === 0) {
    const codec = probed.stdout.trim().toLowerCase();
    if (!codec) return false;
    if (codec === "h264" || codec === "av1" || codec === "vp8" || codec === "vp9") {
      return false;
    }
    return true;
  }
  return false;
}

export function isTranscodableVideoPath(filePath: string, mime?: string) {
  const ext = path.extname(filePath).toLowerCase();
  if (VIDEO_EXT.has(ext)) return true;
  const m = String(mime || "").toLowerCase();
  return m.startsWith("video/");
}

/**
 * Ensure phone .mov lands as .mp4 URL so background re-encode can replace in place.
 */
export function normalizeVideoUploadPath(
  filePath: string,
  mime?: string,
): { path: string; mime: string } {
  const ext = path.extname(filePath).toLowerCase();
  const m = String(mime || "").toLowerCase();
  if (ext === ".mov" || ext === ".m4v" || (m === "video/quicktime" && ext !== ".mp4")) {
    const next = filePath.replace(/\.[^.]+$/i, "") + ".mp4";
    if (next !== filePath && existsSync(filePath)) {
      renameSync(filePath, next);
      return { path: next, mime: "video/mp4" };
    }
  }
  if (m.startsWith("video/") && (ext === ".mp4" || ext === ".m4v")) {
    return { path: filePath, mime: "video/mp4" };
  }
  return { path: filePath, mime: m || mime || "application/octet-stream" };
}

async function transcodeInPlace(filePath: string, mime?: string): Promise<boolean> {
  if (!isTranscodableVideoPath(filePath, mime)) return false;
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".webm" && String(mime || "").startsWith("audio/")) return false;

  const needs = await probeNeedsTranscode(filePath, ext);
  if (!needs) return false;
  if (!existsSync(filePath)) return false;

  const dir = path.dirname(filePath);
  const tmpOut = path.join(dir, `${randomUUID()}.browser.mp4`);
  // Prefer speed over quality: phone HEVC → H.264 so Chrome on Windows shows picture.
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-y",
    "-i",
    filePath,
    "-map",
    "0:v:0?",
    "-map",
    "0:a:0?",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-tune",
    "fastdecode",
    "-crf",
    "26",
    "-pix_fmt",
    "yuv420p",
    "-vf",
    "scale=720:-2:force_original_aspect_ratio=decrease,setsar=1",
    "-c:a",
    "aac",
    "-b:a",
    "96k",
    "-ac",
    "2",
    "-movflags",
    "+faststart",
    tmpOut,
  ];

  const started = Date.now();
  const result = await run("ffmpeg", args, TRANSCODE_TIMEOUT_MS);
  if (result.code !== 0 || !existsSync(tmpOut)) {
    try {
      unlinkSync(tmpOut);
    } catch {
      /* ignore */
    }
    console.warn("[video] ffmpeg transcode failed", result.stderr.slice(-400));
    return false;
  }

  const finalPath = filePath.replace(/\.[^.]+$/i, "") + ".mp4";
  try {
    if (finalPath !== filePath && existsSync(filePath)) {
      unlinkSync(filePath);
    }
    if (existsSync(finalPath)) {
      unlinkSync(finalPath);
    }
    renameSync(tmpOut, finalPath);
    console.info(
      "[video] transcoded",
      path.basename(finalPath),
      `${Math.round((Date.now() - started) / 1000)}s`,
    );
    return true;
  } catch (error) {
    try {
      unlinkSync(tmpOut);
    } catch {
      /* ignore */
    }
    console.warn("[video] replace after transcode failed", error);
    return false;
  }
}

/** Fire-and-forget: upload responds immediately; file is swapped when ready. */
export function scheduleBrowserVideoTranscode(filePath: string, mime?: string) {
  if (!isTranscodableVideoPath(filePath, mime)) return;
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".webm" && String(mime || "").startsWith("audio/")) return;

  void enqueue(async () => {
    try {
      await transcodeInPlace(filePath, mime);
    } catch (error) {
      console.warn("[video] background transcode error", error);
    }
  });
}

/** @deprecated sync path — prefer scheduleBrowserVideoTranscode */
export async function maybeTranscodeVideoForBrowser(
  filePath: string,
  mime?: string,
): Promise<{ path: string; size: number; mime: string; nameExt: string } | null> {
  const normalized = normalizeVideoUploadPath(filePath, mime);
  const ok = await transcodeInPlace(normalized.path, normalized.mime);
  if (!ok) return null;
  const finalPath = normalized.path.replace(/\.[^.]+$/i, "") + ".mp4";
  if (!existsSync(finalPath)) return null;
  return {
    path: finalPath,
    size: statSync(finalPath).size,
    mime: "video/mp4",
    nameExt: ".mp4",
  };
}
