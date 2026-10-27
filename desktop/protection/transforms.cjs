const { createHash } = require('node:crypto');
const babel = require('@babel/core');
const postcss = require('postcss');
const selectors = require('postcss-selector-parser');
const { parse } = require('parse5');
const obfuscator = require('javascript-obfuscator');

const options = {
  compact: true, sourceMap: false, renameGlobals: false, renameProperties: false,
  controlFlowFlattening: false, deadCodeInjection: false, debugProtection: false,
  selfDefending: false, disableConsoleOutput: false, transformObjectKeys: false,
  splitStrings: false, stringArray: true, stringArrayEncoding: ['base64'],
  stringArrayThreshold: 0.75, stringArrayCallsTransform: false, ignoreImports: true,
};

function obfuscate(code, { node = false, portable = false, seed = 1, id = '' } = {}) {
  // Portable functions cross contextBridge's serialization boundary; worklets
  // also need to avoid decoders or helpers outside their own lexical context.
  return obfuscator.obfuscate(code, {
    ...options, target: node ? 'node' : 'browser-no-eval', seed,
    identifiersPrefix: 'p' + createHash('sha256').update(id).digest('hex').slice(0, 12),
    ...(portable ? { stringArray: false } : {}),
  }).getObfuscatedCode();
}

function withoutArrows(code) {
  return babel.transformSync(code, {
    configFile: false, babelrc: false, comments: false, sourceMaps: false,
    plugins: [require('@babel/plugin-transform-arrow-functions')],
  }).code;
}

function classMap(stylesheets, salt) {
  const names = new Set();
  for (const css of stylesheets) postcss.parse(css).walkRules(rule => {
    selectors(root => root.walkClasses(node => names.add(node.value))).processSync(rule.selector);
  });
  return new Map([...names].sort().map(name => [name,
    'c' + createHash('sha256').update(salt + ':' + name).digest('hex').slice(0, 12)]));
}

function renameSelector(value, names) {
  return selectors(root => root.walkClasses(node => {
    if (names.has(node.value)) node.value = names.get(node.value);
  })).processSync(value);
}

function renameClasses(value, names) {
  return value.replace(/[^\s]+/g, name => names.get(name) || name);
}

function renameCSS(css, names) {
  const root = postcss.parse(css);
  root.walkRules(rule => { rule.selector = renameSelector(rule.selector, names); });
  return root.toString();
}

function renameHTML(html, names) {
  const root = parse(html, { sourceCodeLocationInfo: true });
  const edits = [];
  function visit(node) {
    for (const attr of node.attrs || []) {
      if (attr.name !== 'class') continue;
      const loc = node.sourceCodeLocation.attrs.class;
      edits.push({ start: loc.startOffset, end: loc.endOffset,
        value: 'class="' + renameClasses(attr.value, names) + '"' });
    }
    for (const child of node.childNodes || []) visit(child);
    if (node.content) visit(node.content);
  }
  visit(root);
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    html = html.slice(0, edit.start) + edit.value + html.slice(edit.end);
  }
  return html;
}

function renameJS(code, names) {
  const t = babel.types;
  const property = node => t.isMemberExpression(node) && !node.computed && node.property.name;
  function literal(node, transform) {
    if (t.isStringLiteral(node)) { node.value = transform(node.value); delete node.extra; }
    else if (t.isConditionalExpression(node)) { literal(node.consequent, transform); literal(node.alternate, transform); }
    else if (t.isTemplateLiteral(node) && node.expressions.length === 0) {
      const value = transform(node.quasis[0].value.cooked);
      node.quasis[0].value = { cooked: value, raw: value.replace(/[`\\$]/g, '\\$&') };
    } else throw new Error('Unsupported dynamic local CSS class expression; extend the protection transform first');
  }
  return babel.transformSync(code, {
    configFile: false, babelrc: false, sourceType: 'unambiguous', comments: false,
    plugins: [() => ({ visitor: {
      AssignmentExpression({ node }) {
        if (property(node.left) === 'className') literal(node.right, value => renameClasses(value, names));
        if (property(node.left) === 'innerHTML' && t.isStringLiteral(node.right)) {
          literal(node.right, value => renameHTML(value, names));
        }
      },
      CallExpression({ node }) {
        const method = property(node.callee);
        if (!method) return;
        if (['querySelector', 'querySelectorAll', 'closest', 'matches'].includes(method)) {
          literal(node.arguments[0], value => renameSelector(value, names));
        } else if (method === 'getElementsByClassName') {
          literal(node.arguments[0], value => renameClasses(value, names));
        } else if (property(node.callee.object) === 'classList') {
          const args = method === 'replace' ? node.arguments.slice(0, 2)
            : method === 'toggle' || method === 'contains' ? node.arguments.slice(0, 1) : node.arguments;
          for (const arg of args) literal(arg, value => renameClasses(value, names));
        } else if (method === 'setAttribute' && t.isStringLiteral(node.arguments[0], { value: 'class' })) {
          literal(node.arguments[1], value => renameClasses(value, names));
        }
      },
    } })],
  }).code;
}

module.exports = { obfuscate, withoutArrows, classMap, renameCSS, renameHTML, renameJS };
