const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');

async function isMaikoServer(url) {
  try {
    const response = await fetch(new URL('/api/health', url), { signal: AbortSignal.timeout(1500) });
    if (!response.ok) return false;
    const body = await response.json();
    return body.ok === true && body.service === 'pulse';
  } catch { return false; }
}

function portAvailable(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

async function startLocalServer({ root, port, utilityProcess, onLog, dev = false }) {
  const url = `http://127.0.0.1:${port}`;
  if (await isMaikoServer(url)) return { url, owned: false, stop: async () => {} };
  if (!(await portAvailable(port))) throw new Error(`Порт ${port} занят другим приложением. Освободите его или измените localPort в desktop/config.json.`);
  if (!fs.existsSync(path.join(root, 'node_modules', 'tsx', 'dist', 'cjs', 'index.cjs'))) {
    throw new Error('Зависимости сайта не установлены. Выполните npm ci --prefix site в корне проекта.');
  }
  const production = !dev && fs.existsSync(path.join(root, '.next', 'BUILD_ID'));
  const child = utilityProcess.fork(path.join(__dirname, 'server-entry.cjs'), [root], {
    cwd: root,
    env: { ...process.env, NODE_ENV: production ? 'production' : 'development', PORT: String(port), PULSE_HOST: '127.0.0.1', SEED_DEMO: '0' },
    stdio: 'pipe',
    serviceName: 'Maiko local server',
  });
  let exited = false;
  let exitCode;
  child.once('exit', (code) => { exited = true; exitCode = code; });
  child.stdout?.on('data', (data) => onLog(data.toString()));
  child.stderr?.on('data', (data) => onLog(data.toString()));
  const stop = async () => {
    if (exited) return;
    await new Promise((resolve) => {
      const timer = setTimeout(() => { child.kill(); resolve(); }, 4000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      try { child.postMessage('shutdown'); }
      catch { child.kill(); clearTimeout(timer); resolve(); }
    });
  };
  try {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      if (exited) throw new Error(`Локальный сервер завершился (код ${exitCode}). Подробности в desktop.log.`);
      if (await isMaikoServer(url)) return { url, owned: true, stop };
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    throw new Error('Сервер не успел запуститься. Подробности в desktop.log.');
  } catch (error) { await stop(); throw error; }
}

module.exports = { startLocalServer, isMaikoServer };
