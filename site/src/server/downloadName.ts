/** A suggested download name never becomes a server filesystem path. */
export function downloadName(name: string, fallback: string) {
  const clean = name.split(/[/\\]/).pop()!
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "_")
    .replace(/[. ]+$/g, "").trim();
  return clean && clean !== "." && clean !== ".." ? clean.slice(0, 180) : fallback;
}

export function downloadDisposition(name: string, attachment: boolean) {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  const encoded = encodeURIComponent(name).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${attachment ? "attachment" : "inline"}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
