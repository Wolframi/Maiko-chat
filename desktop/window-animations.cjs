const { execFile } = require('node:child_process');
const path = require('node:path');
const { promisify } = require('node:util');
const run = promisify(execFile);

async function enableNativeWindowAnimations(win) {
  if (process.platform !== 'win32') return;
  const handle = win.getNativeWindowHandle();
  const windowId = handle.length === 8 ? handle.readBigUInt64LE().toString() : String(handle.readUInt32LE());
  const helper = path.join(__dirname, 'native/window-animations.exe').replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
  // Electron strips WS_CAPTION from transparent windows even with thickFrame:true.
  // Restore the animation flag and disable DWM's opaque non-client backing
  // before showing. Otherwise even alpha-transparent corners appear white.
  // user32 sends style notifications to Electron's UI thread, which must stay
  // responsive while the helper runs. A synchronous child process would deadlock.
  await run(helper, [windowId, String(process.pid), 'enable'], {
    windowsHide: true, timeout: 5_000,
  });
}

module.exports = { enableNativeWindowAnimations };
