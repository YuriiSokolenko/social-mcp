import { execFileSync } from 'node:child_process';

const DEV_REF = 'origin/dev';

function devTrackedFiles(cwd) {
  const raw = execFileSync('git', ['ls-tree', '-r', '-l', '-z', DEV_REF], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
  return raw.split('\0').filter(Boolean).flatMap(record => {
    const tab = record.indexOf('\t');
    if (tab < 0) return [];
    const metadata = record.slice(0, tab).trim().split(/\s+/);
    const size = Number(metadata[3]);
    if (!Number.isSafeInteger(size) || size < 0) return [];
    return [{ relative: record.slice(tab + 1), size }];
  });
}

function readDevFile(cwd, relative) {
  try {
    return execFileSync('git', ['show', `${DEV_REF}:${relative}`], {
      cwd,
      encoding: 'utf8',
      maxBuffer: 512 * 1024,
    });
  } catch {
    return null;
  }
}

export function trivialRepoLookup(cwd, { extensions = [], exactText = '' }) {
  const normalized = extensions.map(value => String(value).replace(/^\./, '').toLowerCase()).filter(Boolean);
  const extensionRank = new Map(normalized.map((ext, index) => [ext, index]));
  const tracked = devTrackedFiles(cwd);
  const excluded = ['.github/', '.agents/', '.pi/', 'agents/', 'scripts/', 'infra/', 'tests/', 'node_modules/', '.venv/'];
  const legalNames = /^(?:licen[sc]e|copying|notice)(?:\.|$)/i;
  const candidates = [];
  const found = [];

  for (const { relative, size } of tracked) {
    if (size > 256 * 1024) continue;
    const text = readDevFile(cwd, relative);
    if (text == null) continue;
    if (exactText && text.includes(exactText)) found.push(relative);

    if (excluded.some(prefix => relative.startsWith(prefix))) continue;
    const basename = relative.split('/').at(-1) ?? relative;
    if (legalNames.test(basename)) continue;
    const ext = relative.includes('.') ? relative.split('.').pop().toLowerCase() : '';
    if (normalized.length && !extensionRank.has(ext)) continue;
    if (size <= 20 * 1024) {
      const lastLine = text.split(/\r?\n/).map(line => line.trimEnd()).filter(Boolean).at(-1) ?? '';
      const pathRank = relative.startsWith('tasks/') ? 0 : relative.startsWith('docs/') ? 1 : 2;
      candidates.push({
        path: relative,
        size,
        lastLine,
        extensionRank: extensionRank.get(ext) ?? normalized.length,
        pathRank,
      });
    }
  }

  candidates.sort((a, b) =>
    a.extensionRank - b.extensionRank ||
    a.pathRank - b.pathRank ||
    a.path.localeCompare(b.path)
  );

  return {
    candidate: candidates[0]
      ? { path: candidates[0].path, size: candidates[0].size, lastLine: candidates[0].lastLine }
      : null,
    exactTextFoundInDev: found.length > 0,
    exactTextPathsInDev: found.slice(0, 5),
  };
}
