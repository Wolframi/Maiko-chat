const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
if (process.platform === 'win32') {
  const compiler = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  for (const name of ['window-processes', 'window-animations', 'refresh-shell-icons']) {
    const source = path.join(__dirname, `native/${name}.cs`);
    const output = path.join(__dirname, `native/${name}.exe`);
    if (!fs.existsSync(output) || fs.statSync(source).mtimeMs > fs.statSync(output).mtimeMs) {
      execFileSync(compiler, ['/nologo', '/target:exe', '/platform:x64', `/out:${output}`, source], { windowsHide: true, stdio: 'pipe' });
    }
  }
  console.log('Windows capture and window animation helpers prepared.');
}
