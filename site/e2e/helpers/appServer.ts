import { spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** Production build, isolated data and deterministic local accounts. */
export async function appServer(historyMessages = 0) {
  const helper = pathToFileURL(path.resolve("tests/helpers/securityServer.ts")).href;
  const script = `import { securityServer } from ${JSON.stringify(helper)};
    const server = await securityServer({historyMessages:${historyMessages}});
    process.send({base:server.base,token:server.token});
    const stop=async()=>{await server.stop();process.exit();};
    process.once('message',stop);process.once('disconnect',stop);`;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let logs = "";
  child.stderr?.on("data", data => { logs = (logs + data).slice(-12000); });
  const result = await new Promise<{ base: string; token: string }>((resolve, reject) => {
    child.once("message", message => resolve(message as { base: string; token: string }));
    child.once("exit", code => reject(new Error(`Fixture exited ${code}: ${logs}`)));
  });
  return { ...result, stop: async () => {
    if (child.exitCode !== null) return;
    const exit = new Promise(resolve => child.once("exit", resolve));
    child.send("stop");
    await exit;
  } };
}
