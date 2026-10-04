import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';

const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;
const CREDENTIAL_FIELDS = new Set([
  'authorization', 'proxy_authorization', 'api_key', 'apikey', 'x_api_key',
  'password', 'passwd', 'client_secret', 'secret', 'cookie', 'set_cookie', 'token',
]);

function isCredentialField(key) {
  const normalized = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().replace(/[\s-]+/g, '_');
  return CREDENTIAL_FIELDS.has(normalized) || normalized.endsWith('_token');
}

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
      key,
      isCredentialField(key) ? '[REDACTED]' : redact(entry),
    ]));
  }
  if (typeof value === 'string') {
    return value
      .replace(/\b(Bearer\s+)\S+/gi, '$1[REDACTED]')
      .replace(/\b(sk-[A-Za-z0-9_-]{8,})\b/g, '[REDACTED]')
      .replace(/\b((?:access|refresh|id|auth|oauth|session|bearer)[_-]?token|[a-z0-9_-]+[_-]token|api[_-]?key|x-api-key|authorization|client[_-]?secret|password|passwd|cookie)(\s*[:=]\s*["']?)[^\s,"'&}]+/gi, '$1$2[REDACTED]');
  }
  return value;
}

function safePath(value) {
  const url = new URL(value || '/', 'http://trace-proxy.invalid');
  for (const key of url.searchParams.keys()) {
    if (isCredentialField(key)) url.searchParams.set(key, '[REDACTED]');
  }
  return `${url.pathname}${url.search}`;
}

function safeUrl(value) {
  const url = new URL(value);
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  return url.toString();
}

function collect(stream, signal) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const cleanup = () => {
      stream.off('data', onData);
      stream.off('end', onEnd);
      stream.off('error', onError);
      signal.removeEventListener('abort', onAbort);
    };
    const onData = chunk => chunks.push(Buffer.from(chunk));
    const onEnd = () => { cleanup(); resolve(Buffer.concat(chunks)); };
    const onError = error => { cleanup(); reject(error); };
    const onAbort = () => { cleanup(); reject(signal.reason || new Error('Client disconnected')); };
    stream.on('data', onData);
    stream.once('end', onEnd);
    stream.once('error', onError);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

const HOP_BY_HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-encoding',
  'content-length', 'content-md5',
]);

function responseHeaders(headers) {
  const excluded = new Set(HOP_BY_HOP_HEADERS);
  for (const name of (headers.get('connection') || '').split(',')) {
    if (name.trim()) excluded.add(name.trim().toLowerCase());
  }
  return Object.fromEntries([...headers].filter(([name]) => !excluded.has(name.toLowerCase())));
}

function parseBody(buffer) {
  const text = buffer.toString('utf8');
  try { return redact(JSON.parse(text)); } catch { return redact(text); }
}

