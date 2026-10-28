const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const yaml = require('js-yaml');
const { version } = require('./package.json');
const release = path.join(__dirname, 'release');
const feed = yaml.load(fs.readFileSync(path.join(release, 'win-unpacked/resources/app-update.yml'), 'utf8'));
if (feed.provider !== 'generic' || feed.url !== 'https://maiko.galacticvps.qzz.io/desktop-updates-s3/' || feed.useMultipleRangeRequest !== false) throw new Error('Incorrect update source in packaged app');
const metadata = yaml.load(fs.readFileSync(path.join(release, 'latest.yml'), 'utf8'));
const installer = `Maiko-Setup-${version}.exe`;
if (metadata.version !== version || metadata.path !== installer) throw new Error('Update metadata does not match the release');
const file = metadata.files.find((entry) => entry.url === installer);
const bytes = fs.readFileSync(path.join(release, installer));
const hash = crypto.createHash('sha512').update(bytes).digest('base64');
if (!file || file.sha512 !== hash || metadata.sha512 !== hash || file.size !== bytes.length) throw new Error('Installer checksum mismatch');
for (const name of [`${installer}.blockmap`]) {
  if (!fs.statSync(path.join(release, name)).size) throw new Error(`Empty artifact: ${name}`);
}
const bridge = path.join('native', 'Maiko DAW Bridge.vst3', 'Contents', 'x86_64-win', 'Maiko DAW Bridge.vst3');
const packagedBridge = fs.readFileSync(path.join(release, 'win-unpacked/resources/app.asar.unpacked', bridge));
if (!packagedBridge.length || !packagedBridge.equals(fs.readFileSync(path.join(__dirname, bridge)))) {
  throw new Error('Packaged Maiko DAW Bridge is missing or differs from the verified native build');
}
const asar = require('@electron/asar');
const archive = path.join(release, 'win-unpacked/resources/app.asar');
require('./verify-protection.cjs').verify(archive);
if (asar.listPackage(archive).some((name) => /native[\\/].*\.zip$/.test(name))) throw new Error('VST3 ZIP must not be bundled');
for (const helper of ['capture-processes.exe', 'window-processes.exe', 'update-window.exe', 'install-daw-bridge.exe']) {
  const packed = fs.readFileSync(path.join(release, 'win-unpacked/resources/app.asar.unpacked/native', helper));
  if (!packed.equals(fs.readFileSync(path.join(__dirname, 'native', helper)))) throw new Error(`Packaged ${helper} differs`);
}
for (const module of ['ui/automatic-audio.js', 'ui/daw-worklet.js', 'ui/startup-model.js']) {
  if (!asar.extractFile(archive, module).equals(fs.readFileSync(path.join(__dirname, '.protected', module)))) throw new Error(`Packaged ${module} differs`);
}
for (const intro of ['hiphop', 'samba']) {
  const model = path.join('bundled-assets', 'models', `maiko-${intro}.bin`);
  if (!asar.extractFile(archive, model).equals(fs.readFileSync(path.join(__dirname, model)))) throw new Error(`Packaged startup model ${intro} differs`);
}
console.log(`Verified ${version}: installer SHA-512, blockmap, feed, native helpers, automatic audio and direct VST3 installation without ZIP.`);
