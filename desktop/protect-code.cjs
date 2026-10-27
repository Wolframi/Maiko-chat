const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes, createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const babel = require('@babel/core');
const transforms = require('./protection/transforms.cjs');
const run = promisify(execFile);
const root = __dirname;
const output = path.join(root, '.protected');
const work = path.join(root, '.protected-work');
const reportFile = path.join(root, '.protection-report.json');
const plainModules = ['preload.cjs', 'site-preload.cjs', 'downloads-preload.cjs', 'server-entry.cjs'];
const localScripts = new Set(['shell.js', 'capture.js', 'status-text.js', 'downloads-panel.js']);
const localStyles = ['shell.css', 'downloads-panel.css'];
const hash = data => createHash('sha256').update(data).digest('hex');

async function clearGenerated(directory) {
  if (![output, work].includes(directory) || path.dirname(directory) !== root) throw new Error('Invalid protection directory');
  const stat = await fs.lstat(directory).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (stat?.isSymbolicLink()) throw new Error('Protection directory must not be a link');
  await fs.rm(directory, { recursive: true, force: true });
  await fs.mkdir(directory);
}

async function runtimeModules() {
  const modules = new Map();
  async function visit(name) {
    if (modules.has(name)) return;
    if (path.basename(name) !== name || !name.endsWith('.cjs')) throw new Error('Unexpected runtime module: ' + name);
    const code = await fs.readFile(path.join(root, name), 'utf8');
    modules.set(name, code);
    const dependencies = [];
    const ast = babel.parseSync(code, { configFile: false, babelrc: false });
    babel.traverse(ast, { CallExpression({ node }) {
      if (node.callee.type === 'Identifier' && node.callee.name === 'require' &&
        node.arguments[0]?.type === 'StringLiteral' && node.arguments[0].value.startsWith('./')) {
        dependencies.push(node.arguments[0].value.slice(2));
      }
    } });
    for (const dependency of dependencies) {
      if (dependency.endsWith('.cjs')) await visit(dependency);
      else if (!dependency.endsWith('.json')) throw new Error('Unprotected runtime dependency: ' + dependency);
    }
  }
  await visit('main.cjs');
  return modules;
}

async function prepare(context) {
  if (context && (context.electronPlatformName !== process.platform || context.arch !== 1 || process.arch !== 'x64')) {
    throw new Error('Protected releases must be built on the target platform using x64 Electron');
  }
  await clearGenerated(output);
  await clearGenerated(work);
  await fs.rm(reportFile, { force: true });
  const sources = {};
  const seed = randomBytes(4).readUInt32LE() & 0x7fffffff || 1;
  const salt = randomBytes(24).toString('hex');
  async function read(relative) {
    const content = await fs.readFile(path.join(root, relative));
    sources[relative] = hash(content);
    return content.toString('utf8');
  }
  async function save(relative, content) {
    const destination = path.join(output, relative);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, content);
  }
  try {
    const modules = await runtimeModules();
    for (const [name, code] of modules) {
      sources[name] = hash(code);
      const protectedCode = transforms.withoutArrows(transforms.obfuscate(transforms.withoutArrows(code), { node: true, seed, id: name }));
      await fs.writeFile(path.join(work, name), protectedCode);
    }
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    await run(require('electron'), [path.join(root, 'protection/compile.cjs'), work, output], {
      env, windowsHide: true, timeout: 120_000, maxBuffer: 2 * 1024 * 1024,
    });
    const runtime = JSON.parse(await fs.readFile(path.join(output, 'runtime.json'), 'utf8'));
    if (runtime.electron !== require('./package.json').devDependencies.electron) throw new Error('Electron compiler version does not match the pinned runtime');
    await fs.rm(path.join(output, 'runtime.json'));
    for (const name of modules.keys()) {
      const guard = name === 'main.cjs' ? `if(process.versions.electron!==${JSON.stringify(runtime.electron)}||process.arch!==${JSON.stringify(runtime.arch)}||process.platform!==${JSON.stringify(runtime.platform)})throw new Error('Protected build runtime mismatch. Rebuild with the pinned Electron.');\n` : '';
      await save(name, guard + `require('bytenode');module.exports=require('./${name.replace(/\.cjs$/, '.jsc')}');\n`);
    }
    for (const name of plainModules) await save(name, transforms.obfuscate(await read(name), {
      node: name === 'server-entry.cjs', portable: name === 'site-preload.cjs', seed, id: name,
    }));
    const names = transforms.classMap(await Promise.all(localStyles.map(name => read('ui/' + name))), salt);
    for (const entry of await fs.readdir(path.join(root, 'ui'), { withFileTypes: true })) {
      if (!entry.isFile() || !/\.(?:js|css|html)$/.test(entry.name)) throw new Error('Unexpected UI resource: ' + entry.name);
      const relative = 'ui/' + entry.name;
      let code = await read(relative);
      if (entry.name.endsWith('.js')) {
        if (localScripts.has(entry.name)) code = transforms.renameJS(code, names);
        code = transforms.obfuscate(code, { seed, id: relative, portable: /^(automatic-audio|daw-worklet)\.js$/.test(entry.name) });
      } else if (entry.name.endsWith('.html')) code = transforms.renameHTML(code, names);
      else {
        if (localStyles.includes(entry.name)) code = transforms.renameCSS(code, names);
        code = (await require('esbuild').transform(code, { loader: 'css', minify: true, legalComments: 'none' })).code;
      }
      await save(relative, code);
    }
    const files = {};
    async function inventory(directory, prefix = '') {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const relative = prefix + entry.name;
        if (entry.isDirectory()) await inventory(path.join(directory, entry.name), relative + '/');
        else files[relative] = hash(await fs.readFile(path.join(directory, entry.name)));
      }
    }
    await inventory(output);
    // Kept outside the packaged FileSet: no class-name dictionary or source map ships.
    await fs.writeFile(reportFile, JSON.stringify({ schema: 1, runtime, sources, files,
      bytecode: [...modules.keys()].map(name => name.replace(/\.cjs$/, '.jsc')), renamedClasses: names.size }, null, 2));
    console.log(`Protected ${modules.size} main modules, ${plainModules.length} preload/utility scripts and ${names.size} CSS classes.`);
  } finally { await clearGenerated(work); await fs.rmdir(work); }
}

module.exports = prepare;
module.exports.runtimeModules = runtimeModules;
if (require.main === module) prepare().catch(error => { console.error(error); process.exitCode = 1; });
