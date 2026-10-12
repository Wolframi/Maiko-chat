import { GetObjectCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { Agent } from "node:https";

type Config = { endpoint: string; region: string; bucket: string; accessKeyId: string; secretAccessKey: string; localAddress?: string };
export function desktopUpdateStorage() {
  const filename = process.env.DESKTOP_S3_CONFIG_FILE || path.join(process.cwd(), ".desktop-s3-storage.json");
  if (!existsSync(filename)) return null;
  const config: Config = JSON.parse(readFileSync(filename, "utf8"));
  if (!config.bucket || !config.accessKeyId || !config.secretAccessKey || new URL(config.endpoint).protocol !== "https:") {
    throw new Error("Invalid desktop S3 configuration");
  }
  const client = new S3Client({
    endpoint: config.endpoint, region: config.region, forcePathStyle: true,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED",
    requestHandler: { httpsAgent: new Agent({ keepAlive: true, localAddress: config.localAddress }), connectionTimeout: 10_000, socketTimeout: 120_000 },
  });
  const location = (name: string) => ({ Bucket: config.bucket, Key: `desktop-updates/${name}` });
  return {
    client, location,
    async manifest() {
      const result = await client.send(new GetObjectCommand(location("latest.yml")));
      return Buffer.from(await result.Body!.transformToByteArray());
    },
    async download(name: string) {
      const info = await client.send(new HeadObjectCommand(location(name)));
      const url = await getSignedUrl(client, new GetObjectCommand(location(name)), { expiresIn: 3600 });
      return { url, size: info.ContentLength! };
    },
  };
}
