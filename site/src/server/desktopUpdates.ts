import type { IncomingMessage, ServerResponse } from "node:http";
import { desktopUpdateStorage } from "./desktopUpdateStorage";

type Storage = Pick<NonNullable<ReturnType<typeof desktopUpdateStorage>>, "manifest" | "download">;
export function createDesktopUpdateHandler(storage: Storage | null) {
  return (req: IncomingMessage, res: ServerResponse): boolean => {
    const pathname = (req.url || "").split("?")[0];
    if (!pathname.startsWith("/desktop-updates-s3/")) return false;
    res.setHeader("Cache-Control", "no-store");
    let name = pathname.slice("/desktop-updates-s3/".length);
    if (!/^(latest\.yml|latest\.exe|Maiko-Setup-\d+\.\d+\.\d+\.exe(?:\.blockmap)?)$/.test(name)) {
      res.writeHead(404); res.end(); return true;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { Allow: "GET, HEAD" }); res.end(); return true;
    }
    if (!storage) { res.writeHead(503); res.end(); return true; }
    void (async () => {
      if (name === "latest.yml") {
        const body = await storage.manifest();
        res.writeHead(200, { "Content-Type": "text/yaml; charset=utf-8", "Content-Length": body.length });
        res.end(req.method === "HEAD" ? undefined : body);
      } else {
        if (name === "latest.exe") {
          const metadata = (await storage.manifest()).toString("utf8");
          const version = /^version: (\d+\.\d+\.\d+)\s*$/m.exec(metadata)?.[1];
          if (!version) throw new Error("Invalid desktop release version");
          name = `Maiko-Setup-${version}.exe`;
        }
        const { url, size } = await storage.download(name);
        // Only metadata passes through this server. Installer and Range bytes
        // go straight from the private S3 bucket to electron-updater.
        if (req.method === "HEAD") {
          res.writeHead(200, { "Content-Length": size, "Accept-Ranges": "bytes" });
        } else { res.writeHead(302, { Location: url }); }
        res.end();
      }
    })().catch((error: unknown) => {
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      res.writeHead(status === 404 ? 404 : 503);
      res.end();
    });
    return true;
  };
}

let handler: ReturnType<typeof createDesktopUpdateHandler> | undefined;
export function tryServeDesktopUpdate(req: IncomingMessage, res: ServerResponse) {
  if (!(req.url || "").startsWith("/desktop-updates-s3/")) return false;
  try { handler ??= createDesktopUpdateHandler(desktopUpdateStorage()); }
  catch { res.writeHead(503, { "Cache-Control": "no-store" }); res.end(); return true; }
  return handler(req, res);
}
