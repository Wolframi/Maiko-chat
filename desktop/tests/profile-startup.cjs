// Fresh application data per run; this does not flush the OS/driver disk cache.
const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');

async function main() {
  const count = Number(process.argv.find(value => /^--runs=/.test(value))?.split('=')[1] || 3);
  if (!Number.isInteger(count) || count < 1 || count > 20) throw new Error('Use --runs=1..20');
  const output = path.resolve(__dirname, '../../output/electron-startup', new Date().toISOString().replace(/[:.]/g, '-'));
  await fs.mkdir(output, { recursive: true });
  const server = http.createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end('<!doctype html><title>Startup profile</title><body>Ready</body>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const results = [];
  try {
    for (let run = 1; run <= count; run++) {
      const profile = path.join(output, `run-${run}.jsonl`);
      const env = { ...process.env, MAIKO_DESKTOP_TEST: '1', MAIKO_DESKTOP_PROFILE: profile,
        MAIKO_DESKTOP_USER_DATA: path.join(output, `user-${run}`),
        MAIKO_DESKTOP_URL: process.env.MAIKO_PROFILE_URL || `http://127.0.0.1:${server.address().port}/app` };
      delete env.ELECTRON_RUN_AS_NODE;
      const args = process.env.MAIKO_TEST_EXECUTABLE ? [] : [path.resolve(__dirname, '..')];
      const trace = path.join(output, `trace-${run}.json`);
      if (process.argv.includes('--trace')) args.push('--trace-startup=startup,gpu,gpu.angle,devtools.timeline,blink.user_timing,loading,toplevel', '--trace-startup-format=json',
        '--trace-startup-duration=60', `--trace-startup-file=${trace}`,
      );
      const launchedAt = Date.now();
      let app;
      try {
        app = await electron.launch({ executablePath: process.env.MAIKO_TEST_EXECUTABLE || require('electron'), args, env, timeout: 90000 });
        const attachedAt = Date.now();
        const shell = await app.firstWindow({ timeout: 90000 });
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
        await shell.waitForFunction(() => document.body.dataset.phase === 'ready', null, { timeout: 90000 });
        const readyAt = Date.now();
        const renderer = await shell.evaluate(() => ({
          navigation: performance.getEntriesByType('navigation').map(entry => entry.toJSON()),
          marks: performance.getEntriesByType('mark').map(({ name, startTime }) => ({ name, startTime })),
          timeOrigin: performance.timeOrigin, model: { ...document.querySelector('#startup-model').dataset },
        }));
        const gpu = await app.evaluate(async ({ app }) => ({
          features: app.getGPUFeatureStatus(), info: await app.getGPUInfo('basic'),
          metrics: app.getAppMetrics(),
        }));
        await shell.screenshot({ path: path.join(output, `ready-${run}.png`) });
        await app.evaluate(async ({ app }) => {
          const testRequire = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json');
          await testRequire('./startup-profile.cjs').flush();
        });
        const events = (await fs.readFile(profile, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
        const result = { run, launchedAt, attachedMs: attachedAt - launchedAt, readyMs: readyAt - launchedAt, events, renderer, gpu };
        results.push(result);
        await fs.writeFile(path.join(output, `run-${run}.json`), JSON.stringify(result, null, 2));
        console.log(JSON.stringify({ run, readyMs: result.readyMs, attachedMs: result.attachedMs,
          stages: events.map(({ event, at }) => ({ event, ms: at - launchedAt })), model: renderer.model }));
      } finally { await app?.close(); }
      // Chromium's startup trace is separate from contentTracing and flushes
      // on process exit. Stopping contentTracing cannot finish this recording.
      if (process.argv.includes('--trace')) await fs.stat(trace);
    }
  } finally { await new Promise(resolve => server.close(resolve)); }
  await fs.writeFile(path.join(output, 'summary.json'), JSON.stringify({
    environment: { node: process.version, platform: process.platform, cpu: os.cpus()[0]?.model }, results,
  }, null, 2));
  console.log(`Profile saved: ${output}`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