/** A local OpenAI-compatible forwarding proxy that records one JSONL exchange per call. */
export async function startModelTraceProxy({ targetBaseUrl, tracePath, stage, issue = '', provider = '', model = '', maxBytes = DEFAULT_MAX_BYTES, traceSession = randomUUID(), onExchange = null }) {
  let nextSequence = 0;
  let writtenBytes = 0;
  let traceDisabled = false;
  try {
    fs.mkdirSync(path.dirname(tracePath), { recursive: true });
    fs.rmSync(tracePath, { force: true });
  } catch { traceDisabled = true; }

  const server = http.createServer(async (incoming, outgoing) => {
    const sequence = ++nextSequence;
    const timestamp = new Date().toISOString();
    const started = Date.now();
    let requestBody = Buffer.alloc(0);
    let status = null;
    let responseBody = Buffer.alloc(0);
    let error = null;
    let transportError = false;
    const controller = new AbortController();
    const disconnectError = Object.assign(new Error('Client disconnected'), { name: 'AbortError' });
    const abortOnRequestClose = () => { if (!incoming.complete) controller.abort(disconnectError); };
    const abortOnClientClose = () => { if (!outgoing.writableEnded) controller.abort(disconnectError); };
    const abortOnError = error => { if (!controller.signal.aborted) controller.abort(error); };
    incoming.on('aborted', abortOnRequestClose);
    incoming.on('close', abortOnRequestClose);
    incoming.on('error', abortOnError);
    outgoing.on('close', abortOnClientClose);
    outgoing.on('error', abortOnError);
    try {
      requestBody = await collect(incoming, controller.signal);
      const base = new URL(targetBaseUrl);
      const requestUrl = new URL(incoming.url || '/', 'http://trace-proxy.invalid');
      const basePath = base.pathname.replace(/\/$/, '');
      const target = new URL(base.origin);
      target.pathname = requestUrl.pathname.startsWith(`${basePath}/`) || requestUrl.pathname === basePath
        ? requestUrl.pathname
        : `${basePath}${requestUrl.pathname}`;
      target.search = requestUrl.search || base.search;
      const headers = new Headers(incoming.headers);
      headers.delete('host');
      headers.delete('content-length');
      for (const name of ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']) headers.delete(name);
      for (const name of (incoming.headers.connection || '').split(',')) if (name.trim()) headers.delete(name.trim());
      const response = await fetch(target, {
        method: incoming.method,
        headers,
        body: ['GET', 'HEAD'].includes(incoming.method) ? undefined : requestBody,
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20 * 60 * 1000)]),
      });
      status = response.status;
      if (!response.ok) error = { name: 'HttpError', message: `Model endpoint returned HTTP ${response.status}` };
      outgoing.writeHead(response.status, responseHeaders(response.headers));
      const chunks = [];
      if (response.body) {
        for await (const chunk of response.body) {
          const bytes = Buffer.from(chunk);
          chunks.push(bytes);
          if (!outgoing.write(bytes)) await once(outgoing, 'drain');
        }
      }
      responseBody = Buffer.concat(chunks);
      outgoing.end();
    } catch (cause) {
      transportError = true;
      const clientDisconnected = controller.signal.aborted && controller.signal.reason === disconnectError;
      status = clientDisconnected ? 499 : cause?.name === 'TimeoutError' ? 504 : 502;
      error = {
        name: clientDisconnected ? 'AbortError' : cause?.name || 'Error',
        message: redact(clientDisconnected ? 'Client disconnected' : String(cause?.message || cause)),
      };
      if (outgoing.headersSent) {
        outgoing.destroy();
      } else if (!outgoing.destroyed) {
        outgoing.writeHead(status, { 'content-type': 'application/json' });
        outgoing.end(JSON.stringify({ error: { message: 'Model request failed' } }));
      }
    } finally {
      incoming.off('aborted', abortOnRequestClose);
      incoming.off('close', abortOnRequestClose);
      incoming.off('error', abortOnError);
      outgoing.off('close', abortOnClientClose);
      outgoing.off('error', abortOnError);
    }

    const record = {
      sequence,
      traceSession,
      timestamp,
      stage,
      issue: issue || null,
      model: { provider, id: model, baseUrl: safeUrl(targetBaseUrl) },
      request: { method: incoming.method, path: safePath(incoming.url), body: parseBody(requestBody) },
      response: transportError ? null : parseBody(responseBody),
      status,
      elapsedMs: Date.now() - started,
      ...(error ? { error } : {}),
    };
    if (typeof onExchange === 'function') {
      try {
        onExchange({
          sequence: record.sequence,
          traceSession: record.traceSession,
          stage: record.stage,
          issue: record.issue,
          status: record.status,
          elapsedMs: record.elapsedMs,
          transportError,
        });
      } catch {
        // Provider accounting is best effort and must never affect model traffic.
      }
    }
    const line = `${JSON.stringify(record)}\n`;
    const bytes = Buffer.byteLength(line);
    const marker = `${JSON.stringify({ sequence, timestamp: new Date().toISOString(), stage, issue: issue || null, traceLimitReached: true, maxBytes })}\n`;
    const nextMarker = `${JSON.stringify({ sequence: sequence + 1, timestamp: new Date().toISOString(), stage, issue: issue || null, traceLimitReached: true, maxBytes })}\n`;
    const markerBytes = Buffer.byteLength(marker);
    const reservedMarkerBytes = Buffer.byteLength(nextMarker);
    if (!traceDisabled && writtenBytes + bytes + reservedMarkerBytes <= maxBytes) {
      try {
        fs.appendFileSync(tracePath, line, { encoding: 'utf8', mode: 0o600 });
        writtenBytes += bytes;
      } catch { traceDisabled = true; }
    } else if (!traceDisabled) {
      traceDisabled = true;
      if (writtenBytes + markerBytes <= maxBytes) {
        try { fs.appendFileSync(tracePath, marker, { encoding: 'utf8', mode: 0o600 }); }
        catch { /* Tracing is best effort; never fail a model call for a disk error. */ }
      }
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}${new URL(targetBaseUrl).pathname.replace(/\/$/, '')}`,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}
