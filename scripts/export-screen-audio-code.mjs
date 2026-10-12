import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "site/package.json"));
const ts = require("typescript");
const output = [
  "КОД ЗАХВАТА ЗВУКА ДЕМОНСТРАЦИИ ЭКРАНА НА САЙТЕ\n\n",
  "Снимок текущих исходников проекта. Это подборка фрагментов, а не отдельный запускаемый модуль.\n",
  "Главная точка захвата: captureScreenShare() в site/src/lib/webrtcMedia.ts.\n",
  "navigator.mediaDevices.getDisplayMedia() получает экран и доступный звук выбранного источника;\n",
  "sanitizeScreenAudio() проверяет аудиотреки, затем звонок или голосовой канал публикует их.\n",
  "screenAudio.ts управляет воспроизведением и громкостью полученной демонстрации, а не захватом.\n",
  "Роли аудиотреков передаются в offer/answer как screenAudioMids: contentHint сам по себе не передаётся по WebRTC.\n",
  "Сендер демонстрации сохраняется в WeakMap и используется повторно после остановки.\n",
  "В конце отдельно приведена обёртка Electron, применяемая при открытии сайта в приложении.\n",
  "Повторная сборка TXT: node scripts/export-screen-audio-code.mjs\n",
];

function add(file, title, names) {
  const source = readFileSync(path.join(root, file), "utf8").replaceAll("\r\n", "\n");
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const matches = new Map();
  function visit(node) {
    if ((ts.isFunctionDeclaration(node) || ts.isTypeAliasDeclaration(node)) && node.name) {
      matches.set(node.name.text, node);
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const statement = node.parent.parent;
      if (ts.isVariableStatement(statement)) matches.set(node.name.text, statement);
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  output.push(`\n\n${"=".repeat(78)}\n${title}\n${file}\n${"=".repeat(78)}\n`);
  if (!names) { output.push(`\n${source}`); return; }
  for (const name of names) {
    const node = matches.get(name);
    if (!node) throw new Error(`Не найден ${name} в ${file}`);
    const line = parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1;
    output.push(`\n// ${file}:${line} — ${name}\n${source.slice(node.getFullStart(), node.end).trim()}\n`);
  }
}

add("site/src/lib/webrtcMedia.ts", "1. Захват экрана и звука, ограничения, исключение эха", [
  "SCREEN_CAPTURE_CONSTRAINTS", "SCREEN_AUDIO_SEND_PARAMS", "SCREEN_SEND_PARAMS",
  "prepareScreenAudioTrack", "ScreenDisplayOptions", "ScreenAudioConstraints",
  "CALL_AUDIO_CAPTURE_HANDLE", "CaptureHandleConfig", "configureCallAudioCapture",
  "capturesCallTab", "ScreenCaptureOptions", "hasOwnAudioRestriction", "sanitizeScreenAudio",
  "prefersUnconstrainedScreenVideo", "displayCaptureFailed", "captureScreenShare",
]);
add("site/src/lib/webrtcMedia.ts", "2. Отправка отдельного аудиотрека демонстрации через WebRTC", [
  "screenAudioSenders", "remoteScreenAudioMids", "ScreenAudioDescription",
  "attachLocalScreenAudioTrack", "detachLocalScreenAudioTrack", "applyAudioSenderParams",
  "replaceAudioSenders",
  "localScreenAudioMids", "withScreenAudioRouting", "setRemoteDescriptionWithAudioRouting", "remoteScreenAudioTrackIds",
  "upsertFmtp", "patchOpusSection", "patchOpusSdp", "tuneSessionDescription", "setLocalDescriptionTuned",
  "splitCallAudioTracks",
]);
add("site/src/hooks/useCall.ts", "3. Захват и передача демонстрации в личном звонке", [
  "performToggleScreenShare", "toggleScreenShare", "stopScreenShare",
  "ensureScreenAudioEl", "stopScreenAudioEl", "publishRemoteStream",
  "emitSignal", "answerRemoteOffer",
]);
add("site/src/hooks/useVoiceChannelMesh.ts", "4. Захват и передача демонстрации в голосовом канале WebRTC Mesh", [
  "toggleScreenShare", "stopScreenShare",
  "emitSignal", "syncRemoteStream",
]);
add("site/src/hooks/useVoiceChannelLiveKit.ts", "5. Захват и публикация звука демонстрации через LiveKit", [
  "SCREEN_VIDEO_PUBLISH", "markAsScreenTrack", "enableLiveKitScreenShare",
]);
add("site/src/lib/screenAudio.ts", "6. Воспроизведение и громкость звука демонстрации");

const preloadFile = "desktop/site-preload.cjs";
const preload = readFileSync(path.join(root, preloadFile), "utf8").replaceAll("\r\n", "\n");
const marker = "// Read-only capture metadata.";
const offset = preload.indexOf(marker);
if (offset < 0) throw new Error(`Не найдена обёртка захвата в ${preloadFile}`);
output.push(`\n\n${"=".repeat(78)}\n7. Дополнение для приложения: политика нативного захвата звука\n${preloadFile}\n${"=".repeat(78)}\n\n`);
output.push("// Зависимости фрагмента: const { contextBridge, ipcRenderer } = require('electron');\n");
output.push(preload.slice(offset));

const target = path.join(root, "screen-share-audio-code.txt");
writeFileSync(target, output.join(""), "utf8");
console.log(`Создан ${path.basename(target)}`);
