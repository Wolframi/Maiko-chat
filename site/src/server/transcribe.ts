import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { DeepgramClient } from "@deepgram/sdk";

const MAX_BYTES = 25 * 1024 * 1024;
const inflight = new Map<string, Promise<string>>();

let cachedApiKey = "";
let cachedClient: DeepgramClient | null = null;

function readSecretFile(filename: string) {
  try {
    return readFileSync(path.join(process.cwd(), filename), "utf8")
      .replace(/\r/g, "")
      .trim();
  } catch {
    return "";
  }
}

function readEnvFileValue(name: string) {
  const envFile = readSecretFile(".env");
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = envFile.match(new RegExp(`^${escaped}\\s*=\\s*(.+)$`, "m"));
  return match?.[1]?.trim().replace(/^["']|["']$/g, "") || "";
}

function deepgramApiKey() {
  return (
    readSecretFile(".deepgram-api-key") ||
    String(process.env.DEEPGRAM_API_KEY || "").trim() ||
    readEnvFileValue("DEEPGRAM_API_KEY")
  );
}

function deepgramLanguage() {
  return (
    String(process.env.DEEPGRAM_LANGUAGE || "").trim() ||
    readEnvFileValue("DEEPGRAM_LANGUAGE") ||
    "multi"
  );
}

function deepgramKeyterms() {
  const raw =
    String(process.env.DEEPGRAM_KEYTERMS || "").trim() ||
    readSecretFile(".deepgram-keyterms") ||
    readEnvFileValue("DEEPGRAM_KEYTERMS");
  if (!raw) return undefined;
  const terms = [
    ...new Set(
      raw
        .split(/\r?\n|,/)
        .map((term) => term.trim())
        .filter(Boolean),
    ),
  ];
  return terms.length ? terms.slice(0, 100) : undefined;
}

function deepgramClient() {
  const apiKey = deepgramApiKey();
  if (!apiKey) throw new Error("DEEPGRAM_API_KEY не задан");
  if (!cachedClient || cachedApiKey !== apiKey) {
    cachedApiKey = apiKey;
    cachedClient = new DeepgramClient({ apiKey });
  }
  return cachedClient;
}

export function hasTranscriptionKey() {
  return Boolean(deepgramApiKey());
}

function uploadName(fileName: string, filePath: string, mime?: string) {
  const fromName = path.extname(fileName);
  const fromPath = path.extname(filePath);
  const ext =
    fromName ||
    fromPath ||
    (String(mime || "").includes("mp4") || String(mime || "").includes("m4a")
      ? ".m4a"
      : String(mime || "").includes("ogg")
        ? ".ogg"
        : String(mime || "").includes("mpeg")
          ? ".mp3"
          : String(mime || "").includes("wav")
            ? ".wav"
            : ".webm");
  return `voice${ext}`;
}

function errorDetail(error: unknown) {
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export async function transcribeAudioFile(
  filePath: string,
  fileName: string,
  mime?: string,
) {
  if (!existsSync(filePath)) throw new Error("Файл не найден");

  const size = statSync(filePath).size;
  if (!size || size > MAX_BYTES) {
    throw new Error("Файл слишком большой для расшифровки");
  }

  const contentType =
    String(mime || "audio/webm").split(";")[0].trim() || "audio/webm";

  try {
    const result = await deepgramClient().listen.v1.media.transcribeFile(
      {
        path: filePath,
        filename: uploadName(fileName, filePath, mime),
        contentType,
        contentLength: size,
      },
      {
        model: "nova-3",
        language: deepgramLanguage(),
        smart_format: true,
        numerals: true,
        punctuate: true,
        keyterm: deepgramKeyterms(),
      },
      {
        timeoutInSeconds: 90,
        maxRetries: 2,
      },
    );

    if (!("results" in result)) {
      throw new Error("Deepgram вернул асинхронный ответ без расшифровки");
    }

    const text = result.results.channels
      .map((channel) => channel.alternatives?.[0]?.transcript || "")
      .filter(Boolean)
      .join("\n")
      .trim();
    if (!text || /^[\s.,!?…;:\-–—]+$/.test(text)) return "";
    return text;
  } catch (error) {
    const detail = errorDetail(error);
    if (/audio[_ ]too[_ ]short|too short|no speech/i.test(detail)) return "";
    throw new Error(`Deepgram: ${detail}`);
  }
}

export function queueTranscription(
  messageId: string,
  run: () => Promise<string>,
) {
  const existing = inflight.get(messageId);
  if (existing) return existing;
  const pending = run().finally(() => inflight.delete(messageId));
  inflight.set(messageId, pending);
  return pending;
}
