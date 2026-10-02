import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { once } from 'node:events';

const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
      key,
      /authorization|api[_-]?key|token|secret|password|cookie/i.test(key) ? '[REDACTED]' : redact(entry),
    ]));
  }
  if (typeof value === 'string') {
    return value
      .replace(/\b(Bearer\s+)\S+/gi, '$1[REDACTED]')
      .replace(/\b(sk-[A-Za-z0-9_-]{8,})\b/g, '[REDACTED]')
      .replace(/\b((?:api[_-]?key|access[_-]?token|token|secret|password|cookie)\s*[:=]\s*["']?)[^\s,"'&}]+/gi, '$1[REDACTED]');
  }
  return value;
}

function safePath(value) {
  const url = new URL(value || '/', 'http://trace-proxy.invalid');
  for (const key of url.searchParams.keys()) {
    if (/authorization|api[_-]?key|token|secret|password|cookie/i.test(key)) url.searchParams.set(key, '[REDACTED]');
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

function collect(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', chunk => chunks.push(Buffer.from(chunk)));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

function parseBody(buffer) {
  const text = buffer.toString('utf8');
  try { return redact(JSON.parse(text)); } catch { return redact(text); }
}

/** A local OpenAI-compatible forwarding proxy that records one JSONL exchange per call. */
export async function startModelTraceProxy({ targetBaseUrl, tracePath, stage, issue = '', provider = '', model = '', maxBytes = DEFAULT_MAX_BYTES }) {
  let nextSequence = 0;
  let writtenBytes = 0;
  let traceDisabled = false;
  fs.mkdirSync(path.dirname(tracePath), { recursive: true });
  fs.rmSync(tracePath, { force: true });

  const server = http.createServer(async (incoming, outgoing) => {
    const sequence = ++nextSequence;
    const timestamp = new Date().toISOString();
    const started = Date.now();
    let requestBody = Buffer.alloc(0);
    let status = null;
    let responseBody = Buffer.alloc(0);
    let error = null;
    let transportError = false;
    try {
      requestBody = await collect(incoming);
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
      const response = await fetch(target, {
        method: incoming.method,
        headers,
        body: ['GET', 'HEAD'].includes(incoming.method) ? undefined : requestBody,
        signal: AbortSignal.timeout(20 * 60 * 1000),
      });
      status = response.status;
      if (!response.ok) error = { name: 'HttpError', message: `Model endpoint returned HTTP ${response.status}` };
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
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
      status = 502;
      error = { name: cause?.name || 'Error', message: redact(String(cause?.message || cause)) };
      if (!outgoing.headersSent) outgoing.writeHead(502, { 'content-type': 'application/json' });
      if (!outgoing.destroyed) outgoing.end(JSON.stringify({ error: { message: 'Model request failed' } }));
    }

    const record = {
      sequence,
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
    const line = `${JSON.stringify(record)}\n`;
    const bytes = Buffer.byteLength(line);
    if (!traceDisabled && writtenBytes + bytes <= maxBytes) {
      try {
        fs.appendFileSync(tracePath, line, { encoding: 'utf8', mode: 0o600 });
        writtenBytes += bytes;
      } catch { traceDisabled = true; }
    } else if (!traceDisabled) {
      traceDisabled = true;
      try {
        const marker = `${JSON.stringify({ sequence, timestamp: new Date().toISOString(), stage, issue: issue || null, traceLimitReached: true, maxBytes })}\n`;
        fs.appendFileSync(tracePath, marker, { encoding: 'utf8', mode: 0o600 });
      } catch { /* Tracing is best effort; never fail a model call for a disk error. */ }
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
