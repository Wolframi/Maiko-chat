const path = require('node:path');

const TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webm': 'video/webm', '.mp4': 'video/mp4',
  '.bin': 'application/octet-stream', '.tflite': 'application/octet-stream', '.wasm': 'application/wasm',
  '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

function publicAsset(name) {
  return (!!TYPES[path.extname(name)] || path.basename(name) === 'LICENSE') && path.basename(name) !== 'sw.js' && !name.endsWith('.map');
}
function nextAsset(urlPath) {
  return /^\/_next\/static\/(?:chunks|media|[a-zA-Z0-9_-]+)\/[a-zA-Z0-9_./%-]+$/.test(urlPath)
    && !urlPath.includes('..') && ['.js', '.css', '.woff', '.woff2', '.png', '.jpg', '.svg'].includes(path.extname(urlPath));
}

module.exports = { TYPES, publicAsset, nextAsset };
