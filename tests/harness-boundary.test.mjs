import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { projectConfig } from '../scripts/pi-common/project-config.mjs';

const manifest = JSON.parse(fs.readFileSync('docs/agent-harness/layers.json', 'utf8'));
const layers = ['harness-core', 'adapter-pi', 'adapter-mini-swe'];
const scripts = [...fs.readdirSync('scripts').filter(n => n.endsWith('.mjs')).map(n => `scripts/${n}`),
  ...fs.readdirSync('scripts/pi-common').filter(n => n.endsWith('.mjs')).map(n => `scripts/pi-common/${n}`)];

test('every control-plane script is classified in exactly one layer and every entry exists', () => {
  const listed = layers.flatMap(layer => manifest[layer]);
  assert.deepEqual([...new Set(listed)].length, listed.length, 'a script appears in two layers');
  assert.deepEqual([...scripts].sort(), [...listed].sort());
  for (const file of listed) assert.ok(fs.existsSync(file), file);
});

test('harness scripts hardcode no project identity, default branch, labels or workflow names', () => {
  const config = projectConfig();
  const forbidden = [
    /social-mcp/,
    ...Object.values(config.labels).map(label => new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))),
    ...Object.values(config.workflows).map(file => new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))),
    /origin\/dev\b/,
    /['"]dev['"]/,
  ];
  for (const file of [...manifest['harness-core'], ...manifest['adapter-mini-swe']]) {
    if (file === 'scripts/pi-common/project-config.mjs') continue;
    const code = fs.readFileSync(file, 'utf8')
      .split('\n').filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
    for (const pattern of forbidden) assert.doesNotMatch(code, pattern, `${file} contains project policy ${pattern}`);
  }
});

test('project policy is reachable only through the config module', () => {
  const importers = scripts.filter(file => /project-config\.mjs/.test(fs.readFileSync(file, 'utf8')));
  assert.ok(importers.length > 10);
  assert.ok(path.basename(importers[0]));
});
