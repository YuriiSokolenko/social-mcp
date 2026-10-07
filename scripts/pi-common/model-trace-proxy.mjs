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

function parsedProviderPayloads(value) {
  const text = Buffer.isBuffer(value) ? value.toString('utf8') : String(value ?? '');
  try { return [JSON.parse(text)]; } catch { /* SSE or non-JSON response */ }
  return text.split(/\r?\n/)
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trim())
    .filter(data => data && data !== '[DONE]')
    .flatMap(data => {
      try { return [JSON.parse(data)]; } catch { return []; }
    });
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function usageCandidate(payload) {
  return payload?.usage ?? payload?.response?.usage ?? payload?.data?.usage ?? null;
}

export function providerUsageTelemetry(value) {
  let promptTokens = null;
  let outputTokens = null;
  let cachedTokens = null;
  let cacheReported = false;
  for (const payload of parsedProviderPayloads(value)) {
    const usage = usageCandidate(payload);
    if (!usage || typeof usage !== 'object') continue;
    const prompt = nonNegativeInteger(usage.prompt_tokens) ?? nonNegativeInteger(usage.input_tokens);
    const output = nonNegativeInteger(usage.completion_tokens) ?? nonNegativeInteger(usage.output_tokens);
    if (prompt != null) promptTokens = prompt;
    if (output != null) outputTokens = output;
    const cacheCandidates = [
      usage?.prompt_tokens_details?.cached_tokens,
      usage?.input_tokens_details?.cached_tokens,
      usage?.cache_read_input_tokens,
      usage?.cached_tokens,
      usage?.cacheRead,
    ];
    for (const candidate of cacheCandidates) {
      const cached = nonNegativeInteger(candidate);
      if (cached != null) {
        cachedTokens = cached;
        cacheReported = true;
        break;
      }
    }
  }
  return {
    promptTokens,
    outputTokens,
    cachedTokens: cacheReported ? cachedTokens : null,
    cacheTelemetry: cacheReported ? 'reported' : 'unknown',
  };
}

function messageContentText(message) {
  if (typeof message?.content === 'string') return message.content;
  if (!Array.isArray(message?.content)) return '';
  return message.content.map(part => typeof part === 'string' ? part : String(part?.text ?? '')).join('\n');
}

export function classifyProviderRequest(body, stage) {
  if (stage !== 'implementer' || !body || typeof body !== 'object' || Array.isArray(body)) return null;
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const system = messages.filter(message => message?.role === 'system').map(messageContentText).join('\n');
  const firstUser = messages.find(message => message?.role === 'user');
  const user = messageContentText(firstUser);
  if (system.includes('<active_agent name="implementation-planner"/>')) return 'planner';
  if (system.includes('<coding_role_contract') || user.includes('<coding_role_contract')) return 'coding';
  if (user.includes('<role_contract source="agents/implementer/AGENTS.md">')) return 'main';
  return null;
}

function usableToolArguments(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const parsed = JSON.parse(value);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

function responsePayloads(buffer) {
  const text = buffer.toString('utf8');
  const payloads = [];
  let sawDone = false;
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter(line => /^data:/.test(line))
      .map(line => line.replace(/^data:\s?/, ''))
      .join('\n')
      .trim();
    if (!data) continue;
    if (data === '[DONE]') {
      sawDone = true;
      continue;
    }
    try { payloads.push(JSON.parse(data)); } catch { /* partial/non-JSON SSE event */ }
  }
  if (!payloads.length && text.trim()) {
    try { payloads.push(JSON.parse(text)); } catch { /* streamed/plain text response */ }
  }
  return { payloads, sawDone };
}

