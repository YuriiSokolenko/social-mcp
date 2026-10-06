import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MODEL_EXECUTION_ABORT_CODES = Object.freeze([
  'PI_ACTION_REQUIRED_ABORT',
  'PI_CODING_RECOVERY_BLOCKED',
  'PI_CODING_REPAIR_ACTION_FALLBACK_FAILED',
  'PI_CODING_REPAIR_BROAD_MUTATION_LIMIT',
  'PI_CODING_SESSION_ARGUMENT_RETRY_EXHAUSTED',
  'PI_CODING_VALIDATION_NON_CONVERGENT',
  'PI_LARGE_MUTATION_ACTION_FORCE_FAILED',
  'PI_LARGE_MUTATION_ACTION_REQUIRED',
  'PI_LARGE_MUTATION_ACTION_RETRY_EXHAUSTED',
  'PI_LARGE_MUTATION_PROVIDER_RETRY_EXHAUSTED',
  'PI_LARGE_MUTATION_TRUNCATION_RETRY_EXHAUSTED',
  'PI_TERMINAL_RECOVERY_BLOCKED',
  'PI_UNAVAILABLE_CAPABILITY_ABORT',
]);

export const INFRASTRUCTURE_FAILURE_CODES = Object.freeze([
  'PI_RUN_CHECK_PREFLIGHT_FAILED',
  'PI_TOOL_CONTRACT_FAILURE',
]);

const MODEL_EXECUTION_ABORT_CODE_SET = new Set(MODEL_EXECUTION_ABORT_CODES);
const INFRASTRUCTURE_FAILURE_CODE_SET = new Set(INFRASTRUCTURE_FAILURE_CODES);

export function runtimeFailureClassForCode(code) {
  if (MODEL_EXECUTION_ABORT_CODE_SET.has(code)) return 'model_execution_abort';
  if (INFRASTRUCTURE_FAILURE_CODE_SET.has(code)) return 'infrastructure';
  return null;
}

export function classifyRuntimeFailureRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.schema_version !== 1) return null;
  if (typeof value.failure_class !== 'string') return null;
  if (typeof value.failure_code !== 'string') return null;
  if (typeof value.reason !== 'string' || value.reason.length === 0) return null;

  const expectedClass = runtimeFailureClassForCode(value.failure_code);
  if (!expectedClass || value.failure_class !== expectedClass) return null;

  return {
    schema_version: 1,
    failure_class: expectedClass,
    failure_code: value.failure_code,
    reason: value.reason,
  };
}

export function classifyRuntimeFailureFile(file) {
  const raw = fs.readFileSync(file, 'utf8').trim();
  if (!raw) return null;
  return classifyRuntimeFailureRecord(JSON.parse(raw));
}

const directInvocation = process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (directInvocation) {
  const [command, file] = process.argv.slice(2);
  if (command !== 'classify' || !file) {
    process.stderr.write('usage: node runtime-failure.mjs classify <runtime-failure.json>\n');
    process.exitCode = 64;
  } else {
    try {
      const classified = classifyRuntimeFailureFile(file);
      if (!classified) {
        process.exitCode = 2;
      } else {
        process.stdout.write(JSON.stringify(classified));
      }
    } catch {
      process.exitCode = 2;
    }
  }
}
