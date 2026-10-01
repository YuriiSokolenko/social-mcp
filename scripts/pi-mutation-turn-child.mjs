import fs from 'node:fs';
import path from 'node:path';

import { Type } from 'typebox';

import {
  MutationTurnRejected,
  applyExactEdits,
  resolveMutationTarget,
  sha256,
  writeStagedMutation,
} from './pi-common/mutation-turn.mjs';

// Loaded only inside the forked `implementer-mutation-turn` child, by absolute path from the
// trusted control checkout: the parent runtime registers that agent in code (see
// mutationTurnAgentDefinition in pi-agent-runtime.mjs), so no issue-worktree copy of this file,
// .pi/agents or .pi/settings.json is consulted. The child is a fork of the Implementer's own session (same transcript, same evidence); this
// extension narrows it to exactly the one mutation the parent declared. Its write/edit keep
// the builtin names and arguments, but never touch the worktree: they stage the payload for
// the parent runtime, which alone validates and applies it. Fails closed when no turn was
// declared.

function declaredTurn(env = process.env) {
  try {
    const spec = JSON.parse(env.PI_MUTATION_TURN ?? '');
    if (['write', 'edit'].includes(spec?.operation) && spec.path && spec.stagingFile && spec.turnId) return spec;
  } catch { /* no declared turn */ }
  return null;
}

function log(phase, fields) {
  console.log(`PI_MUTATION_TURN ${JSON.stringify({ phase, side: 'fork', ...fields })}`);
}

export default function (pi) {
  const spec = declaredTurn();
  let staged = false;

  pi.on('session_start', async (_event, ctx) => {
    if (!spec) return;
    pi.setActiveTools([spec.operation]);
    const entries = ctx.sessionManager?.getEntries?.() ?? [];
    log('fork_ready', {
      turnId: spec.turnId,
      operation: spec.operation,
      path: spec.path,
      activeTools: pi.getActiveTools(),
      maxTokens: ctx.model?.maxTokens ?? null,
      inheritedEntries: entries.length,
      inheritedToolResults: entries.filter(entry => entry?.message?.role === 'toolResult').length,
      forkedFromParent: Boolean(ctx.sessionManager?.getHeader?.()?.parentSession),
    });
  });

  pi.on('tool_call', async (event) => {
    if (!spec) return { block: true, reason: 'BLOCKED: no mutation turn was declared for this session.' };
    if (staged) return { block: true, reason: 'BLOCKED: this mutation turn already staged its one mutation. Reply with one short line and stop.' };
    if (event.toolName !== spec.operation) {
      return { block: true, reason: `BLOCKED: this mutation turn may only call ${spec.operation} for ${spec.path}. ${event.toolName} is not available; exploration belongs to the normal Implementer turn.` };
    }
    return undefined;
  });

  function stage(ctx, params, compute) {
    if (!spec) throw new MutationTurnRejected('no_turn', 'no mutation turn was declared for this session');
    if (staged) throw new MutationTurnRejected('already_staged', 'this mutation turn already staged its one mutation');
    const target = resolveMutationTarget(ctx.cwd, params?.path);
    if (path.normalize(target.relative) !== path.normalize(spec.path)) {
      throw new MutationTurnRejected('path_mismatch', `this mutation turn is declared for ${spec.path}, not ${target.relative}`);
    }
    const { content, baseSha256 } = compute(target);
    writeStagedMutation(spec.stagingFile, {
      turnId: spec.turnId,
      operation: spec.operation,
      path: spec.path,
      content,
      sha256: sha256(content),
      baseSha256,
    });
    staged = true;
    log('staged', { turnId: spec.turnId, operation: spec.operation, path: spec.path, chars: content.length });
    return {
      content: [{
        type: 'text',
        text: `STAGED: your ${spec.operation} for ${spec.path} (${content.length} chars) was handed to the runtime, which validates and applies it. This mutation turn is complete: do not call any tool; reply with one short line.`,
      }],
      details: { turnId: spec.turnId, operation: spec.operation, path: spec.path, chars: content.length },
    };
  }

  pi.registerTool({
    name: 'write',
    label: 'Write file (mutation turn)',
    description: 'Write the complete content of the declared target file. Creates the file if it does not exist, overwrites it if it does.',
    parameters: Type.Object({
      path: Type.String({ description: 'Path to the file to write (relative or absolute)' }),
      content: Type.String({ description: 'Content to write to the file' }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (spec?.operation !== 'write') throw new MutationTurnRejected('operation_mismatch', `declared operation is ${spec?.operation ?? 'none'}`);
      return stage(ctx, params, () => ({ content: String(params.content ?? ''), baseSha256: null }));
    },
  });

  pi.registerTool({
    name: 'edit',
    label: 'Edit file (mutation turn)',
    description: 'Make exact text replacements in the declared target file. Each edits[].oldText must match exactly once in the original file; edits must not overlap.',
    parameters: Type.Object({
      path: Type.String({ description: 'Path to the file to edit (relative or absolute)' }),
      edits: Type.Array(Type.Object({
        oldText: Type.String({ description: 'Exact text for one targeted replacement; unique in the original file.' }),
        newText: Type.String({ description: 'Replacement text for this targeted edit.' }),
      })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (spec?.operation !== 'edit') throw new MutationTurnRejected('operation_mismatch', `declared operation is ${spec?.operation ?? 'none'}`);
      return stage(ctx, params, (target) => {
        if (!target.exists) throw new MutationTurnRejected('missing_target', `edit target does not exist: ${spec.path}`);
        const original = fs.readFileSync(target.absolutePath, 'utf8');
        return { content: applyExactEdits(original, params.edits), baseSha256: sha256(original) };
      });
    },
  });
}
