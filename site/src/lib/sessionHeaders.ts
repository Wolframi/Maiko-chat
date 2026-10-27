/** HTTP endpoints use the same session as Socket.IO. Never put it in a URL. */
export function sessionHeaders(): Record<string, string> {
  try {
    const token = localStorage.getItem("pulse-chat-token");
    return token ? { "x-pulse-token": token } : {};
  } catch { return {}; }
}
