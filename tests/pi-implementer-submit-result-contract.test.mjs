import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { ProgressController } from '../scripts/pi-common/progress-controller.mjs';
import { stageConfig } from '../scripts/pi-common/stage-config.mjs';

const TYPEBOX_SCHEMA_LOADER = `export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'typebox') {
    const source = \`
      const optional = schema => ({ ...schema, __optional: true });
      export const Type = {
        String: (options = {}) => ({ type: 'string', ...options }),
        Boolean: (options = {}) => ({ type: 'boolean', ...options }),
        Literal: (value, options = {}) => ({ type: typeof value, const: value, ...options }),
        Array: (items, options = {}) => ({ type: 'array', items, ...options }),
        Optional: optional,
        Object: (properties, options = {}) => {
          const normalized = {};
          const required = [];
          for (const [name, schema] of Object.entries(properties)) {
            const { __optional, ...rest } = schema;
            normalized[name] = rest;
            if (!__optional) required.push(name);
          }
          return { type: 'object', properties: normalized, required, ...options };
        },
        Union: (anyOf, options = {}) => ({ anyOf, ...options }),
      };
    \`;
    return { url: 'data:text/javascript,' + encodeURIComponent(source), shortCircuit: true };
  }
  return nextResolve(specifier, context);
}`;

test('fresh submit_result schema requires every changed publication field and preserves alternate outcomes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-submit-result-schema-'));
  const loader = path.join(dir, 'loader.mjs');
  fs.writeFileSync(loader, TYPEBOX_SCHEMA_LOADER);

  try {
    const moduleUrl = new URL('../scripts/pi-implementer-result-tool.mjs', import.meta.url).href;
    const program = `
      import assert from 'node:assert/strict';
      const { default: register, CHANGED_PUBLICATION_FIELDS } = await import(${JSON.stringify(moduleUrl)});
      let tool;
      let settle;
      const pi = {
        registerTool(value) { tool = value; },
        appendEntry() {},
        on(event, fn) { if (event === 'agent_before_settle') settle = fn; },
      };
      register(pi);

      const variants = tool.parameters.anyOf;
      assert.equal(Array.isArray(variants), true);
      const changed = variants.find(item => item.required?.includes('title'));
      assert.deepEqual(changed.required, CHANGED_PUBLICATION_FIELDS);
      assert.equal(changed.properties.changes.minItems, 1);
      assert.equal(changed.properties.files.minItems, 1);
      assert.ok(variants.some(item => item.properties?.already_satisfied?.const === true));
      assert.ok(variants.some(item => item.required?.includes('blocked_reason')));

      const complete = {
        title: 'Contract fix',
        summary: 'Strengthen submit_result publication metadata.',
        changes: ['Require publication metadata'],
        files: ['scripts/pi-implementer-result-tool.mjs'],
        security_notes: 'No security impact.',
        limitations: 'None.',
      };
      for (const field of ['title', 'summary', 'files', 'security_notes', 'limitations']) {
        const invalid = { ...complete };
        delete invalid[field];
        await assert.rejects(
          tool.execute('missing-' + field, invalid),
          error => {
            assert.deepEqual(JSON.parse(error.message), {
              code: 'missing_publication_fields',
              missing_fields: [field],
            });
            return true;
          },
        );
      }

      const invalidChanges = { ...complete, changes: [] };
      await assert.rejects(
        tool.execute('missing-changes', invalidChanges),
        error => {
          assert.deepEqual(JSON.parse(error.message), {
            code: 'missing_publication_fields',
            missing_fields: ['changes'],
          });
          return true;
        },
      );

      const nudge = settle();
      assert.match(nudge.entries[0].content, /missing_publication_fields/);
      assert.match(nudge.entries[0].content, /retry submit_result immediately/);
      assert.match(tool.description, /schema requires all publication fields/);
      assert.match(tool.description, /do not reopen exploration/);
    `;
    const child = spawnSync(
      process.execPath,
      ['--no-warnings', '--experimental-loader', loader, '--input-type=module', '-e', program],
      {
        cwd: new URL('..', import.meta.url),
        encoding: 'utf8',
        timeout: 15000,
        env: {
          ...process.env,
          PI_RESUME_ACTIVE: 'false',
          PI_VALIDATION_REPAIR: 'false',
        },
      },
    );
    assert.equal(child.status, 0, child.stderr + child.stdout);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('failed submit_result keeps the Implementer on the immediate terminal retry path', () => {
  const state = new ProgressController(stageConfig('implementer'), {});
  state.onTurnStart(0);
  assert.equal(state.checkToolCall('prepare_implementation', {}), undefined);
  state.setComplexity('nontrivial');
  state.setEvidenceBudget(0);
  state.onToolExecutionEnd('prepare_implementation', false);
  assert.equal(state.productiveProgressState(), 'action_required');

  const incomplete = { title: 'Missing publication metadata' };
  assert.equal(state.checkToolCall('submit_result', incomplete), undefined);
  state.onToolExecutionEnd('submit_result', true);
  assert.equal(state.productiveProgressState(), 'action_required');

  const evidence = state.checkToolCall('read', { path: 'README.md' });
  assert.equal(evidence.block, true);
  assert.match(evidence.reason, /productive progress requires an action now/);

  const corrected = {
    title: 'Contract fix',
    summary: 'Complete publication metadata.',
    changes: ['Require publication metadata'],
    files: ['scripts/pi-implementer-result-tool.mjs'],
    security_notes: 'No security impact.',
    limitations: 'None.',
  };
  assert.equal(state.checkToolCall('submit_result', corrected), undefined);
});
