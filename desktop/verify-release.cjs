const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const yaml = require('js-yaml');
const { version } = require('./package.json');
const release = path.join(__dirname, 'release');
const feed = yaml.load(fs.readFileSync(path.join(release, 'win-unpacked/resources/app-update.yml'), 'utf8'));
if (feed.provider !== 'github' || feed.owner !== 'Wolframi' || feed.repo !== 'Maiko-chat') throw new Error('Incorrect update repository in packaged app');
const metadata = yaml.load(fs.readFileSync(path.join(release, 'latest.yml'), 'utf8'));
const installer = `Maiko-Setup-${version}.exe`;
if (metadata.version !== version || metadata.path !== installer) throw new Error('Update metadata does not match the release');
const file = metadata.files.find((entry) => entry.url === installer);
const bytes = fs.readFileSync(path.join(release, installer));
const hash = crypto.createHash('sha512').update(bytes).digest('base64');
if (!file || file.sha512 !== hash || metadata.sha512 !== hash || file.size !== bytes.length) throw new Error('Installer checksum mismatch');
for (const name of [`${installer}.blockmap`, `Maiko-Portable-${version}.exe`]) {
  if (!fs.statSync(path.join(release, name)).size) throw new Error(`Empty artifact: ${name}`);
}
console.log(`Verified ${version}: installer SHA-512, blockmap, portable and latest.yml.`);
