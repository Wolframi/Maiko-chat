const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { forwardRequest } = require('../forward-request.cjs');

function fixture(headers = {}) {
  const incoming = Object.assign(new EventEmitter(), { statusCode: 200, statusMessage: 'OK', headers });
  const outgoing = Object.assign(new EventEmitter(), {
    end: () => queueMicrotask(() => outgoing.emit('response', incoming)),
    abort: () => { outgoing.emit('abort'); incoming.emit('aborted'); outgoing.emit('close'); },
  });
  const response = forwardRequest(new Request('https://maiko.test/uploads/document.pdf'), {}, { request: () => outgoing });
  return { incoming, outgoing, response };
}

test('uncompressed download size is forwarded; compressed size is omitted for the decoded body', async () => {
  for (const compressed of [false, true]) {
    const f = fixture({ 'content-type': ['application/pdf'], 'content-length': ['3'],
      ...(compressed ? { 'content-encoding': ['gzip'] } : {}) });
    const response = await f.response;
    assert.equal(response.headers.get('content-length'), compressed ? null : '3');
    assert.equal(response.headers.get('content-encoding'), null);
    f.incoming.emit('data', Buffer.from('pdf'));
    f.incoming.emit('end'); f.outgoing.emit('close');
    assert.equal(await response.text(), 'pdf');
  }
});

test('errors or premature closure after response headers fail the download body', async () => {
  for (const event of ['request-error', 'response-error', 'aborted', 'close']) {
    const f = fixture();
    const response = await f.response;
    f.incoming.emit('data', Buffer.from('partial'));
    const body = response.text();
    if (event === 'request-error') f.outgoing.emit('error', new Error('Offline'));
    else if (event === 'response-error') f.incoming.emit('error', new Error('Offline'));
    else if (event === 'aborted') f.incoming.emit('aborted');
    else f.outgoing.emit('close');
    await assert.rejects(body);
  }
});
