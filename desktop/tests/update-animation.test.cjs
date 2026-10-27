const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);

test('native update animation stays visible and moving beyond the first clip at normal and high DPI', { skip: process.platform !== 'win32' }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'maiko-animation-test-'));
  t.after(async () => {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('maiko-animation-test-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const compiler = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  const executable = path.join(directory, 'animation-test.exe');
  await run(compiler, ['/nologo', '/target:exe', '/platform:x64', '/optimize+', '/r:System.Drawing.dll',
    `/out:${executable}`, path.join(__dirname, 'fixtures/update-animation.cs'), path.join(__dirname, '../native/maiko-animation.cs')], { windowsHide: true });
  const output = path.join(__dirname, '../test-output');
  await fs.mkdir(output, { recursive: true });
  const result = await run(executable, [path.join(__dirname, '../../site/public/models'), output], { windowsHide: true, timeout: 30000 });
  t.diagnostic(result.stdout.trim());
});
