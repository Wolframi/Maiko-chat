// Manual integration check against the published feed. Uses an isolated
// profile/cache and explicitly forbids executing an installer.
const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { version } = require('../package.json');

async function main() {
  const previousVersion = process.env.MAIKO_TEST_PREVIOUS_VERSION || '1.1.13';
  const previousInstaller = process.env.MAIKO_TEST_PREVIOUS_INSTALLER || path.resolve(__dirname, `../release/Maiko-Setup-${previousVersion}.exe`);
  const output = path.resolve(__dirname, '../test-output', `updates-s3-${Date.now()}`);
  await fs.mkdir(output, { recursive: true });
  const server = http.createServer((_req, res) => res.end('<!doctype html><title>S3 update test</title><body>S3 update download verification</body>'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const env = { ...process.env, MAIKO_DESKTOP_TEST: '1', MAIKO_DESKTOP_USER_DATA: path.join(output, 'profile'), MAIKO_DESKTOP_URL: `http://127.0.0.1:${server.address().port}/` };
  delete env.ELECTRON_RUN_AS_NODE;
  let app;
  try {
    app = await electron.launch({ executablePath: process.env.MAIKO_TEST_EXECUTABLE || path.resolve(__dirname, '../release/win-unpacked/Maiko.exe'), args: [], env, timeout: 120_000 });
    app.context().setDefaultTimeout(300_000);
    const result = await app.evaluate(async ({ app }, { output, previousVersion, previousInstaller }) => {
      const require = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json');
      const path = require('node:path'), fs = require('node:fs/promises'), crypto = require('node:crypto');
      const root = app.getAppPath();
      const { NsisUpdater } = require(path.join(root, 'node_modules/electron-updater'));
      const semver = require(path.join(root, 'node_modules/semver'));
      const updater = new NsisUpdater();
      updater.autoDownload = false; updater.autoInstallOnAppQuit = false;
      updater.disableWebInstaller = true; updater.disableDifferentialDownload = false;
      updater.doInstall = () => { throw new Error('Installer execution is forbidden in this test'); };
      updater.currentVersion = semver.parse(previousVersion);
      Object.defineProperty(updater.app, 'version', { get: () => previousVersion });
      Object.defineProperty(updater.app, 'baseCachePath', { get: () => path.join(output, 'cache') });
      updater._testOnlyOptions = { platform: 'win32', isUseDifferentialDownload: true };
      const logs = [];
      updater.logger = { info: message => logs.push(String(message)), warn: message => logs.push(String(message)), error: message => logs.push(String(message)), debug() {} };
      updater.on('error', () => {});
      const helper = await updater.getOrCreateDownloadHelper();
      await fs.mkdir(helper.cacheDir, { recursive: true });
      await fs.copyFile(previousInstaller, path.join(helper.cacheDir, 'installer.exe'));
      const check = await updater.checkForUpdates();
      if (!check.isUpdateAvailable) throw new Error('A newer release must be published before this test');
      const [downloaded] = await updater.downloadUpdate();
      const digest = crypto.createHash('sha512').update(await fs.readFile(downloaded)).digest('base64');
      const verified = digest === check.updateInfo.sha512;
      if (!verified) throw new Error('Downloaded installer SHA-512 mismatch');
      return { version: check.updateInfo.version, verified, differential: !logs.some(line => line.includes('fallback to full download')),
        savings: logs.find(line => line.startsWith('Full:')), installationDisabled: !updater.autoInstallOnAppQuit };
    }, { output, previousVersion, previousInstaller });
    assert.equal(result.version, version); assert.equal(result.verified, true);
    assert.equal(result.differential, true); assert.equal(result.installationDisabled, true);
    await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
    console.log(`Published S3 update verified with the real electron-updater: ${JSON.stringify(result)}`);
  } finally {
    if (app) await app.close();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
