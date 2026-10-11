const { execFile } = require('node:child_process');
const path = require('node:path');
const { promisify } = require('node:util');

const run = promisify(execFile);
async function windowProcesses(sources) {
  if (process.platform !== 'win32') return {};
  const handles = [...new Set(sources.map(({ id }) => /^window:([0-9]+):/.exec(id)?.[1]).filter(Boolean))];
  if (!handles.length) return {};
  const helper = path.join(__dirname, 'native/window-processes.exe').replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
  const { stdout } = await run(helper, [handles.join(',')], {
      windowsHide: true, timeout: 5_000, maxBuffer: 256 * 1024,
    });
  return JSON.parse(stdout.trim());
}

function audioPolicy(source, owners, ownProcess = process.pid) {
  if (process.platform !== 'win32') return null;
  if (/^screen:[0-9]+:/.test(source.id)) {
    // Electron 44.7.0 accepts an audio { id, name } in its native handler.
    // This Chromium device excludes our audio service, including ALL remote
    // voices and remote screen playback, without muting anyone locally.
    return { kind: 'system', device: { id: 'loopbackWithoutChrome', name: 'Звук ПК без Майко' } };
  }
  const handle = /^window:([0-9]+):/.exec(source.id)?.[1];
  const owner = owners[handle];
  if (!Number.isSafeInteger(owner) || owner <= 0 || owner === ownProcess) return null;
  // WASAPI process loopback includes only the owning app and its children.
  // Never fall back to global loopback when an app cannot be resolved.
  return { kind: 'application', device: { id: `applicationLoopback:${owner}`, name: 'Звук выбранного приложения' } };
}

module.exports = { windowProcesses, audioPolicy };
