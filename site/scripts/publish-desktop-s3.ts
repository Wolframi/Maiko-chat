import { GetObjectCommand, HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { createReadStream, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { desktopUpdateStorage } from "../src/server/desktopUpdateStorage";

async function main() {
const storage = desktopUpdateStorage();
if (!storage) throw new Error("Desktop S3 configuration is missing");
const directory = path.resolve(process.argv[2] || "../desktop/release");
const metadata = readFileSync(path.join(directory, "latest.yml"), "utf8");
const version = /^version: (\d+\.\d+\.\d+)\s*$/m.exec(metadata)?.[1];
if (!version) throw new Error("Invalid release version");
const installer = `Maiko-Setup-${version}.exe`;
const hash = /^sha512: (\S+)\s*$/m.exec(metadata)?.[1];
const size = Number(/^\s+size: (\d+)\s*$/m.exec(metadata)?.[1]);
if (/^path: (.+)$/m.exec(metadata)?.[1].trim() !== installer ||
    /^\s+- url: (.+)$/m.exec(metadata)?.[1].trim() !== installer) throw new Error("Invalid release filenames");
async function digestFile(filename: string) {
  const digest = createHash("sha512");
  for await (const chunk of createReadStream(filename)) digest.update(chunk);
  return digest.digest("base64");
}
try {
  if (statSync(path.join(directory, installer)).size !== size || await digestFile(path.join(directory, installer)) !== hash) {
    throw new Error("Installer SHA-512 mismatch");
  }
  try {
    const previous = (await storage.manifest()).toString("utf8");
    const oldVersion = /^version: (\d+\.\d+\.\d+)\s*$/m.exec(previous)?.[1];
    if (!oldVersion) throw new Error("Invalid previous manifest");
    const a = version.split(".").map(Number), b = oldVersion.split(".").map(Number);
    const first = a.findIndex((n, i) => n !== b[i]);
    if (first >= 0 && a[first] < b[first]) throw new Error("Refusing an older S3 release");
    if (version === oldVersion && /^sha512: (\S+)\s*$/m.exec(previous)?.[1] !== hash) throw new Error("Refusing to replace an existing version");
  } catch (error) {
    if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode !== 404) throw error;
  }
  for (const name of [installer, installer + ".blockmap"]) {
    const filename = path.join(directory, name), fileSize = statSync(filename).size;
    const digest = await digestFile(filename);
    if (!fileSize) throw new Error("Empty artifact");
    let exists = false;
    try {
      const previous = await storage.client.send(new HeadObjectCommand(storage.location(name)));
      if (previous.ContentLength !== fileSize || previous.Metadata?.sha512 !== digest) throw new Error(`Conflicting S3 artifact: ${name}`);
      exists = true;
    } catch (error) {
      if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode !== 404) throw error;
    }
    if (!exists) await storage.client.send(new PutObjectCommand({
      ...storage.location(name), Body: createReadStream(filename), ContentLength: fileSize,
      ContentType: "application/octet-stream", Metadata: { sha512: digest }, IfNoneMatch: "*",
    }));
    // The SDK retries requests, but cannot retry a response stream that closes
    // after headers. Retry the full read independently before publishing.
    for (let attempt = 1; ; attempt++) {
      try {
        const stored = await storage.client.send(new GetObjectCommand(storage.location(name)));
        const verified = createHash("sha512");
        let received = 0;
        for await (const chunk of stored.Body as AsyncIterable<Uint8Array>) { verified.update(chunk); received += chunk.length; }
        if (received !== fileSize || verified.digest("base64") !== digest) throw new Error(`S3 checksum mismatch: ${name}`);
        break;
      } catch (error) { if (attempt === 3) throw error; }
    }
  }
  await storage.client.send(new PutObjectCommand({
    ...storage.location("latest.yml"), Body: Buffer.from(metadata), ContentType: "text/yaml", CacheControl: "no-store",
  }));
  if ((await storage.manifest()).toString("utf8") !== metadata) throw new Error("S3 manifest verification failed");
  console.log(`Published ${version} to S3; installer and blockmap verified by SHA-512.`);
} finally { storage.client.destroy(); }
}
main().catch((error: Error) => { console.error(`${error.name}: ${error.message}`); process.exitCode = 1; });
