const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const asar = require('@electron/asar');
const root = __dirname;
const hash = data => createHash('sha256').update(data).digest('hex');

function verify(archive) {
  const report = JSON.parse(fs.readFileSync(path.join(root, '.protection-report.json'), 'utf8'));
  if (report.schema !== 1 || !report.bytecode.length || !report.renamedClasses) throw new Error('Missing code protection report');
  const entries = asar.listPackage(archive).map(name => name.replace(/\\/g, '/').replace(/^\//, ''));
  for (const name of entries) {
    if (name.startsWith('node_modules/') || name.startsWith('bundled-assets/')) continue;
    if (/\.(?:map|ts|tsx|cs|rs)$/.test(name) || /(?:^|\/)(?:tests|protection|\.protected)(?:\/|$)/.test(name) ||
      /(?:prepare-|protect-code|verify-|refresh-built|protection-report)/.test(name)) throw new Error('Source/build file leaked into app.asar: ' + name);
    if (/\.(?:cjs|jsc|js|css|html)$/.test(name) && !report.files[name]) throw new Error('Unprotected application code: ' + name);
  }
  for (const [name, expected] of Object.entries(report.files)) {
    if (hash(asar.extractFile(archive, name)) !== expected) throw new Error('Protected resource mismatch: ' + name);
  }
  for (const [name, expected] of Object.entries(report.sources)) {
    if (hash(fs.readFileSync(path.join(root, name))) !== expected) throw new Error('Protection is stale; rebuild: ' + name);
  }
  console.log(`Verified code protection: ${report.bytecode.length} bytecode modules; no original application sources or source maps.`);
  return report;
}

module.exports = async context => verify(path.join(context.appOutDir, 'resources/app.asar'));
module.exports.verify = verify;
if (require.main === module) verify(path.resolve(process.argv[2] || path.join(root, 'release/win-unpacked/resources/app.asar')));
