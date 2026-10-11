import { loadEnvConfig } from "@next/env";
import path from "node:path";
import { MessageStore } from "../src/server/messageStore";

loadEnvConfig(process.cwd());
async function main() {
  if (!process.argv.includes("--apply")) throw new Error("Stop the application, back up data, then pass --apply");
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is required");
  const store = new MessageStore(process.env.MONGODB_URI, process.env.MONGODB_DATABASE);
  try {
    await store.connect();
    console.log(JSON.stringify(await store.migrate(path.join(process.cwd(), "data/messages.json"))));
  } finally { await store.close(); }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
