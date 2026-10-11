/** Allow browser part uploads to the bucket. Usage: tsx scripts/s3-cors.ts https://site [...more origins] */
import { GetBucketCorsCommand, PutBucketCorsCommand } from "@aws-sdk/client-s3";
import { objectLocation, s3Client } from "../src/server/objectStorage";

async function main() {
  const origins = process.argv.slice(2).map((origin) => new URL(origin).origin);
  if (!s3Client) throw new Error("S3 storage is not configured");
  if (!origins.length) throw new Error("Pass at least one site origin");
  const { Bucket } = objectLocation("cors-probe");
  await s3Client.send(new PutBucketCorsCommand({
    Bucket,
    CORSConfiguration: {
      CORSRules: [{
        AllowedOrigins: origins,
        AllowedMethods: ["PUT"],
        AllowedHeaders: ["*"],
        ExposeHeaders: ["ETag"],
        MaxAgeSeconds: 3600,
      }],
    },
  }));
  const current = await s3Client.send(new GetBucketCorsCommand({ Bucket }));
  console.log(JSON.stringify(current.CORSRules));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
