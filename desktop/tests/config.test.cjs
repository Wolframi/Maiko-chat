const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeUrl, isSameOrigin, visibleBounds, findProjectRoot } = require('../config.cjs');
const { siteBounds } = require('../window-geometry.cjs');
const path = require('node:path');

test('server addresses allow HTTPS and local HTTP, rejecting executable schemes and credentials', () => {
  assert.equal(normalizeUrl(' https://example.com/chat#test '), 'https://example.com/chat');
  assert.equal(normalizeUrl('http://127.0.0.1:3000'), 'http://127.0.0.1:3000/');
  assert.equal(normalizeUrl('http://[::1]:3000'), 'http://[::1]:3000/');
  for (const value of ['file:///C:/Windows', 'javascript:alert(1)', 'http://example.com', 'https://user:secret@example.com', 'https://']) {
    assert.throws(() => normalizeUrl(value));
  }
  assert.equal(isSameOrigin('https://example.com/other', 'https://example.com/chat'), true);
  assert.equal(isSameOrigin('https://example.com.attacker.test', 'https://example.com'), false);
  assert.equal(isSameOrigin('http://127.0.0.1:3001', 'http://127.0.0.1:3000'), false);
});

test('a window from a disconnected monitor returns to a visible screen', () => {
  const displays = [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }];
  assert.deepEqual(visibleBounds({ x: 4000, y: 0, width: 900, height: 650 }, displays), { width: 900, height: 650 });
  assert.deepEqual(visibleBounds({ x: 50, y: 60, width: 900, height: 650 }, displays), { width: 900, height: 650, x: 50, y: 60 });
  assert.deepEqual(visibleBounds({ width: -1, height: 100000 }, displays), { width: 500, height: 2160 });
  assert.deepEqual(visibleBounds({ x: 50, y: 60, width: 500, height: 360 }, displays), { width: 500, height: 360, x: 50, y: 60 });
  assert.equal(findProjectRoot(__dirname), path.resolve(__dirname, '../../site'));
});

test('site layout reserves only the toolbar and fills the client area', () => {
  assert.deepEqual(siteBounds(1000, 700), { x: 0, y: 42, width: 1000, height: 658 });
});
