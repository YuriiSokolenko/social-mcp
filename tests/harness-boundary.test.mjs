import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { projectConfig } from '../scripts/pi-common/project-config.mjs';

const manifest = JSON.parse(fs.readFileSync('docs/agent-harness/layers.json', 'utf8'));
const layers = ['harness-core', 'adapter-pi', 'adapter-mini-swe'];
const scripts = [...fs.readdirSync('scripts').filter(n => n.endsWith('.mjs')).map(n => `scripts/${n}`),
  ...fs.readdirSync('scripts/pi-common').filter(n => n.endsWith('.mjs')).map(n => `scripts/pi-common/${n}`)];

function executableCode(source) {
  let inBlockComment = false;
  return source.split('\n').map(line => {
    let rest = line;
    for (;;) {
      if (inBlockComment) {
        const end = rest.indexOf('*/');
        if (end < 0) return '';
        rest = rest.slice(end + 2);
        inBlockComment = false;
        continue;
      }
      const trimmed = rest.trimStart();
      if (trimmed.startsWith('//')) return '';
      if (!trimmed.startsWith('/*')) return rest;
      const end = trimmed.indexOf('*/', 2);
      if (end < 0) {
        inBlockComment = true;
        return '';
      }
      rest = trimmed.slice(end + 2);
    }
  }).join('\n');
}

function defaultBranchPatterns(branch) {
  const escaped = branch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [
    new RegExp(`\\borigin/${escaped}(?![\\w./-])`),
    new RegExp(`['"]${escaped}['"]`),
    new RegExp(`\\b(?:base|head|ref)=${escaped}(?![\\w./-])`),
    new RegExp(`\\b(?:refs/)?heads/${escaped}(?![\\w./-])`),
  ];
}

