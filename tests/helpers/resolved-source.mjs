import fs from 'node:fs';

import { PIPELINE_LABELS } from '../../scripts/pi-common/state-machine.mjs';
import { baseBranch, baseRef, projectConfig, workflowFile } from '../../scripts/pi-common/project-config.mjs';

/**
 * Structural (source-text) contract tests were written when control-plane
 * scripts spelled project values inline (`'pi-pr-fix.yml'`, `'pi:needs-human'`,
 * `origin/dev`). Those values now come from `.agent-harness.json`.
 *
 * `readScript` returns a script with every config accessor replaced by the
 * value this repository's config resolves it to, so the same structural
 * assertions keep proving the *social-mcp* wiring (right workflow, right
 * label, right base ref) without pinning how the harness reads its config.
 */
const LABEL_KEYS = Object.keys(PIPELINE_LABELS);
const REVIEW = { REVIEW_PASSED: 'reviewPassed', REVIEW_CHANGES_REQUESTED: 'reviewChangesRequested' };
const labels = projectConfig().labels;

export function resolveSource(text) {
  let out = text;
  out = out.replace(/workflowFile\((['"])(\w+)\1\)/g, (_, q, role) => `${q}${workflowFile(role)}${q}`);
  out = out.replace(/\$\{PIPELINE_LABELS\.(\w+)\}/g, (m, key) => LABEL_KEYS.includes(key) ? PIPELINE_LABELS[key] : m);
  out = out.replace(/PIPELINE_LABELS\.(\w+)/g, (m, key) => LABEL_KEYS.includes(key) ? `'${PIPELINE_LABELS[key]}'` : m);
  for (const [id, key] of Object.entries(REVIEW)) {
    out = out.replace(new RegExp(`\\$\\{${id}\\}`, 'g'), labels[key]);
    out = out.replace(new RegExp(`\\b${id}\\b(?!\\s*[,}]\\s*(?:from|=))`, 'g'), `'${labels[key]}'`);
  }
  out = out.replace(/\$\{baseBranch\(\)\}/g, baseBranch());
  out = out.replace(/\$\{baseRef\(\)\}/g, baseRef());
  out = out.replace(/baseBranch\(\)/g, `'${baseBranch()}'`);
  out = out.replace(/baseRef\(\)/g, `'${baseRef()}'`);
  return out;
}

export function readScript(path, encoding = 'utf8') {
  return resolveSource(fs.readFileSync(path, encoding));
}