function hasUsableModelResponse(buffer) {
  if (!buffer?.length) return false;
  const { payloads, sawDone } = responsePayloads(buffer);
  const toolCalls = new Map();
  const toolState = key => {
    const state = toolCalls.get(key) ?? { name: '', arguments: '' };
    toolCalls.set(key, state);
    return state;
  };
  const updateTool = (key, name, args, { replaceArguments = false } = {}) => {
    const state = toolState(key);
    if (typeof name === 'string' && name) state.name ||= name;
    if (typeof args === 'string') state.arguments = replaceArguments ? args : state.arguments + args;
    return Boolean(state.name && usableToolArguments(state.arguments));
  };

  for (const payload of payloads) {
    for (const choice of Array.isArray(payload?.choices) ? payload.choices : []) {
      const choiceIndex = choice?.index ?? 0;
      for (const call of Array.isArray(choice?.delta?.tool_calls) ? choice.delta.tool_calls : []) {
        if (updateTool(
          `chat:${choiceIndex}:${call?.index ?? 0}`,
          call?.function?.name,
          call?.function?.arguments,
        )) return true;
      }
      for (const call of Array.isArray(choice?.message?.tool_calls) ? choice.message.tool_calls : []) {
        if (updateTool(
          `chat:${choiceIndex}:${call?.index ?? 0}`,
          call?.function?.name,
          call?.function?.arguments,
          { replaceArguments: true },
        )) return true;
      }
      if (choice?.finish_reason != null) return true;
    }

    const item = payload?.item;
    const responseKey = `response:${payload?.output_index ?? item?.id ?? payload?.item_id ?? 0}`;
    if (item?.type === 'function_call' && updateTool(
      responseKey,
      item?.name,
      item?.arguments,
      { replaceArguments: typeof item?.arguments === 'string' && item.arguments.length > 0 },
    )) return true;
    if (payload?.type === 'response.function_call_arguments.delta' &&
        updateTool(responseKey, payload?.name, payload?.delta)) return true;
    if (payload?.type === 'response.function_call_arguments.done' &&
        updateTool(responseKey, payload?.name, payload?.arguments, { replaceArguments: true })) return true;
    if (payload?.type === 'response.output_item.done' && item?.type === 'function_call' &&
        updateTool(responseKey, item?.name, item?.arguments, { replaceArguments: true })) return true;
    if (payload?.type === 'response.completed' || payload?.response?.status === 'completed') return true;
    if (payload?.type === 'message_stop') return true;
  }
  return sawDone;
}

