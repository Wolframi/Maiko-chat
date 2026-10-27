// The custom server authenticates and serves GIF requests using its live session
// store. Fail closed if this route is reached via an unsupported Next-only server.
export function GET() {
  return Response.json({ error: "Unauthorized" }, { status: 401, headers: { "Cache-Control": "no-store" } });
}
