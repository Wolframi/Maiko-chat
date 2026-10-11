import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, unlink } from "node:fs/promises";
import { Agent } from "node:https";
import path from "node:path";
import { Readable } from "node:stream";
import { finished, pipeline } from "node:stream/promises";

type StorageConfig = {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  prefix?: string;
  localAddress?: string;
};

function loadConfig(): StorageConfig | null {
  if (process.env.MEDIA_STORAGE === "local") return null;
  const filename = process.env.S3_CONFIG_FILE || path.join(process.cwd(), ".s3-storage.json");
  const file = existsSync(filename)
    ? JSON.parse(readFileSync(filename, "utf8")) as Partial<StorageConfig>
    : {};
  if (!file.bucket && !process.env.S3_BUCKET && process.env.MEDIA_STORAGE !== "s3") return null;
  const config = {
    endpoint: process.env.S3_ENDPOINT || file.endpoint || "https://s3.cloud.ru",
    region: process.env.S3_REGION || file.region || "ru-central-1",
    bucket: process.env.S3_BUCKET || file.bucket || "",
    accessKeyId: process.env.S3_ACCESS_KEY_ID || file.accessKeyId || "",
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || file.secretAccessKey || "",
    prefix: process.env.S3_PREFIX ?? file.prefix ?? "",
    localAddress: process.env.S3_LOCAL_ADDRESS || file.localAddress,
  };
  if (!config.bucket || !config.accessKeyId || !config.secretAccessKey) {
    throw new Error("S3 requires bucket, accessKeyId (tenant_id:key_id), and secretAccessKey");
  }
  if (new URL(config.endpoint).protocol !== "https:") throw new Error("S3 endpoint must use HTTPS");
  return config;
}

const config = loadConfig();
export const s3Enabled = Boolean(config);
/** Browsers upload parts straight to this origin (CSP connect-src, bucket CORS). */
export const s3Origin = config ? new URL(config.endpoint).origin : "";
export const s3Client = config ? new S3Client({
  endpoint: config.endpoint,
  region: config.region,
  credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  forcePathStyle: true,
  // Cloud.ru uses the S3 API without AWS's optional streaming checksums.
  requestChecksumCalculation: "WHEN_REQUIRED",
  responseChecksumValidation: "WHEN_REQUIRED",
  requestHandler: {
    httpsAgent: new Agent({ keepAlive: true, maxSockets: 32, localAddress: config.localAddress }),
    connectionTimeout: 10_000,
    socketTimeout: 120_000,
  },
  maxAttempts: 3,
}) : null;

export function objectLocation(key: string) {
  if (!config) throw new Error("S3 storage is not configured");
  if (!key || key.startsWith("/") || key.includes("\\") || key.split("/").some((p) => !p || p === "." || p === "..")) {
    throw new Error("Invalid object key");
  }
  const prefix = (config.prefix || "").replace(/^\/+|\/+$/g, "");
  return { Bucket: config.bucket, Key: prefix ? `${prefix}/${key}` : key };
}

export function isObjectNotFound(error: unknown) {
  return (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode === 404;
}

export async function headObject(key: string) {
  if (!s3Client) throw new Error("S3 storage is not configured");
  try {
    return await s3Client.send(new HeadObjectCommand(objectLocation(key)));
  } catch (error) {
    if (isObjectNotFound(error)) return null;
    throw error;
  }
}

export async function readObject(key: string, range?: { start: number; end: number }, signal?: AbortSignal, ifMatch?: string) {
  if (!s3Client) throw new Error("S3 storage is not configured");
  const result = await s3Client.send(new GetObjectCommand({
    ...objectLocation(key),
    ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}),
    ...(ifMatch ? { IfMatch: ifMatch } : {}),
  }), { abortSignal: signal });
  if (!(result.Body instanceof Readable)) throw new Error("S3 response has no readable body");
  return { body: result.Body, info: result };
}

export async function fileSha256(filename: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest("hex");
}