/** A local OpenAI-compatible forwarding proxy that records one JSONL exchange per call. */
export async function startModelTraceProxy({ targetBaseUrl, tracePath, stage, issue = '', provider = '', model = '', maxBytes = DEFAULT_MAX_BYTES, traceSession = randomUUID(), onExchange = null, upstreamTimeoutMs = 20 * 60 * 1000 }) {
  let nextSequence = 0;
  const logicalSequences = new Map();
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
    const responseChunks = [];
    let error = null;
    let transportError = false;
    let streamShortCircuit = false;
    let usableResponseObserved = false;
    let clientSideFailure = false;
    let firstResponseByteAt = null;
    let logicalCall = null;
    let logicalResponse = null;
    const controller = new AbortController();
    const disconnectError = Object.assign(new Error('Client disconnected'), { name: 'AbortError' });
    const abortOnRequestClose = () => { if (!incoming.complete && !controller.signal.aborted) controller.abort(disconnectError); };
    const abortOnClientClose = () => { if (!outgoing.writableEnded && !controller.signal.aborted) controller.abort(disconnectError); };
    const abortOnClientError = cause => {
      clientSideFailure = true;
      if (!controller.signal.aborted) controller.abort(cause);
    };
    incoming.on('aborted', abortOnRequestClose);
    incoming.on('close', abortOnRequestClose);
    incoming.on('error', abortOnClientError);
    outgoing.on('close', abortOnClientClose);
    outgoing.on('error', abortOnClientError);
    try {
      requestBody = await collect(incoming, controller.signal);
      const parsedRequest = parseBody(requestBody);
      logicalCall = classifyProviderRequest(parsedRequest, stage);
      if (logicalCall) {
        logicalResponse = (logicalSequences.get(logicalCall) ?? 0) + 1;
        logicalSequences.set(logicalCall, logicalResponse);
      }
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
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(upstreamTimeoutMs)]),
      });
      status = response.status;
      if (!response.ok) error = { name: 'HttpError', message: `Model endpoint returned HTTP ${response.status}` };
      outgoing.writeHead(response.status, responseHeaders(response.headers));
      if (response.body) {
        for await (const chunk of response.body) {
          if (firstResponseByteAt == null) firstResponseByteAt = Date.now();
          const bytes = Buffer.from(chunk);
          responseChunks.push(bytes);
          if (outgoing.destroyed) {
            if (!controller.signal.aborted) controller.abort(disconnectError);
            throw disconnectError;
          }
          if (!outgoing.write(bytes)) {
            await Promise.race([
              once(outgoing, 'drain'),
              once(outgoing, 'close').then(() => {
                if (!controller.signal.aborted) controller.abort(disconnectError);
                throw disconnectError;
              }),
            ]);
          }
        }
      }
      responseBody = Buffer.concat(responseChunks);
      usableResponseObserved = hasUsableModelResponse(responseBody);
      outgoing.end();
    } catch (cause) {
      responseBody = Buffer.concat(responseChunks);
      usableResponseObserved = hasUsableModelResponse(responseBody);
      const cleanClientDisconnect = controller.signal.aborted && controller.signal.reason === disconnectError;
      const shortCircuit = cleanClientDisconnect &&
        Number.isInteger(status) && status >= 200 && status < 300 &&
        usableResponseObserved;
      if (shortCircuit) {
        streamShortCircuit = true;
        transportError = false;
        error = null;
      } else {
        transportError = true;
        const clientDisconnected = cleanClientDisconnect || clientSideFailure;
        status = clientDisconnected ? 499 : cause?.name === 'TimeoutError' ? 504 : 502;
        error = {
          name: clientDisconnected ? (cause?.name || 'AbortError') : cause?.name || 'Error',
          message: redact(cleanClientDisconnect ? 'Client disconnected' : String(cause?.message || cause)),
        };
        if (outgoing.headersSent) {
          outgoing.destroy();
        } else if (!outgoing.destroyed) {
          outgoing.writeHead(status, { 'content-type': 'application/json' });
          outgoing.end(JSON.stringify({ error: { message: 'Model request failed' } }));
        }
      }
    } finally {
      incoming.off('aborted', abortOnRequestClose);
      incoming.off('close', abortOnRequestClose);
      incoming.off('error', abortOnClientError);
      outgoing.off('close', abortOnClientClose);
      outgoing.off('error', abortOnClientError);
    }

    const telemetry = transportError
      ? { promptTokens: null, outputTokens: null, cachedTokens: null, cacheTelemetry: 'unknown' }
      : providerUsageTelemetry(responseBody);
    const ttftMs = firstResponseByteAt == null ? null : Math.max(0, firstResponseByteAt - started);
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
      transportError,
      streamDisposition: streamShortCircuit ? 'client_short_circuit' : transportError ? 'transport_error' : 'completed',
      streamShortCircuit,
      usableResponseObserved,
      elapsedMs: Date.now() - started,
      ttftMs,
      logicalCall,
      logicalResponse,
      telemetry,
      ...(error ? { error } : {}),
    };
    if (typeof onExchange === 'function') {
      try {
        onExchange({
          sequence: record.sequence,
          traceSession: record.traceSession,
          stage: record.stage,
          issue: record.issue,
          requestMethod: record.request.method,
          requestPath: record.request.path,
          status: record.status,
          elapsedMs: record.elapsedMs,
          ttftMs: record.ttftMs,
          logicalCall: record.logicalCall,
          logicalResponse: record.logicalResponse,
          promptTokens: record.telemetry.promptTokens,
          outputTokens: record.telemetry.outputTokens,
          cachedTokens: record.telemetry.cachedTokens,
          cacheTelemetry: record.telemetry.cacheTelemetry,
          transportError,
          streamDisposition: record.streamDisposition,
          streamShortCircuit: record.streamShortCircuit,
          usableResponseObserved: record.usableResponseObserved,
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
