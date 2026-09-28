import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

export function trivialRepoLookup(cwd, { extensions = [], exactText = '' }) {
  const normalized = extensions.map(value => String(value).replace(/^\./, '').toLowerCase()).filter(Boolean);
  const extensionRank = new Map(normalized.map((ext, index) => [ext, index]));
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
    .split('\0').filter(Boolean);
  const excluded = ['.github/', '.agents/', '.pi/', 'agents/', 'scripts/', 'infra/', 'tests/', 'node_modules/', '.venv/'];
  const legalNames = /^(?:licen[sc]e|copying|notice)(?:\.|$)/i;
  const candidates = [];
  const found = [];
  for (const relative of tracked) {
    const full = `${cwd}/${relative}`;
    let stat;
    try { stat = fs.statSync(full); } catch { continue; }
    if (!stat.isFile() || stat.size > 256 * 1024) continue;
    let text;
    try { text = fs.readFileSync(full, 'utf8'); } catch { continue; }
    if (exactText && text.includes(exactText)) found.push(relative);

    if (excluded.some(prefix => relative.startsWith(prefix))) continue;
    const basename = relative.split('/').at(-1) ?? relative;
    if (legalNames.test(basename)) continue;
    const ext = relative.includes('.') ? relative.split('.').pop().toLowerCase() : '';
    if (normalized.length && !extensionRank.has(ext)) continue;
    if (stat.size <= 20 * 1024) {
      const lastLine = text.split(/\r?\n/).map(line => line.trimEnd()).filter(Boolean).at(-1) ?? '';
      const pathRank = relative.startsWith('tasks/') ? 0 : relative.startsWith('docs/') ? 1 : 2;
      candidates.push({
        path: relative,
        size: stat.size,
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
    exactTextFound: found.length > 0,
    exactTextPaths: found.slice(0, 5),
  };
}
