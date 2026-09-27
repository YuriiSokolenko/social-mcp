import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('CI validates the committed dev state without synthetic PR integration inputs', () => {
  const workflow = fs.readFileSync('.github/workflows/ci.yml', 'utf8');
  assert.match(workflow, /^\s*push:/m);
  assert.doesNotMatch(workflow, /integration_base_sha|target_sha|target_ref|exact[- ]pair/i);
  assert.doesNotMatch(workflow, /git merge --no-ff|social-mcp\/integration/);
});

test('merge gate never waits for pre-merge CI, review, repair, or a dev SHA', () => {
  const gate = fs.readFileSync('scripts/pi-auto-merge.mjs', 'utf8');
  assert.doesNotMatch(gate, /integration_base_sha|repair_base_sha|BASE_SHA|social-mcp\/integration|social-mcp\/pi-review/i);
  assert.doesNotMatch(gate, /pi-pr-review|statuses|social-mcp\/integration|social-mcp\/pi-review/);
  assert.match(gate, /dispatchWorkflow\('pi-pr-fix\.yml'/);
  assert.match(gate, /merge_method: 'squash'/);
});

test('architecture guard documents that complexity must not return', () => {
  const guard = fs.readFileSync('docs/ci-architecture.md', 'utf8');
  assert.match(guard, /merge.*dev.*CI/is);
  assert.match(guard, /Do not reintroduce/i);
  assert.match(guard, /dev SHA|exact-pair/i);
});


test('workflow dispatch inputs stay minimal identifiers or real commands', () => {
  const allowed = new Set(['issue_number', 'pr_number', 'run_id', 'mode']);
  for (const name of fs.readdirSync('.github/workflows').filter(name => name.endsWith('.yml'))) {
    const workflow = fs.readFileSync(`.github/workflows/${name}`, 'utf8');
    const dispatch = workflow.match(/workflow_dispatch:\n([\s\S]*?)(?=\n  [a-zA-Z_][\\w-]*:|\npermissions:|\nconcurrency:|\njobs:|$)/)?.[1] ?? '';
    for (const match of dispatch.matchAll(/^      ([a-zA-Z_][\\w-]*):\n        description:/gm)) {
      assert.ok(allowed.has(match[1]), `${name}: redundant workflow input ${match[1]}`);
    }
  }
});


test('control-plane scripts always execute from trusted dev checkout', () => {
  const workflows = [
    'pi-architect.yml',
    'pi-auto-merge.yml',
    'pi-automation-control.yml',
    'pi-dispatcher.yml',
    'pi-issue-agent.yml',
    'pi-pr-fix.yml',
    'pi-pr-review.yml',
    'pi-reconcile.yml',
    'pi-triage.yml',
    'pi-usage.yml',
    'ci.yml',
  ];
  for (const name of workflows) {
    const workflow = fs.readFileSync(`.github/workflows/${name}`, 'utf8');
    assert.match(
      workflow,
      /uses:\s*actions\/checkout@v\d+[\s\S]*?with:[\s\S]*?ref:\s*dev/,
      `${name}: control-plane checkout must be pinned to dev`,
    );
  }
});


test('implementer resolves latest-dev integration inside the live agent session before publication', () => {
  const workflow = fs.readFileSync('.github/workflows/pi-issue-agent.yml', 'utf8');
  const tool = fs.readFileSync('scripts/pi-implementer-result-tool.mjs', 'utf8');
  assert.doesNotMatch(workflow, /name: Integrate latest dev before publication/);
  const finalizer = fs.readFileSync('scripts/pi-common/finalize-product-tree.mjs', 'utf8');
  assert.match(tool, /integrateLatestDev/);
  assert.match(finalizer, /fetch', 'origin', 'dev/);
  assert.match(finalizer, /merge', '--no-edit', 'origin\/dev/);
  assert.match(tool, /Merge conflicts are still unresolved|Latest dev conflicts with the implementation/);
  assert.match(tool, /validateFinalProductTree\(\)/);
  const publication = fs.readFileSync('scripts/pi-common/issue-publication.mjs', 'utf8');
  assert.match(workflow, /issue-publication\.mjs" review/);
  assert.match(publication, /dispatchWorkflow\('pi-pr-review\.yml'/);
  assert.doesNotMatch(workflow, /name: Wake merge gate/);
});

test('review PASS is required before merge gate can merge', () => {
  const review = fs.readFileSync('.github/workflows/pi-pr-review.yml', 'utf8');
  const gate = fs.readFileSync('scripts/pi-auto-merge.mjs', 'utf8');
  assert.match(review, /Run deterministic review checks/);
  assert.match(fs.readFileSync('scripts/pi-common/review-state.mjs', 'utf8'), /review:passed/);
  assert.match(review, /Wake merge gate after PASS/);
  assert.match(gate, /review:passed/);
});

test('PR fix resolves current-dev conflicts in the live repair session and returns to fresh review', () => {
  const workflow = fs.readFileSync('.github/workflows/pi-pr-fix.yml', 'utf8');
  const tool = fs.readFileSync('scripts/pi-repair-result-tool.mjs', 'utf8');
  assert.match(workflow, /pi-repair-result-tool\.mjs/);
  const finalizer = fs.readFileSync('scripts/pi-common/finalize-product-tree.mjs', 'utf8');
  assert.match(tool, /integrateLatestDev/);
  assert.match(tool, /validateFinalProductTree/);
  assert.match(finalizer, /fetch', 'origin', 'dev/);
  assert.match(finalizer, /merge', '--no-edit', 'origin\/dev/);
  assert.match(tool, /PR conflicts with current dev/);
  assert.match(finalizer, /runProductChecks\(\)/);
  assert.match(workflow, /name: Start fresh review/);
  assert.match(fs.readFileSync('scripts/pi-common/repair-publication.mjs', 'utf8'), /dispatchWorkflow\('pi-pr-review\.yml'/);
  assert.doesNotMatch(workflow, /name: Wake merge gate/);
});


test('stale reviewer verdict is discarded without self-rescheduling', () => {
  const workflow = fs.readFileSync('.github/workflows/pi-pr-review.yml', 'utf8');
  const state = fs.readFileSync('scripts/pi-common/review-state.mjs', 'utf8');
  assert.match(state, /pr\.head\.sha !== reviewedHead/);
  assert.match(state, /status: 'stale'/);
  assert.match(workflow, /STALE_REVIEW=true/);
  assert.doesNotMatch(workflow, /name: Restart review after PR head changed/);
});


test('implementer resume always rebases saved work onto latest dev and never uses main as a base', () => {
  const workflow = fs.readFileSync('.github/workflows/pi-issue-agent.yml', 'utf8');
  const worktree = fs.readFileSync('scripts/pi-common/issue-worktree.mjs', 'utf8');
  assert.match(worktree, /worktree', 'add', '-B'.*origin\/dev/s);
  assert.match(worktree, /merge-base', 'origin\/dev', resumeRef/);
  assert.match(worktree, /diff', '--binary', base, resumeRef/);
  assert.match(worktree, /apply', '--3way', patch/);
  assert.match(worktree, /checkpointExpected[\s\S]*issueBranchExpected/);
  assert.match(workflow, /dev is the only development base/);
});


test('Pi usage is isolated from dev and metrics pushes do not run project CI', () => {
  const collector = fs.readFileSync('scripts/pi-usage-collect.mjs', 'utf8');
  const ci = fs.readFileSync('.github/workflows/ci.yml', 'utf8');
  assert.match(collector, /const metricsBranch = "pi-metrics"/);
  assert.match(collector, /ref=\$\{metricsBranch\}/);
  assert.match(collector, /branch: metricsBranch/);
  assert.doesNotMatch(collector, /ref=dev/);
  assert.match(ci, /push:\n\s+branches: \[dev\]/);
});


test('merge gate has permission for its late-conflict PR Fix dispatch', () => {
  const workflow = fs.readFileSync('.github/workflows/pi-auto-merge.yml', 'utf8');
  const gate = fs.readFileSync('scripts/pi-auto-merge.mjs', 'utf8');
  assert.match(gate, /dispatchWorkflow\('pi-pr-fix\.yml'/);
  assert.match(workflow, /permissions:\n(?:\s+.*\n)*?\s+actions: write/);
});


test('green dev CI wakes merge gate without parsing commit-message conventions', () => {
  const workflow = fs.readFileSync('.github/workflows/ci.yml', 'utf8');
  assert.match(workflow, /if: github\.event_name == 'push' && github\.ref == 'refs\/heads\/dev' && success\(\)/);
  assert.doesNotMatch(workflow, /contains\(github\.event\.head_commit\.message/);
});


test('pi:needs-human on a PR stops review, repair, and merge automation', () => {
  const guard = fs.readFileSync('scripts/pi-common/pr-guard.mjs', 'utf8');
  const reviewState = fs.readFileSync('scripts/pi-common/review-state.mjs', 'utf8');
  const repairPublication = fs.readFileSync('scripts/pi-common/repair-publication.mjs', 'utf8');
  const merge = fs.readFileSync('scripts/pi-auto-merge.mjs', 'utf8');
  assert.match(guard, /pi:needs-human/);
  assert.match(reviewState, /pi:needs-human/);
  assert.match(repairPublication, /pi:needs-human/);
  assert.match(merge, /prLabels\.has\('pi:needs-human'\)/);
});


test('manual cancellation leaves unpublished agent work unowned instead of redispatching', () => {
  const implementer = fs.readFileSync('.github/workflows/pi-issue-agent.yml', 'utf8');
  const architect = fs.readFileSync('.github/workflows/pi-architect.yml', 'utf8');
  assert.ok(implementer.includes("if: cancelled() && steps.pr.outputs.number == ''"));
  assert.ok(implementer.includes('pi-transition.mjs" issue stopped'));
  assert.ok(architect.includes('if: cancelled()'));
  assert.ok(architect.includes('pi-transition.mjs" issue stopped'));
  assert.doesNotMatch(implementer, /if: cancelled\(\) && steps\.pr\.outputs\.number == ''[\s\S]{0,400}?issue needs-human/);
});


test('usage workflow listens to the current Pi workflow names', () => {
  const usage = fs.readFileSync('.github/workflows/pi-usage.yml', 'utf8');
  for (const name of ['Pi Issue Agent', 'Pi PR Review', 'Pi PR Fix', 'Pi Architect', 'Pi Dispatcher', 'Pi Triage']) {
    assert.ok(usage.includes(name), `missing usage trigger for ${name}`);
  }
  assert.doesNotMatch(usage, /manual diagnostic|PR Fix \(manual\)/);
});


test('human-required PR exits before reviewer or repair model work', () => {
  for (const file of ['.github/workflows/pi-pr-review.yml', '.github/workflows/pi-pr-fix.yml']) {
    const workflow = fs.readFileSync(file, 'utf8');
    assert.match(workflow, /id: load[\s\S]*?pi-common\/pr-guard\.mjs[\s\S]*?\.skip/);
    assert.match(workflow, /Create (?:review|PR) worktree\n\s+if: steps\.load\.outputs\.skip != 'true'/);
  }
});


test('implementer checkpoint never commits unresolved replay conflicts', () => {
  const publication = fs.readFileSync('scripts/pi-common/issue-publication.mjs', 'utf8');
  const conflictCheck = publication.indexOf("'diff','--name-only','--diff-filter=U'");
  const stage = publication.indexOf("'add','-A'", conflictCheck);
  assert.ok(conflictCheck >= 0 && stage > conflictCheck);
  assert.match(publication, /reason:'conflicts'/);
});


test('review verdict exists only for the unchanged reviewed PR head', () => {
  const review = fs.readFileSync('.github/workflows/pi-pr-review.yml', 'utf8');
  const repair = fs.readFileSync('.github/workflows/pi-pr-fix.yml', 'utf8');
  const reviewState = fs.readFileSync('scripts/pi-common/review-state.mjs', 'utf8');
  const repairPublication = fs.readFileSync('scripts/pi-common/repair-publication.mjs', 'utf8');
  assert.match(review, /PR #\$PR changed during review; stale verdict cleared/);
  assert.match(reviewState, /pr\.head\.sha !== reviewedHead/);
  assert.match(reviewState, /pi:needs-human/);
  assert.match(reviewState, /withReviewVerdict/);
  assert.match(repairPublication, /pi:needs-human/);
  assert.match(repairPublication, /expectedHead/);
  assert.match(repairPublication, /withoutReviewLabels/);
  assert.match(repair, /if: steps\.publish\.outputs\.published == 'true'/);
  assert.match(repair, /issues: write/);
});


test('reconciler recovers stranded PR pipeline without touching human-gated PRs', () => {
  const reconcile = fs.readFileSync('scripts/pi-reconcile.mjs', 'utf8');
  assert.match(reconcile, /liveReviews/);
  assert.match(reconcile, /liveFixes/);
  assert.match(reconcile, /labels\.has\('pi:needs-human'\)/);
  assert.match(reconcile, /labels\.has\('review:passed'\)/);
  assert.match(reconcile, /labels\.has\('review:changes-requested'\) \? 'pi-pr-fix\.yml' : 'pi-pr-review\.yml'/);
});




test('global automation mode gates issue-producing agent stages', () => {
  for (const file of ['pi-dispatcher.yml', 'pi-architect.yml', 'pi-issue-agent.yml', 'pi-triage.yml']) {
    const workflow = fs.readFileSync(`.github/workflows/${file}`, 'utf8');
    assert.match(workflow, /vars\.PI_AUTOMATION_MODE == 'RUNNING'/, `${file} must stop outside RUNNING`);
  }
  for (const file of ['pi-pr-review.yml', 'pi-pr-fix.yml', 'pi-auto-merge.yml']) {
    const workflow = fs.readFileSync(`.github/workflows/${file}`, 'utf8');
    assert.match(workflow, /\["RUNNING","DRAINING"\]/, `${file} must allow draining in-flight PR work`);
  }
});


test('workflow concurrency uses only supported GitHub Actions keys', () => {
  for (const name of fs.readdirSync('.github/workflows').filter(name => name.endsWith('.yml'))) {
    const workflow = fs.readFileSync(`.github/workflows/${name}`, 'utf8');
    assert.doesNotMatch(workflow, /^\s+queue:\s*/m, `${name}: unsupported concurrency.queue must not return`);
  }
  const mergeGate = fs.readFileSync('.github/workflows/pi-auto-merge.yml', 'utf8');
  assert.match(mergeGate, /concurrency:\n\s+group: pi-auto-merge\n\s+cancel-in-progress: false/);
});


test('reviewer rechecks the human gate before publishing a verdict', () => {
  const review = fs.readFileSync('.github/workflows/pi-pr-review.yml', 'utf8');
  const state = fs.readFileSync('scripts/pi-common/review-state.mjs', 'utf8');
  assert.match(review, /review-state\.mjs" apply/);
  assert.match(state, /pi:needs-human/);
  assert.match(state, /pr\.head\.sha !== reviewedHead/);
  assert.doesNotMatch(review, /Restart review after PR head changed/);
});


test('reconciler gives normal PR handoffs a grace period before recovery dispatch', () => {
  const source = fs.readFileSync('scripts/pi-reconcile.mjs', 'utf8');
  assert.match(source, /RECOVERY_GRACE_MS = 10 \* 60 \* 1000/);
  assert.match(source, /pr\.updated_at \?\? pr\.created_at/);
  assert.match(source, /prAgeMs < RECOVERY_GRACE_MS/);
});


test('PR head changes invalidate verdict without creating a second review scheduler', () => {
  const review = fs.readFileSync('.github/workflows/pi-pr-review.yml', 'utf8');
  const state = fs.readFileSync('scripts/pi-common/review-state.mjs', 'utf8');
  assert.match(review, /pull_request:[\s\S]*types: \[synchronize\]/);
  assert.match(review, /review-state\.mjs" invalidate/);
  assert.match(state, /replaceReviewLabels\(prNumber\)/);
  assert.match(review, /review:\n    if: github\.event_name == 'workflow_dispatch'/);
  const invalidate = review.slice(review.indexOf('  invalidate:'), review.indexOf('  review:'));
  assert.doesNotMatch(invalidate, /dispatch/);
  assert.doesNotMatch(review, /Restart review after PR head changed/);
});


test('late merge conflict leaves recoverable PR Fix ownership', () => {
  const gate = fs.readFileSync('scripts/pi-auto-merge.mjs', 'utf8');
  assert.match(gate, /withReviewVerdict\(\[\.\.\.prLabels\], 'review:changes-requested'\)/);
  assert.match(gate, /dispatchWorkflow\('pi-pr-fix\.yml'/);
  const reconcile = fs.readFileSync('scripts/pi-reconcile.mjs', 'utf8');
  assert.match(reconcile, /labels\.has\('review:changes-requested'\) \? 'pi-pr-fix\.yml' : 'pi-pr-review\.yml'/);
});


test('issue publication safely replaces only the branch head observed at run start', () => {
  const workflow = fs.readFileSync('.github/workflows/pi-issue-agent.yml', 'utf8');
  const publication = fs.readFileSync('scripts/pi-common/issue-publication.mjs', 'utf8');
  assert.match(workflow, /PI_ISSUE_BRANCH_EXPECTED/);
  assert.match(publication, /--force-with-lease=refs\/heads\/pi\/issue-\$\{issue\}:\$\{expectedSha/);
  assert.match(publication, /Refusing to publish protected control-plane files/);
  assert.match(workflow, /PI_IMPLEMENTER_START_COMMIT.*PI_ISSUE_BRANCH_EXPECTED/);
  assert.doesNotMatch(publication, /push --set-upstream origin/);
});

test('issue agent workflow contains no escaped newline artifacts', () => {
  const workflow = fs.readFileSync('.github/workflows/pi-issue-agent.yml', 'utf8');
  assert.equal(workflow.includes('\\\\n'), false);
});


test('product agent workflows use one shared product-check contract and never run control-plane suites', () => {
  for (const name of ['pi-issue-agent.yml', 'pi-pr-review.yml', 'pi-pr-fix.yml']) {
    const workflow = fs.readFileSync(`.github/workflows/${name}`, 'utf8');
    assert.doesNotMatch(workflow, /node\s+--test|test_runner_autoscaler|tests\/[^^\s"']*\.test\.mjs/);
  }
  // Reviewer validates in workflow. Implementer validates once inside its trusted
  // terminal submit tool; publication must not rerun the same full product suite.
  assert.match(fs.readFileSync('.github/workflows/pi-pr-review.yml', 'utf8'), /pi-common\/product-checks\.mjs/);
  assert.doesNotMatch(fs.readFileSync('.github/workflows/pi-issue-agent.yml', 'utf8'), /pi-common\/product-checks\.mjs/);
  const checks = fs.readFileSync('scripts/pi-common/product-checks.mjs', 'utf8');
  assert.match(checks, /git.*diff.*--check/s);
  assert.match(checks, /pytest/);
  assert.match(checks, /ruff/);
  const repairTool = fs.readFileSync('scripts/pi-repair-result-tool.mjs', 'utf8');
  const implementerTool = fs.readFileSync('scripts/pi-implementer-result-tool.mjs', 'utf8');
  assert.match(repairTool, /validateFinalProductTree\(\)/);
  assert.match(implementerTool, /validateFinalProductTree\(\)/);
  assert.match(fs.readFileSync('scripts/pi-common/finalize-product-tree.mjs', 'utf8'), /runProductChecks\(\)/);
  const ci = fs.readFileSync('.github/workflows/ci.yml', 'utf8');
  assert.match(ci, /node --test tests\/\*\.test\.mjs/);
  assert.match(ci, /tests\/test_runner_autoscaler\.sh/);
});


test('all Pi agents are hard-blocked from CI control-plane changes', () => {
  const policy = fs.readFileSync('scripts/pi-common/control-plane-policy.mjs', 'utf8');
  for (const fragment of [
    ".github/workflows/",
    "agents/",
    "scripts\\/pi-",
    "tests\\/[^/]+\\.test\\.mjs",
    "tests/test_runner_autoscaler.sh",
    "infra/github-runner-autoscaler/",
  ]) assert.ok(policy.includes(fragment), `missing protected control-plane path: ${fragment}`);

  const implementerTool = fs.readFileSync('scripts/pi-implementer-result-tool.mjs', 'utf8');
  const repairTool = fs.readFileSync('scripts/pi-repair-result-tool.mjs', 'utf8');
  assert.match(implementerTool, /validateFinalProductTree\(\)/);
  assert.match(repairTool, /validateFinalProductTree\(\)/);
  const finalizer = fs.readFileSync('scripts/pi-common/finalize-product-tree.mjs', 'utf8');
  assert.match(finalizer, /forbiddenAgentPaths\(base\)/);
  const agentChanges = fs.readFileSync('scripts/pi-common/agent-change-policy.mjs', 'utf8');
  for (const check of ["diff','--name-only", "diff','--cached','--name-only", "ls-files','--others','--exclude-standard"]) assert.ok(agentChanges.includes(check));
  assert.match(finalizer, /Agent changes to CI\/control-plane files are forbidden/);

  for (const name of ['pi-pr-review.yml', 'pi-pr-fix.yml']) {
    const workflow = fs.readFileSync(`.github/workflows/${name}`, 'utf8');
    assert.match(workflow, /pi-common\/pr-guard\.mjs/);
    assert.match(workflow, /steps\.load\.outputs\.skip/);
  }

  const guard = fs.readFileSync('scripts/pi-common/pr-guard.mjs', 'utf8');
  assert.match(guard, /pages\(\`\/pulls\/\$\{prNumber\}\/files\`\)/);
  assert.match(guard, /pi:needs-human/);

  const gate = fs.readFileSync('scripts/pi-auto-merge.mjs', 'utf8');
  assert.match(gate, /controlPlanePaths\(paths\)/);
});


test('Reviewer, PR Fix, and Automation Control contain no inline GitHub REST implementation', () => {
  for (const name of ['pi-pr-review.yml', 'pi-pr-fix.yml', 'pi-automation-control.yml']) {
    const workflow = fs.readFileSync(`.github/workflows/${name}`, 'utf8');
    assert.doesNotMatch(workflow, /\bcurl\b/, name);
    assert.doesNotMatch(workflow, /api\.github\.com/, name);
  }
});


test('every model-driven Pi workflow uses the shared response-budget extension', () => {
  for (const name of ['pi-architect.yml', 'pi-dispatcher.yml', 'pi-issue-agent.yml', 'pi-pr-fix.yml', 'pi-pr-review.yml', 'pi-triage.yml']) {
    const workflow = fs.readFileSync(`.github/workflows/${name}`, 'utf8');
    assert.match(workflow, /pi-response-budget\.mjs/, `${name}: missing shared response-budget extension`);
  }
});

test('response-budget policy has one hard 8k ceiling and is independent of loop guard', () => {
  const extension = fs.readFileSync('scripts/pi-response-budget.mjs', 'utf8');
  const policy = fs.readFileSync('scripts/pi-common/response-budget-policy.mjs', 'utf8');
  const guard = fs.readFileSync('scripts/pi-loop-guard.mjs', 'utf8');
  assert.match(policy, /short:\s*2048/);
  assert.match(policy, /normal:\s*4096/);
  assert.match(policy, /deep:\s*8192/);
  assert.match(extension, /set_response_budget/);
  assert.match(extension, /session_start/);
  assert.doesNotMatch(guard, /set_response_budget|RESPONSE_BUDGETS|withResponseBudget/);
});


test('Pi result tools reuse the shared submit-nudge primitive', () => {
  for (const name of ['pi-architect-result-tool.mjs', 'pi-dispatcher-result-tool.mjs', 'pi-implementer-result-tool.mjs', 'pi-repair-result-tool.mjs', 'pi-reviewer-result-tool.mjs', 'pi-triage-result-tool.mjs']) {
    const source = fs.readFileSync(`scripts/${name}`, 'utf8');
    assert.match(source, /registerSubmitNudge/);
    assert.doesNotMatch(source, /pi\.on\(['"]agent_before_settle/);
  }
});

test('Triage submission is terminal and avoids a post-submit model turn', () => {
  const source = fs.readFileSync('scripts/pi-triage-result-tool.mjs', 'utf8');
  const agent = fs.readFileSync('agents/triage/AGENTS.md', 'utf8');
  assert.match(source, /terminalResult\('Result recorded\.'/);
  assert.match(agent, /do not narrate internal debate or print a prose classification list/i);
  assert.match(agent, /put the classifications directly in its arguments/i);
});

test('Pi result parsers reuse the shared tolerant JSONL reader', () => {
  for (const name of ['pi-architect.mjs', 'pi-dispatcher.mjs', 'pi-review-result.mjs', 'pi-triage.mjs']) {
    assert.match(fs.readFileSync(`scripts/${name}`, 'utf8'), /result-jsonl\.mjs/);
  }
});

test('publication helpers reuse one trusted git runner', () => {
  for (const name of ['issue-publication.mjs', 'repair-publication.mjs']) {
    const source = fs.readFileSync(`scripts/pi-common/${name}`, 'utf8');
    assert.match(source, /\.\/git\.mjs/);
    assert.doesNotMatch(source, /function git\(/);
  }
});


test('every model-driven workflow wires the shared safety extensions exactly once', () => {
  const workflows = ['pi-architect.yml', 'pi-dispatcher.yml', 'pi-issue-agent.yml', 'pi-pr-fix.yml', 'pi-pr-review.yml', 'pi-triage.yml'];
  for (const name of workflows) {
    const source = fs.readFileSync(`.github/workflows/${name}`, 'utf8');
    for (const extension of ['pi-bash-timeout.mjs', 'pi-response-budget.mjs']) {
      assert.equal(source.split(extension).length - 1, 1, `${name}: expected exactly one ${extension}`);
    }
  }
});

test('loop guard is limited to stages that need exploration/task-complexity control', () => {
  const guarded = new Set(['pi-architect.yml', 'pi-issue-agent.yml', 'pi-pr-review.yml', 'pi-triage.yml']);
  for (const name of ['pi-architect.yml', 'pi-dispatcher.yml', 'pi-issue-agent.yml', 'pi-pr-fix.yml', 'pi-pr-review.yml', 'pi-triage.yml']) {
    const source = fs.readFileSync(`.github/workflows/${name}`, 'utf8');
    assert.equal(source.includes('pi-loop-guard.mjs'), guarded.has(name), `${name}: unexpected loop-guard wiring`);
  }
});

test('agent prompts document their configured response-budget contract', () => {
  for (const name of ['architect', 'dispatcher', 'implementer', 'repair', 'reviewer']) {
    const source = fs.readFileSync(`agents/${name}/AGENTS.md`, 'utf8');
    assert.match(source, /set_response_budget/);
    assert.match(source, /SHORT[\s\S]*2048/);
    assert.match(source, /NORMAL[\s\S]*4096/);
    assert.match(source, /DEEP[\s\S]*8192/);
  }
  const triage = fs.readFileSync('agents/triage/AGENTS.md', 'utf8');
  assert.match(triage, /fixed maximum of \*\*1000 output tokens\*\*/);
  assert.match(triage, /`set_response_budget` is intentionally unavailable/);
  assert.match(fs.readFileSync('.github/workflows/pi-triage.yml', 'utf8'), /PI_FIXED_RESPONSE_MAX_TOKENS: '1000'/);
});


test('reviewer metrics carry the linked issue and trivial reviews use the fast-path contract', () => {
  const workflow = fs.readFileSync('.github/workflows/pi-pr-review.yml', 'utf8');
  const prompt = fs.readFileSync('agents/reviewer/AGENTS.md', 'utf8');
  assert.ok(workflow.includes('PI_ISSUE=$(jq -r \'.issue\' "$CONTEXT")'));
  assert.match(workflow, /trivial for a tiny self-contained diff/);
  assert.match(workflow, /do not rerun pytest, Ruff, or git diff --check/);
  assert.match(prompt, /### Trivial fast path/);
  assert.match(prompt, /History or prior attempts are valid when they materially answer a concrete question/);
  assert.match(prompt, /Never load skills for trivial reviews/);
  assert.ok(prompt.includes('**Never rerun them.**'));
  assert.ok(!prompt.includes('Before reviewing, read `docs/PROJECT_CONTEXT.md`'));
});


test('implementer orients and plans before declaring complexity', () => {
  const workflow = fs.readFileSync('.github/workflows/pi-issue-agent.yml', 'utf8');
  const agent = fs.readFileSync('agents/implementer/AGENTS.md', 'utf8');

  assert.match(workflow, /PI_REQUIRE_TASK_COMPLEXITY: '1'/);
  assert.match(workflow, /PI_PRE_COMPLEXITY_ALLOWED_TOOLS: 'read,bash'/);

  const contract = [
    'Read this `agents/implementer/AGENTS.md`',
    'Read the supplied GitHub issue',
    'Inspect only the current `dev` code directly relevant',
    'Write a short execution plan',
    '1000 output tokens',
    'Call `declare_task_complexity`',
    'Immediately execute the first plan item',
  ];
  let previous = -1;
  for (const marker of contract) {
    const position = agent.indexOf(marker);
    assert.ok(position > previous, `implementer startup marker missing or out of order: ${marker}`);
    previous = position;
  }

  assert.match(agent, /Do not modify repository files or perform implementation work before step 5 is complete/);
  assert.match(agent, /complex[\s\S]*implement[\s\S]*same issue[\s\S]*completion/i);
  assert.match(agent, /After successful `submit_result`, \*\*stop immediately\*\*/);
  assert.doesNotMatch(agent, /Before starting, read `docs\/PROJECT_CONTEXT\.md`/);
});

test('dispatcher stays a narrow scope classifier and does not treat complexity as decomposition', () => {
  const agent = fs.readFileSync('agents/dispatcher/AGENTS.md', 'utf8');
  assert.match(agent, /candidates.*authoritative/is);
  assert.match(agent, /Size alone is not a reason for ARCHITECT/);
  assert.match(agent, /Complexity alone is not a reason for ARCHITECT/);
  assert.match(agent, /Do not inspect repository code, project documentation, Git history/);
  assert.match(agent, /That classification is your entire job/);
  assert.doesNotMatch(agent, /Read `docs\/PROJECT_CONTEXT\.md`/);
});


test('architect decomposes only on real merge boundaries', () => {
  const workflow = fs.readFileSync('.github/workflows/pi-architect.yml', 'utf8');
  const agent = fs.readFileSync('agents/architect/AGENTS.md', 'utf8');
  assert.ok(agent.includes('Size alone is not a reason to split.'));
  assert.ok(agent.includes('Complexity alone is not a reason to split.'));
  assert.ok(agent.includes('Create the **minimum number** of independently mergeable steps required.'));
  assert.ok(agent.includes('Do not load planning skills for an obvious keep or simple revise.') || agent.includes('Do not load planning skills for an obvious `keep` or simple `revise`.'));
  assert.ok(agent.includes('Do not perform a general repository audit.'));
  assert.ok(!workflow.includes('agents/architect/AGENTS.md and docs/PROJECT_CONTEXT.md'));
});
