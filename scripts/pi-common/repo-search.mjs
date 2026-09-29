import { execFileSync } from 'node:child_process';

const DEFAULT_MAX_RESULTS = 20;
const HARD_MAX_RESULTS = 50;

function trackedFiles(cwd) {
  const raw = execFileSync('git', ['ls-files', '-z'], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  return raw.split('\0').filter(Boolean);
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
  return new Set((values ?? [])
    .map(value => String(value).trim().replace(/^\./, '').toLowerCase())
    .filter(Boolean));
}

function eligiblePath(relative, prefix, extensions) {
  if (prefix && relative !== prefix && !relative.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`)) return false;
  if (!extensions.size) return true;
  const name = relative.split('/').at(-1) ?? relative;
  const dot = name.lastIndexOf('.');
  return extensions.has(dot >= 0 ? name.slice(dot + 1).toLowerCase() : '');
}

function resultLimit(value) {
  if (value == null) return DEFAULT_MAX_RESULTS;
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > HARD_MAX_RESULTS) {
    throw new Error(`maxResults must be an integer from 1 to ${HARD_MAX_RESULTS}`);
  }
  return limit;
}

export function repoSearch(cwd, { kind = 'content', query, pathPrefix = '', extensions = [], maxResults }) {
  if (kind !== 'content' && kind !== 'path') throw new Error('kind must be content or path');
  const needle = String(query ?? '');
  if (!needle || needle.length > 300) throw new Error('query must contain 1-300 characters');

  const limit = resultLimit(maxResults);
  const prefix = normalizePrefix(pathPrefix);
  const extensionSet = normalizeExtensions(extensions);
  const files = trackedFiles(cwd).filter(relative => eligiblePath(relative, prefix, extensionSet));

  if (kind === 'path') {
    const all = files.filter(relative => relative.includes(needle));
    return { kind, query: needle, matches: all.slice(0, limit).map(path => ({ path })), truncated: all.length > limit };
  }

  const args = ['grep', '-n', '-I', '-F', '--no-color', '-e', needle, '--'];
  if (prefix) args.push(prefix);
  let raw = '';
  try {
    raw = execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    if (error?.status !== 1) throw error;
  }

  const allowed = new Set(files);
  const all = raw.split(/\r?\n/).filter(Boolean).flatMap(line => {
    const match = /^(.*?):(\d+):(.*)$/.exec(line);
    if (!match || !allowed.has(match[1])) return [];
    return [{ path: match[1], line: Number(match[2]), text: match[3].trimEnd() }];
  });
  return { kind, query: needle, matches: all.slice(0, limit), truncated: all.length > limit };
}
