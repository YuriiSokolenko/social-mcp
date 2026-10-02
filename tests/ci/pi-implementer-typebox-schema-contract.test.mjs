import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PROJECT_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const RESULT_TOOL_URL = new URL('../../scripts/pi-implementer-result-tool.mjs', import.meta.url).href;
const TYPEBOX_PACKAGE_ROOT = process.env.PI_TYPEBOX_PACKAGE_ROOT;

if (!TYPEBOX_PACKAGE_ROOT) {
  throw new Error('PI_TYPEBOX_PACKAGE_ROOT is required for the real TypeBox CI contract check.');
}

const EXPECTED_PROPERTIES = {
  title: 'Required for fresh changed work: PR title.',
  summary: 'Required for fresh changed work: PR summary.',
  changes: 'Required for fresh changed work: concrete repository changes.',
  files: 'Required for fresh changed work: exact repository-relative changed-file set.',
  already_satisfied: 'Set true only when latest dev already contains the requested end state.',
  blocked_reason: 'Fresh work only: concrete contradiction that makes a compliant mutation impossible.',
  security_notes: 'Required for fresh changed work, including an explicit no-impact statement.',
  limitations: 'Required for fresh changed work, including an explicit none-known statement.',
};

function writeTypeboxLoader(dir) {
  const loader = path.join(dir, 'real-typebox-loader.mjs');
  const packageParent = pathToFileURL(path.join(TYPEBOX_PACKAGE_ROOT, 'resolve-from-here.mjs')).href;
  fs.writeFileSync(loader, `
    export async function resolve(specifier, context, nextResolve) {
      if (specifier === 'typebox' || specifier.startsWith('typebox/')) {
        return nextResolve(specifier, { ...context, parentURL: ${JSON.stringify(packageParent)} });
      }
      return nextResolve(specifier, context);
    }
  `);
  return loader;
}

test('registered submit_result schema matches the real Pi TypeBox transport contract', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-submit-real-typebox-'));
  try {
    const loader = writeTypeboxLoader(dir);
    const program = `
      import assert from 'node:assert/strict';
      const { Value } = await import('typebox/value');
      const { default: registerResultTool } = await import(${JSON.stringify(RESULT_TOOL_URL)});

      let tool;
      const pi = {
        registerTool(value) { if (value.name === 'submit_result') tool = value; },
        appendEntry() {},
        on() {},
      };
      registerResultTool(pi);

      const schema = tool.parameters;
      const expectedProperties = ${JSON.stringify(EXPECTED_PROPERTIES)};
      assert.equal(schema.type, 'object');
      assert.equal(schema.anyOf, undefined, 'transport schema must not use a union');
      assert.equal(schema.oneOf, undefined, 'transport schema must not use a union');
      assert.equal(schema.allOf, undefined, 'transport schema must stay flat');
      assert.deepEqual(Object.keys(schema.properties), Object.keys(expectedProperties));
      assert.deepEqual(schema.required ?? [], [], 'outcome-specific fields remain optional in TypeBox');
      for (const [field, description] of Object.entries(expectedProperties)) {
        assert.equal(schema.properties[field].description, description, field + ' description');
        assert.equal(schema.properties[field].anyOf, undefined, field + ' must not be union-shaped');
        assert.equal(schema.properties[field].oneOf, undefined, field + ' must not be union-shaped');
      }

      assert.equal(Value.Check(schema, {}), true, 'flat transport schema must permit alternate result shapes');
      await assert.rejects(
        tool.execute('missing-fresh-publication-metadata', {}),
        error => {
          assert.deepEqual(JSON.parse(error.message), {
            code: 'missing_publication_fields',
            missing_fields: ['title', 'summary', 'changes', 'files', 'security_notes', 'limitations'],
          });
          return true;
        },
        'runtime validation remains authoritative for fresh changed work',
      );
    `;
    const bootstrap = `
      import { register } from 'node:module';
      import { pathToFileURL } from 'node:url';
      register(pathToFileURL(${JSON.stringify(loader)}), import.meta.url);
      ${program}
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', bootstrap], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      timeout: 15000,
      env: {
        ...process.env,
        PI_RESUME_ACTIVE: 'false',
        PI_VALIDATION_REPAIR: 'false',
      },
    });
    assert.equal(child.status, 0, child.stderr + child.stdout);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
