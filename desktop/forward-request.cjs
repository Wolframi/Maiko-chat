const FORBIDDEN_HEADERS = new Set(['content-length', 'host', 'trailer', 'te', 'upgrade', 'cookie2', 'keep-alive', 'transfer-encoding', 'connection']);

function responseHeaders(values) {
  const headers = new Headers();
  const encoding = values['content-encoding'];
  const decoded = encoding && String(encoding).toLowerCase() !== 'identity';
  for (const [name, entries] of Object.entries(values)) {
    // Chromium already decodes the response. The protocol supplies a fresh body.
    if (['content-encoding', 'transfer-encoding'].includes(name.toLowerCase()) || (name.toLowerCase() === 'content-length' && decoded)) continue;
    for (const entry of Array.isArray(entries) ? entries : [entries]) headers.append(name, entry);
  }
  return headers;
}

function forwardRequest(request, siteSession, net) {
  return new Promise((resolve, reject) => {
    let failBody;
    const headers = {};
    for (const [name, value] of request.headers) if (!FORBIDDEN_HEADERS.has(name.toLowerCase())) headers[name] = value;
    const outgoing = net.request({
      url: request.url, method: request.method, headers, session: siteSession,
      useSessionCookies: true, credentials: request.credentials,
      origin: request.initiatorOrigin || new URL(request.url).origin,
      bypassCustomProtocolHandlers: true, redirect: 'manual',
    });
    const fail = (error) => { failBody?.(error); reject(error); };
    outgoing.on('error', fail);
    outgoing.on('abort', () => fail(new Error('Network request aborted')));
    outgoing.on('redirect', (status, _method, _url, values) => {
      // Return the redirect to Chromium: navigation guards, URL changes and
      // replaying POST bodies remain the browser's responsibility.
      resolve(new Response(null, { status, headers: responseHeaders(values) }));
      outgoing.abort();
    });
    outgoing.on('response', (incoming) => {
      const status = incoming.statusCode;
      const bodyless = request.method === 'HEAD' || [204, 205, 304].includes(status);
      let ended = false;
      const body = bodyless ? null : new ReadableStream({
        start(controller) {
          failBody = (error) => { if (!ended) { ended = true; controller.error(error); } };
          incoming.on('end', () => { if (!ended) { ended = true; controller.close(); } });
          incoming.on('error', failBody);
          incoming.on('aborted', () => failBody(new Error('Response aborted')));
          incoming.on('data', (chunk) => { if (!ended) controller.enqueue(chunk); });
        },
        cancel() { ended = true; outgoing.abort(); },
      });
      if (bodyless) incoming.on('error', () => {});
      outgoing.once('close', () => { if (!ended && !bodyless) failBody(new Error('Response connection closed')); });
      resolve(new Response(body, { status, statusText: incoming.statusMessage, headers: responseHeaders(incoming.headers) }));
    });
    if (request.signal.aborted) { outgoing.abort(); reject(request.signal.reason); return; }
    const abort = () => outgoing.abort();
    request.signal.addEventListener('abort', abort, { once: true });
    outgoing.once('close', () => request.signal.removeEventListener('abort', abort));
    void (async () => {
      if (request.body) {
        outgoing.chunkedEncoding = true;
        for await (const chunk of request.body) outgoing.write(Buffer.from(chunk));
      }
      outgoing.end();
    })().catch((error) => { outgoing.abort(); reject(error); });
  });
}

module.exports = { forwardRequest };
