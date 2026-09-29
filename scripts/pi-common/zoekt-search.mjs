const DEFAULT_MAX_RESULTS = 20;
const HARD_MAX_RESULTS = 50;
const DEFAULT_TIMEOUT_MS = 3000;

function positiveInteger(value, fallback, name) {
  const parsed = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function resultLimit(value) {
  const limit = positiveInteger(value, DEFAULT_MAX_RESULTS, 'maxResults');
  if (limit > HARD_MAX_RESULTS) throw new Error(`maxResults must be <= ${HARD_MAX_RESULTS}`);
  return limit;
}

function normalizePrefix(value) {
  const prefix = String(value ?? '').trim().replace(/^\.\//, '');
  if (!prefix) return '';
  if (prefix.startsWith('/') || prefix.split('/').includes('..')) {
    throw new Error('pathPrefix must be repository-relative without .. segments');
  }
  return prefix;
}

function normalizeExtensions(values) {
  return [...new Set((values ?? [])
    .map(value => String(value).trim().replace(/^\./, '').toLowerCase())
    .filter(Boolean))];
}

function regexLiteral(value) {
  return String(value).replace(/[.*+?^\${}()|[\]\\]/g, '\\$&');
}

function quotedRegexLiteral(value) {
  return `"${regexLiteral(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function buildFileFilter(pathPrefix, extensions) {
  const filters = [];
  if (pathPrefix) {
    const normalized = pathPrefix.endsWith('/') ? pathPrefix : `${pathPrefix}/`;
    filters.push(`file:"^${regexLiteral(normalized)}"`);
  }
  if (extensions.length === 1) {
    filters.push(`file:"\\.${regexLiteral(extensions[0])}$"`);
  } else if (extensions.length > 1) {
    filters.push(`file:"\\.(?:${extensions.map(regexLiteral).join('|')})$"`);
  }
  return filters;
}

export function buildZoektQuery({
  kind = 'content',
  query,
  pathPrefix = '',
  extensions = [],
  repository = '',
}) {
  if (!['content', 'path', 'symbol'].includes(kind)) {
    throw new Error('kind must be content, path, or symbol');
  }
  const needle = String(query ?? '');
  if (!needle || needle.length > 300) throw new Error('query must contain 1-300 characters');

  const prefix = normalizePrefix(pathPrefix);
  const extensionList = normalizeExtensions(extensions);
  const parts = [];

  // Repo filters are regular expressions; quoting them makes the anchors
  // literal and causes an otherwise valid query to return no repositories.
  if (repository) parts.push(`repo:^${regexLiteral(repository)}$`);
  parts.push(...buildFileFilter(prefix, extensionList));

  if (kind === 'content') parts.push(`case:yes content:${quotedRegexLiteral(needle)}`);
  else if (kind === 'path') parts.push(`type:filename file:${quotedRegexLiteral(needle)}`);
  else parts.push(`case:yes sym:${quotedRegexLiteral(needle)}`);

  return parts.join(' ');
}

function decodeBytes(value) {
  if (typeof value !== 'string' || value === '') return '';
  try {
    return Buffer.from(value, 'base64').toString('utf8').replace(/\r?\n$/, '');
  } catch {
    return value;
  }
}

function normalizeResponse(json, { kind, query, maxResults }) {
  // Zoekt's JSON API wraps the SearchResult inside SearchResponse.Result.
  // Accept a top-level Files array too for older versions and lightweight mocks.
  const result = json?.Result ?? json;
  const files = Array.isArray(result?.Files) ? result.Files : [];
  const matches = [];

  for (const file of files) {
    const path = String(file?.FileName ?? '');
    const version = String(file?.Version ?? '');
    const repository = String(file?.Repository ?? '');

    if (kind === 'path') {
      if (path) matches.push({ path, version, repository });
      if (matches.length >= maxResults) break;
      continue;
    }

    const lines = Array.isArray(file?.LineMatches) ? file.LineMatches : [];
    if (lines.length === 0 && path) {
      matches.push({ path, version, repository });
    } else {
      for (const line of lines) {
        matches.push({
          path,
          line: Number(line?.LineNumber ?? 0) || undefined,
          text: decodeBytes(line?.Line),
          version,
          repository,
        });
        if (matches.length >= maxResults) break;
      }
    }
    if (matches.length >= maxResults) break;
  }

  return {
    backend: 'zoekt',
    kind,
    query,
    matches,
    truncated: matches.length >= maxResults,
  };
}

export async function zoektSearch({
  endpoint,
  repository = '',
  timeoutMs = DEFAULT_TIMEOUT_MS,
  ...params
}, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable');
  const base = String(endpoint ?? '').trim().replace(/\/$/, '');
  if (!/^https?:\/\//.test(base)) throw new Error('Zoekt endpoint must be an http(s) URL');

  const maxResults = resultLimit(params.maxResults);
  const kind = params.kind ?? 'content';
  const query = String(params.query ?? '');
  const q = buildZoektQuery({ ...params, kind, query, repository });
  const timeout = positiveInteger(timeoutMs, DEFAULT_TIMEOUT_MS, 'timeoutMs');

  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort(new DOMException(`Zoekt search timed out after ${timeout} ms`, 'TimeoutError'));
  }, timeout);

  try {
    const response = await fetchImpl(`${base}/api/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        Q: q,
        Opts: {
          MaxDocDisplayCount: maxResults,
          MaxMatchDisplayCount: maxResults,
          NumContextLines: 0,
        },
      }),
      signal: controller.signal,
    });

    if (!response.ok) throw new Error(`Zoekt search failed: HTTP ${response.status}`);
    return normalizeResponse(await response.json(), { kind, query, maxResults });
  } finally {
    clearTimeout(timeoutId);
  }
}
