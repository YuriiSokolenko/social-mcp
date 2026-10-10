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

const executableCode = source => source.split('\n')
  .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');

function defaultBranchPatterns(branch) {
  const escaped = branch.replace(/[.*+?^${}()|[\]\\]/g, '\\

test('every control-plane script is classified');
  return [
    new RegExp(`\\borigin/${escaped}(?![\\w./-])`),
    new RegExp(`['"]${escaped}['"]`),
    new RegExp(`\\b(?:base|head|ref)=${escaped}(?![\\w./-])`),
    new RegExp(`\\b(?:refs/)?heads/${escaped}(?![\\w./-])`),
  ];
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
    const live = code.split('\n').filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
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
