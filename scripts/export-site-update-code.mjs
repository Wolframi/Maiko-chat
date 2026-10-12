import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(path.join(root, file), "utf8").replaceAll("\r\n", "\n");
const output = ["КОД ОБНОВЛЕНИЯ САЙТА В БРАУЗЕРЕ И ELECTRON\n\n", read("docs/site-updates.md")];
function add(file, code = read(file), note = "") {
  output.push(`\n\n${"=".repeat(78)}\n${file}${note ? ` — ${note}` : ""}\n${"=".repeat(78)}\n\n${code}`);
}
function fragment(file, start, end, note) {
  const source = read(file);
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  if (from < 0 || to < 0) throw new Error(`Не найден фрагмент: ${file}: ${start}`);
  add(file, source.slice(from, to), note);
}

for (const file of ["site/scripts/build-site.mjs", "site/next.config.ts", "site/src/lib/liveReload.ts",
  "site/src/lib/mediaResume.ts", "site/src/components/chat/BootPoller.tsx", "site/src/components/chat/SiteUpdateNotice.tsx",
  "site/src/lib/desktopMedia.ts", "site/src/hooks/useDesktopMedia.ts", "site/src/components/chat/DesktopMediaHost.tsx",
  "site/src/app/desktop-runtime/page.tsx", "site/src/app/layout.tsx", "desktop/main.cjs", "desktop/site-preload.cjs",
  "desktop/ui/index.html", "desktop/ui/shell.js", "desktop/ui/shell.css"]) add(file);
fragment("site/server.ts", "const APP_BOOT_ID", "type VoiceMember", "идентификаторы сборки и время восстановления");
fragment("site/server.ts", '    if (url.startsWith("/api/health"))', '    if (url.startsWith("/api/livekit/token"))', "проверка готовности");
fragment("site/server.ts", "  // Keep sending boot id", "    // people list only after auth", "рассылка с сервера и резервирование звонка перед перезагрузкой");
fragment("site/server.ts", "function afterAuth(", "function refreshPresenceName(", "возвращение в прежний звонок после авторизации");
fragment("site/server.ts", '    socket.on("disconnect", () => {', "  const previousUpgrade", "сохранение участия при временном отключении");
fragment("site/src/hooks/useCall.ts", "  const prepareResumeControls", "  const answerRemoteOffer", "восстановление микрофона, наушников и камеры");
fragment("site/src/hooks/useCall.ts", '    if (!active || !active.callId || resumeControlsRef.current) return;', "  const acceptCall", "снимок звонка и запрос на восстановление вместо нового вызова");
fragment("site/src/hooks/useCall.ts", "    const onResume = async", '    socket.on("call:incoming",', "переподключение существующего звонка");
fragment("site/src/components/chat/ChatApp.tsx", "  const wasConnectedRef", "  useEffect(() => {\n    function onNotifyOpen", "автоматическое возвращение в звонок или голосовой канал");
add("site/e2e/site-reload.spec.ts");
add("site/e2e/call-media.spec.ts");
add("desktop/tests/persistent-media.cjs");
writeFileSync(path.join(root, "site-update-code.txt"), output.join(""), "utf8");
console.log("Создан site-update-code.txt");
