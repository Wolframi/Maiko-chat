const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

if (process.platform === 'win32') {
  const source = path.join(__dirname, 'daw-bridge');
  const build = path.join(__dirname, '.daw-bridge-build');
  const bundle = path.join(__dirname, 'native', 'Maiko DAW Bridge.vst3');
  const output = path.join(bundle, 'Contents', 'x86_64-win', 'Maiko DAW Bridge.vst3');
  const inputs = ['Cargo.toml', 'Cargo.lock', 'src/lib.rs', 'src/transport.rs', 'src/view.rs'].map((name) => path.join(source, name));
  if (!fs.existsSync(output) || inputs.some((name) => fs.statSync(name).mtimeMs > fs.statSync(output).mtimeMs)) {
    try {
      execFileSync('cargo', ['build', '--manifest-path', path.join(source, 'Cargo.toml'), '--locked', '--release', '--target-dir', build],
        { windowsHide: true, stdio: 'inherit', env: { ...process.env, CARGO_ENCODED_RUSTFLAGS: '-Ctarget-feature=+crt-static' } });
    } catch (error) {
      throw new Error('Не удалось собрать Maiko DAW Bridge. Нужны Rust (MSVC) и Visual C++ Build Tools.', { cause: error });
    }
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.copyFileSync(path.join(build, 'release', 'maiko_daw_bridge.dll'), output);
  }
  fs.copyFileSync(path.join(source, 'THIRD-PARTY-NOTICES.txt'), path.join(bundle, 'Contents', 'THIRD-PARTY-NOTICES.txt'));
  console.log('Maiko DAW Bridge VST3 prepared.');
}
