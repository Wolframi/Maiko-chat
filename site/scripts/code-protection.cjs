const path = require('node:path');
const { createHash } = require('node:crypto');
const { obfuscate } = require('javascript-obfuscator');

function containsApplicationCode(module, sourceRoot) {
  if (module.resource && path.resolve(module.resource.split('?')[0]).startsWith(sourceRoot + path.sep)) return true;
  // Webpack's concatenated modules contain the original source modules.
  return module.modules && [...module.modules].some(child => containsApplicationCode(child, sourceRoot));
}

class CodeProtectionPlugin {
  constructor(projectRoot) { this.sourceRoot = path.join(projectRoot, 'src'); }

  apply(compiler) {
    const { Compilation, sources: { RawSource } } = compiler.webpack;
    compiler.hooks.thisCompilation.tap('MaikoCodeProtection', compilation => {
      compilation.hooks.processAssets.tap({
        name: 'MaikoCodeProtection', stage: Compilation.PROCESS_ASSETS_STAGE_OPTIMIZE_SIZE + 1,
      }, () => {
        const files = new Set();
        for (const chunk of compilation.chunks) {
          const modules = compilation.chunkGraph.getChunkModulesIterable(chunk);
          if (![...modules].some(module => containsApplicationCode(module, this.sourceRoot))) continue;
          for (const file of chunk.files) if (file.endsWith('.js')) files.add(file);
        }
        if (!files.size) throw new Error('Code protection did not find any browser application chunks');
        for (const file of files) {
          const asset = compilation.getAsset(file);
          const seed = createHash('sha256').update(file).digest().readUInt32LE() & 0x7fffffff || 1;
          const code = obfuscate(asset.source.source().toString(), {
            target: 'browser-no-eval', compact: true, seed,
            identifiersPrefix: 'p' + seed.toString(16),
            sourceMap: false, renameGlobals: false, renameProperties: false,
            controlFlowFlattening: false, deadCodeInjection: false,
            selfDefending: false, debugProtection: false, disableConsoleOutput: false,
            transformObjectKeys: false, splitStrings: false,
            stringArray: true, stringArrayEncoding: ['base64'],
            stringArrayThreshold: 0.5, stringArrayCallsTransform: false,
            ignoreImports: true,
          }).getObfuscatedCode();
          compilation.updateAsset(file, new RawSource(code), { ...asset.info, maikoProtected: true });
        }
        // Fail the build if a future config change starts publishing source maps.
        for (const { name } of compilation.getAssets()) {
          if (name.endsWith('.map')) throw new Error('Browser source maps must not be published: ' + name);
        }
      });
      compilation.hooks.processAssets.tap({
        name: 'MaikoCodeProtectionReport', stage: Compilation.PROCESS_ASSETS_STAGE_REPORT,
      }, () => {
        const files = {};
        for (const asset of compilation.getAssets()) {
          if (asset.info.maikoProtected) files[asset.name] = createHash('sha256').update(asset.source.source()).digest('hex');
        }
        compilation.emitAsset('code-protection.json', new RawSource(JSON.stringify({ schema: 1, files }, null, 2)));
        console.log(`Protected ${Object.keys(files).length} browser application chunks.`);
      });
    });
  }
}

module.exports = { CodeProtectionPlugin, containsApplicationCode };
