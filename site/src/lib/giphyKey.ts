import { readFileSync } from "node:fs";
import path from "node:path";

function readSecretFile(filename: string) {
  try {
    return readFileSync(path.join(process.cwd(), filename), "utf8")
      .replace(/\r/g, "")
      .trim();
  } catch {
    return "";
  }
}

/** Env first (PM2), then `.giphy-api-key` / `.env` so local `npm run dev` works. */
export function giphyApiKey() {
  const fromEnv = String(process.env.GIPHY_API_KEY || "").trim();
  if (fromEnv) return fromEnv;
  const fromFile = readSecretFile(".giphy-api-key");
  if (fromFile) return fromFile;
  const envFile = readSecretFile(".env");
  const match = envFile.match(/^GIPHY_API_KEY\s*=\s*(.+)$/m);
  if (!match) return "";
  return match[1].trim().replace(/^["']|["']$/g, "");
}
