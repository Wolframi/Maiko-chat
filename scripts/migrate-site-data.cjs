// Preserve data and credentials for existing VPS checkouts after the split.
// New checkouts keep their runtime files inside site/.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const site = path.join(root, 'site');
for (const name of ['data', 'uploads']) {
  const source = path.join(root, name);
  const target = path.join(site, name);
  if (fs.existsSync(source) && !fs.existsSync(target)) {
    fs.symlinkSync(source, target, process.platform === 'win32' ? 'junction' : 'dir');
  }
}
for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
  if (!entry.isFile() || !/^(?:\.env(?:\..+)?|\.(?:s3-storage\.json|giphy-api-key|deepgram-api-key|deepgram-keyterms|groq-[\w-]+|livekit-[\w.-]+|turn-user|turn-pass))$/.test(entry.name)) continue;
  const source = path.join(root, entry.name);
  const target = path.join(site, entry.name);
  if (!fs.existsSync(target)) fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
}