/** Commit to S3 only after an acknowledged PUT and a matching HEAD. */
export async function putObjectFile(key: string, filename: string, contentType: string, metadata: Record<string, string> = {}) {
  if (!s3Client) throw new Error("S3 storage is not configured");
  const size = statSync(filename).size;
  const sha256 = await fileSha256(filename);
  const body = createReadStream(filename);
  try {
    await s3Client.send(new PutObjectCommand({
      ...objectLocation(key), Body: body, ContentLength: size, ContentType: contentType,
      Metadata: { ...metadata, sha256 },
    }));
  } finally {
    body.destroy();
    // An SDK failure can occur before it starts consuming the file stream.
    // Wait for the pending open/close before callers remove the temporary file.
    await finished(body).catch(() => undefined);
  }
  const stored = await headObject(key);
  if (!stored || stored.ContentLength !== size || stored.Metadata?.sha256 !== sha256) {
    throw new Error(`S3 verification failed: ${key}`);
  }
  return stored;
}

export async function putObjectBuffer(key: string, body: Buffer, contentType: string) {
  if (!s3Client) throw new Error("S3 storage is not configured");
  await s3Client.send(new PutObjectCommand({
    ...objectLocation(key), Body: body, ContentLength: body.length, ContentType: contentType,
    Metadata: { sha256: createHash("sha256").update(body).digest("hex") },
  }));
}

export async function readObjectBuffer(key: string): Promise<Buffer | null> {
  try {
    const { body } = await readObject(key);
    const chunks: Buffer[] = [];
    for await (const chunk of body) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  } catch (error) {
    if (isObjectNotFound(error)) return null;
    throw error;
  }
}

export async function readObjectPrefix(key: string, bytes: number): Promise<Buffer> {
  const { body } = await readObject(key, { start: 0, end: Math.max(0, bytes - 1) });
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).subarray(0, bytes);
}

export async function deleteObject(key: string) {
  if (!s3Client) throw new Error("S3 storage is not configured");
  await s3Client.send(new DeleteObjectCommand(objectLocation(key)));
}

export async function createMultipartUpload(key: string, contentType: string, metadata: Record<string, string>) {
  if (!s3Client) throw new Error("S3 storage is not configured");
  const result = await s3Client.send(new CreateMultipartUploadCommand({
    ...objectLocation(key), ContentType: contentType, Metadata: metadata,
  }));
  if (!result.UploadId) throw new Error("S3 did not return an upload id");
  return result.UploadId;
}

/** The signature pins Content-Length, so a part URL accepts exactly `size` bytes. */
export async function presignUploadPart(key: string, uploadId: string, partNumber: number, size: number, expiresIn: number) {
  if (!s3Client) throw new Error("S3 storage is not configured");
  return getSignedUrl(s3Client, new UploadPartCommand({
    ...objectLocation(key), UploadId: uploadId, PartNumber: partNumber, ContentLength: size,
  }), { expiresIn, signableHeaders: new Set(["content-length"]) });
}

export async function completeMultipartUpload(key: string, uploadId: string, parts: Array<{ partNumber: number; etag: string }>) {
  if (!s3Client) throw new Error("S3 storage is not configured");
  await s3Client.send(new CompleteMultipartUploadCommand({
    ...objectLocation(key), UploadId: uploadId,
    MultipartUpload: { Parts: parts.map((part) => ({ PartNumber: part.partNumber, ETag: part.etag })) },
  }));
}

export async function abortMultipartUpload(key: string, uploadId: string) {
  if (!s3Client) throw new Error("S3 storage is not configured");
  try {
    await s3Client.send(new AbortMultipartUploadCommand({ ...objectLocation(key), UploadId: uploadId }));
  } catch (error) {
    if (!isObjectNotFound(error)) throw error;
  }
}

/** Caller owns the returned temporary copy and must remove it. */
export async function downloadObjectToTemp(key: string) {
  const dir = path.join(process.cwd(), "data", "media-tmp");
  await mkdir(dir, { recursive: true });
  const filename = path.join(dir, `${randomUUID()}${path.extname(key)}`);
  try {
    const { body } = await readObject(key);
    await pipeline(body, createWriteStream(filename, { flags: "wx" }));
    return filename;
  } catch (error) {
    await unlink(filename).catch(() => undefined);
    throw error;
  }
}

/** Processing gets its own temporary copy, removed on both success and failure. */
export async function withObjectFile<T>(key: string, consume: (filename: string) => Promise<T> | T): Promise<T> {
  const filename = await downloadObjectToTemp(key);
  try {
    return await consume(filename);
  } finally {
    await unlink(filename).catch(() => undefined);
  }
}
