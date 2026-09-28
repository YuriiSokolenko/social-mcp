import { runGit as git } from './git.mjs';

import { forbiddenAgentPaths } from './agent-change-policy.mjs';
import { runProductChecks } from './product-checks.mjs';


function conflictedFiles() {
  return git(['diff', '--name-only', '--diff-filter=U'], { allowFailure: true })
    .out.split('\n').map((item) => item.trim()).filter(Boolean);
}

function mergeInProgress() {
  return git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { allowFailure: true }).status === 0;
}

export function integrateLatestDev({ conflictMessage, allowConflicts = false }) {
  git(['config', 'user.name', 'social-mcp-pi']);
  git(['config', 'user.email', 'social-mcp-pi@users.noreply.github.com']);

  if (mergeInProgress()) {
    const conflicts = conflictedFiles();
    if (conflicts.length) {
      git(['add', '-A']);
      const remaining = conflictedFiles();
      if (remaining.length) throw new Error(`Merge conflicts are still unresolved: ${remaining.join(', ')}`);
    }
    git(['diff', '--check']);
    git(['commit', '--no-edit']);
    return;
  }

  git(['fetch', 'origin', 'dev']);
  const merge = git(['merge', '--no-edit', 'origin/dev'], { allowFailure: true });
  if (merge.status !== 0) {
    const conflicts = conflictedFiles();
    if (conflicts.length) {
      if (allowConflicts) return { conflicts };
      throw new Error(conflictMessage(conflicts));
    }
    throw new Error(merge.out || 'Failed to merge latest dev');
  }
  return { conflicts: [] };
}

export function validateFinalProductTree() {
  const base = git(['merge-base', 'origin/dev', 'HEAD']).out;
  const forbidden = forbiddenAgentPaths(base);
  if (forbidden.length) throw new Error(`Agent changes to CI/control-plane files are forbidden: ${forbidden.join(', ')}`);
  runProductChecks();
}