// Shell entrypoints are classified under extraction.move.infra; test *.sh files are fixtures.
// Keep shell quotes and command arguments, ignore comments and heredoc data.
// Evaluated shell in heredocs and eval/bash -c strings requires separate review.
function shellStatements(source) {
  const statements = [];
  let quote = null;
  let pending = [];
  let joined = '';
  let firstLine = 1;
  const lines = source.split(/\r?\n/);
  for (let number = 0; number < lines.length; number++) {
    const line = lines[number];
    if (pending.length) {
      const active = pending[0];
      if ((active.tabs ? line.replace(/^\t+/, '') : line) === active.delimiter) pending.shift();
      continue;
    }
    if (!joined) firstLine = number + 1;
    let fragment = '';
    let continued = false;
    const upcoming = [];
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quote) {
        fragment += ch;
        if (ch === '\\' && quote === '"' && i + 1 < line.length) fragment += line[++i];
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === '\\' && i === line.length - 1) { continued = true; break; }
      if (ch === '\\' && i + 1 < line.length) { fragment += ch + line[++i]; continue; }
      if (ch === '#' && (i === 0 || /[\s;|&({]/.test(line[i - 1]))) break;
      if (ch === "'" || ch === '"') { quote = ch; fragment += ch; continue; }
      if (ch === '<' && line[i + 1] === '<' && line[i + 2] !== '<') {
        const match = line.slice(i).match(/^<<(-?)[ \t]*(['"]?)([A-Za-z_]\w*)\2/);
        if (match) {
          upcoming.push({ delimiter: match[3], tabs: match[1] === '-' });
          fragment += match[0];
          i += match[0].length - 1;
          continue;
        }
      }
      fragment += ch;
    }
    joined += fragment;
    if (quote || continued) { joined += ' '; continue; }
    if (joined.trim()) statements.push({ line: firstLine, code: joined });
    joined = '';
    pending.push(...upcoming);
  }
  if (joined.trim()) statements.push({ line: firstLine, code: joined });
  return statements;
}

function shellBranchViolations(source, branch) {
  const escaped = branch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const end = '(?![\\w./-])';
  const rules = [
    ['remote ref', new RegExp(`\\borigin/${escaped}${end}`)],
    ['Git ref', new RegExp(`\\b(?:refs/(?:heads|remotes/origin)|heads)/${escaped}${end}`)],
    ['GitHub parameter', new RegExp(`\\b(?:base|head|ref)\\s*=\\s*['"]?${escaped}${end}`)],
    ['branch option', new RegExp(`(?:--(?:base|head|ref|branch)|-branches)(?:\\s+|=)\\s*['"]?${escaped}${end}`)],
  ];
  const gitCommand = /\bgit\b[^\n;]*?\b(?:checkout|switch|pull|push|fetch|clone|branch|merge|rebase|reset|rev-parse|worktree)\b[^\n;]*/g;
  const gitBranch = new RegExp(`(?:^|[\\s"'=])${escaped}${end}`);
  const violations = [];
  for (const { line, code } of shellStatements(source)) {
    // User-facing diagnostics are data, not Git/GitHub operations.
    if (/^\s*(?:echo|printf|log|die|usage)\b/.test(code) && !/(?:;|&&|\|\||\$\(|`)/.test(code)) continue;
    for (const [kind, rule] of rules) {
      if (rule.test(code)) violations.push({ line, kind });
    }
    for (const match of code.matchAll(gitCommand)) {
      if (gitBranch.test(match[0])) violations.push({ line, kind: 'Git branch command' });
    }
  }
  return violations;
}

test('every control-plane script is classified in exactly one layer and every entry exists', () => {
  const listed = layers.flatMap(layer => manifest[layer]);
  assert.deepEqual([...new Set(listed)].length, listed.length, 'a script appears in two layers');
  assert.deepEqual([...scripts].sort(), [...listed].sort());
  for (const file of listed) assert.ok(fs.existsSync(file), file);
});

test('harness scripts (core and adapters) hardcode no project identity, default branch, labels or workflow names', () => {
  const config = projectConfig();
  const forbidden = [
    /social-mcp/,
    ...Object.values(config.labels).map(label => new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))),
    ...Object.values(config.workflows).map(file => new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))),
    ...defaultBranchPatterns(config.git.defaultBranch),
  ];
  for (const file of layers.flatMap(layer => manifest[layer])) {
    if (file === 'scripts/pi-common/project-config.mjs') continue;
    const code = executableCode(fs.readFileSync(file, 'utf8'));
    for (const pattern of forbidden) assert.doesNotMatch(code, pattern, `${file} contains project policy ${pattern}`);
  }
});

test('default branch guard catches query/ref literals without matching comments', () => {
  const rules = defaultBranchPatterns('dev');
  for (const sample of [
    "const url = '/pulls?state=open&base=dev';",
    "const url = '/pulls?head=dev';",
    "const ref = '/git/refs/heads/dev';",
  ]) assert.ok(rules.some(rule => rule.test(executableCode(sample))), sample);
  for (const sample of [
    "// const url = '/pulls?base=dev';",
    "/* const ref = '/git/refs/heads/dev'; */",
    "const url = '/pulls?state=open&base=development';",
  ]) assert.equal(rules.some(rule => rule.test(executableCode(sample))), false, sample);
  const blockComment = [
    '/* ignore this block',
    " * const url = '/pulls?base=dev';",
    " */ const url = '/pulls?base=dev';",
  ].join('\n');
  assert.equal(rules.some(rule => rule.test(executableCode(blockComment))), true,
    'executable code after a block comment must not be removed');
  assert.equal(rules.some(rule => rule.test(executableCode("/* ignore base=dev */"))), false);
  assert.equal(executableCode("*generator() { return 42; }"), "*generator() { return 42; }");
});

test('project policy is reachable only through the config module', () => {
  const importers = scripts.filter(file => /project-config\.mjs/.test(fs.readFileSync(file, 'utf8')));
  assert.ok(importers.length > 10);
  assert.ok(path.basename(importers[0]));
});

// --- extraction boundary (docs/agent-harness/EXTRACTION.md) ---

const extraction = manifest.extraction;
const harnessCode = layers.flatMap(layer => manifest[layer]);
const classification = [
  ...harnessCode.map(entry => ({ entry, as: 'move' })),
  ...Object.values(extraction.move).flat().map(entry => ({ entry, as: 'move' })),
  ...Object.keys(extraction.split).map(entry => ({ entry, as: 'split' })),
  ...Object.keys(extraction.stay).map(entry => ({ entry, as: 'stay' })),
];
const covers = (entry, file) => entry.endsWith('/') ? file.startsWith(entry) : entry === file;

function trackedFiles(t) {
  const result = spawnSync('git', ['ls-files', '-z'], { encoding: 'utf8' });
  if (result.status !== 0) {
    t.skip('git ls-files is unavailable in this checkout');
    return null;
  }
  return result.stdout.split('\0').filter(Boolean);
}


test('tracked harness shell entrypoints respect configured git.defaultBranch', t => {
  const files = trackedFiles(t);
  if (!files) return;
  const shells = files.filter(file => /^(?:scripts|infra)\/.*\.sh$/.test(file));
  assert.ok(shells.includes('scripts/beelink-update-restart.sh'), 'Beelink entrypoint covered');
  assert.ok(shells.includes('infra/zoekt/update-index.sh'), 'Zoekt entrypoint covered');
  for (const file of shells) {
    const matches = classification.filter(({ entry }) => covers(entry, file));
    assert.equal(matches.length, 1, file + ' has one extraction classification');
    assert.equal(matches[0].as, 'move', file + ' is a harness or infra entrypoint');
    const violations = shellBranchViolations(fs.readFileSync(file, 'utf8'), projectConfig().git.defaultBranch);
    assert.deepEqual(violations, [], file + ': ' + JSON.stringify(violations));
  }
});

test('shell branch guard catches Git/GitHub args, refs, and line continuations', () => {
  const branch = projectConfig().git.defaultBranch;
  const positives = [
    'git checkout ' + branch,
    "git switch '" + branch + "'",
    'git -C "$checkout" pull --ff-only origin ' + branch,
    'git fetch origin +refs/heads/' + branch + ':refs/heads/' + branch,
    'git rev-parse refs/remotes/origin/' + branch,
    'curl "https://api.github.com/repos/demo/pulls?base=' + branch + '"',
    'url="https://api.github.com/repos/demo/pulls?head=' + branch + '"',
    "gh pr create --base '" + branch + "'",
    'gh workflow run build.yml --ref="' + branch + '"',
    'zoekt-git-index -branches=' + branch,
    ['git checkout \\', '  ' + branch].join('\n'),
  ];
  for (const source of positives) {
    assert.notDeepEqual(shellBranchViolations(source, branch), [], 'should reject: ' + source);
  }
  const negatives = [
    '# git checkout ' + branch + '\n# curl "https://api.github.com/?base=' + branch + '"',
    'git switch "$DEFAULT_BRANCH" # git checkout ' + branch,
    'git fetch origin "refs/heads/$DEFAULT_BRANCH"',
    'git checkout ' + branch + '-candidate',
    'curl "https://api.github.com/?base=' + branch + 'elopment"',
    "echo 'Example: git checkout " + branch + "'",
    "printf 'target origin/" + branch + "\\n'",
    "cat <<'DOC'\ngit checkout " + branch + '\nbase=' + branch + '\nDOC',
    'cat <<-DOC\n\tgit fetch origin refs/heads/' + branch + '\nDOC',
  ];
  for (const source of negatives) {
    assert.deepEqual(shellBranchViolations(source, branch), [], 'should allow: ' + source);
  }
});

test('shell guard works against a non-dev configured base branch fixture', () => {
  const fixture = JSON.parse(fs.readFileSync('.agent-harness.json', 'utf8'));
  fixture.git.defaultBranch = 'release/v2';
  assert.notDeepEqual(shellBranchViolations('git switch release/v2', fixture.git.defaultBranch), []);
  assert.notDeepEqual(shellBranchViolations('curl "https://api.github.com/pulls?base=release/v2"', fixture.git.defaultBranch), []);
  assert.notDeepEqual(shellBranchViolations('git fetch origin +refs/heads/release/v2:refs/heads/release/v2', fixture.git.defaultBranch), []);
  assert.deepEqual(shellBranchViolations('git switch dev', fixture.git.defaultBranch), []);
  assert.deepEqual(shellBranchViolations('git switch "$DEFAULT_BRANCH"', fixture.git.defaultBranch), []);
});

test('inserting a GitHub query or Git ref in the covered Beelink script fails the guard', () => {
  const branch = projectConfig().git.defaultBranch;
  const script = fs.readFileSync('scripts/beelink-update-restart.sh', 'utf8');
  assert.deepEqual(shellBranchViolations(script, branch), []);
  const mutations = [
    '\ncurl "https://api.github.com/repos/example/pulls?base=' + branch + '"\n',
    '\ngit fetch origin refs/heads/' + branch + '\n',
  ];
  for (const mutation of mutations) {
    assert.notDeepEqual(shellBranchViolations(script + mutation, branch), [],
      'a new hardcoded branch in the Beelink entrypoint must fail');
  }
});

test('every workflow-related file is classified exactly once as move, split or stay', t => {
  const files = trackedFiles(t);
  if (!files) return;
  const scope = extraction.scope.map(source => new RegExp(source));
  const unclassified = [];
  const ambiguous = [];
  for (const file of files) {
    const matches = classification.filter(({ entry }) => covers(entry, file));
    if (matches.length > 1) ambiguous.push(`${file}: ${matches.map(match => `${match.as} ${match.entry}`).join(', ')}`);
    else if (!matches.length && scope.some(pattern => pattern.test(file))) unclassified.push(file);
  }
  assert.deepEqual(unclassified, [], 'add each new harness file to docs/agent-harness/layers.json (a layer, extraction.move, split or stay)');
  assert.deepEqual(ambiguous, []);
  for (const { entry } of classification) assert.ok(files.some(file => covers(entry, file)), `${entry} matches no tracked file`);
});

test('EXTRACTION.md lists every classified entry and every split or stay entry has a reason', () => {
  const doc = fs.readFileSync('docs/agent-harness/EXTRACTION.md', 'utf8');
  for (const { entry } of classification) assert.ok(doc.includes(`\`${entry}\``), `EXTRACTION.md inventory does not list ${entry}`);
  for (const [entry, reason] of [...Object.entries(extraction.split), ...Object.entries(extraction.stay)]) {
    assert.ok(String(reason).trim().length > 20, `${entry} needs a reason`);
  }
});

const IMPORT_SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)(['"])([^'"]+)\1/g;
const PRODUCT_REFERENCE = /YuriiSokolenko\/social-mcp|\bsocial_mcp\b|\bsrc\/social_mcp\b/;
// Private-network literals are infra wiring; loopback stays legal for in-process proxies and local executors.
const PRIVATE_HOST = /\b(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/;

test('harness code imports only harness code and names no product, repository or host', () => {
  const scriptsRoot = path.resolve('scripts');
  for (const file of harnessCode) {
    const code = fs.readFileSync(file, 'utf8');
    for (const [, , specifier] of code.matchAll(IMPORT_SPECIFIER)) {
      if (!specifier.startsWith('.') && !specifier.startsWith('/')) continue;
      const target = path.resolve(path.dirname(file), specifier);
      assert.ok(target.startsWith(`${scriptsRoot}${path.sep}`), `${file} imports ${specifier} outside the harness scripts`);
    }
    const live = executableCode(code);
    assert.doesNotMatch(live, PRODUCT_REFERENCE, `${file} names the product package or repository`);
    assert.doesNotMatch(live, PRIVATE_HOST, `${file} hardcodes a private host; read it from .agent-harness.json`);
  }
});

const HARNESS_REFERENCE = /scripts\/pi-|pi-common\/|\.agent-harness\b|agents\/[a-z]+\/AGENTS\.md|(?:^|[\s'"(/])\.pi\/|infra\/(?:github-runner-autoscaler|zoekt)|docs\/agent-harness|examples\/workflow-smoke/m;

test('product code, image, compose and product tests reference no harness file', t => {
  const files = trackedFiles(t);
  if (!files) return;
  const product = files.filter(file =>
    (file.startsWith('src/') || /^tests\/.+\.py$/.test(file) || ['Dockerfile', 'compose.yaml', '.dockerignore', '.env.example'].includes(file)) &&
    !classification.some(({ entry }) => covers(entry, file)));
  assert.ok(product.some(file => file.startsWith('src/')) && product.includes('Dockerfile'));
  for (const file of product) {
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), HARNESS_REFERENCE, `${file} depends on a harness file`);
  }
});
