import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export async function verifyCodeProtection(directory = path.resolve('site/.next')) {
  const report = JSON.parse(await readFile(path.join(directory, 'code-protection.json'), 'utf8'));
  if (report.schema !== 1 || !Object.keys(report.files).length) throw new Error('Missing browser code protection report');
  for (const [name, expected] of Object.entries(report.files)) {
    const file = path.resolve(directory, name);
    if (!file.startsWith(path.resolve(directory) + path.sep)) throw new Error('Invalid protected chunk path');
    const code = await readFile(file);
    if (createHash('sha256').update(code).digest('hex') !== expected) throw new Error('Protected browser chunk mismatch: ' + name);
    if (/sourceMappingURL\s*=/.test(code.toString())) throw new Error('Source map reference in protected browser chunk: ' + name);
  }
  async function checkMaps(folder) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (entry.isDirectory()) await checkMaps(path.join(folder, entry.name));
      else if (entry.name.endsWith('.map')) throw new Error('Public source map: ' + entry.name);
    }
  }
  await checkMaps(path.join(directory, 'static'));
  console.log(`Verified ${Object.keys(report.files).length} protected browser chunks; no public source maps.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await verifyCodeProtection(path.resolve(process.argv[2] || '.next'));
}
