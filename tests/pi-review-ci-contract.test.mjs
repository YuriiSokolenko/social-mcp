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
  const stageConfig = fs.readFileSync('scripts/pi-common/stage-config.mjs', 'utf8');
  assert.match(workflow, /pi-run-stage\.mjs" repair/);
  assert.match(stageConfig, /repair:[\s\S]*resultTool: 'pi-repair-result-tool\.mjs'/);
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
  const stageConfig = fs.readFileSync('scripts/pi-common/stage-config.mjs', 'utf8');
  const worktree = fs.readFileSync('scripts/pi-common/issue-worktree.mjs', 'utf8');
  assert.match(worktree, /worktree', 'add', '-B'.*origin\/dev/s);
  assert.match(worktree, /merge-base', 'origin\/dev', resumeRef/);
  assert.match(worktree, /diff', '--binary', base, resumeRef/);
  assert.match(worktree, /apply', '--3way', patch/);
  assert.match(worktree, /checkpointExpected[\s\S]*issueBranchExpected/);
  assert.match(stageConfig, /dev is the only development base/);
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
  assert.match(repair, /if: steps\.publish\.outputs\.needs_review == 'true'/);
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

test('issue publication attributes only changes beyond integrated latest dev to the Implementer', () => {
  const publication = fs.readFileSync('scripts/pi-common/issue-publication.mjs', 'utf8');
  assert.match(publication, /merge-base','--is-ancestor','origin\/dev','HEAD'/);
  assert.match(publication, /return integrated \? 'origin\/dev' : startCommit/);
  assert.match(publication, /diff','--name-only',base,'HEAD'/);
  assert.doesNotMatch(publication, /diff','--name-only',startCommit,'HEAD'/);
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


test('every model-driven Pi workflow delegates model execution to one stage runner', () => {
  for (const name of ['pi-architect.yml', 'pi-dispatcher.yml', 'pi-issue-agent.yml', 'pi-pr-fix.yml', 'pi-pr-review.yml', 'pi-triage.yml']) {
    const workflow = fs.readFileSync(`.github/workflows/${name}`, 'utf8');
    assert.equal(workflow.split('pi-run-stage.mjs').length - 1, 1, `${name}: expected exactly one shared stage runner`);
    assert.doesNotMatch(workflow, /pi-(?:loop-guard|response-budget)\.mjs/);
    assert.doesNotMatch(workflow, /PI_TERMINAL_RESULT_FILE/);
  }
});

test('one progress controller owns loop safety, complexity, and response budgets', () => {
  const runtime = fs.readFileSync('scripts/pi-agent-runtime.mjs', 'utf8');
  const controller = fs.readFileSync('scripts/pi-common/progress-controller.mjs', 'utf8');
  assert.match(controller, /short: 2048/);
  assert.match(controller, /normal: 4096/);
  assert.match(controller, /deep: 8192/);
  assert.match(controller, /checkToolCall/);
  assert.match(controller, /nextResponseBudgetLevel/);
  assert.match(runtime, /declare_task_complexity/);
  assert.match(runtime, /set_response_budget/);
});

test('all Pi result tools reuse one terminal-tool helper', () => {
  for (const name of ['pi-architect-result-tool.mjs', 'pi-dispatcher-result-tool.mjs', 'pi-implementer-result-tool.mjs', 'pi-repair-result-tool.mjs', 'pi-reviewer-result-tool.mjs', 'pi-triage-result-tool.mjs']) {
    const source = fs.readFileSync(`scripts/${name}`, 'utf8');
    assert.match(source, /registerTerminalTool/);
    assert.doesNotMatch(source, /registerSubmitNudge|terminalResult|agent_before_settle/);
  }
  const helper = fs.readFileSync('scripts/pi-common/terminal-tool.mjs', 'utf8');
  assert.match(helper, /registerSubmitNudge/);
  assert.match(helper, /terminalResult/);
});

test('Triage submission uses the shared terminal contract', () => {
  const source = fs.readFileSync('scripts/pi-triage-result-tool.mjs', 'utf8');
  const agent = fs.readFileSync('agents/triage/AGENTS.md', 'utf8');
  assert.match(source, /registerTerminalTool/);
  assert.match(source, /customType: 'triage-result'/);
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


test('stage runner wires the shared safety/runtime extensions once for all agents', () => {
  const runner = fs.readFileSync('scripts/pi-run-stage.mjs', 'utf8');
  assert.equal(runner.split('pi-bash-timeout.mjs').length - 1, 1);
  assert.equal(runner.split('pi-agent-runtime.mjs').length - 1, 1);
  assert.match(runner, /config\.resultTool/);
});

test('stage configuration is the single source of per-agent runtime limits', () => {
  const config = fs.readFileSync('scripts/pi-common/stage-config.mjs', 'utf8');
  for (const name of ['architect', 'dispatcher', 'triage', 'reviewer', 'repair', 'implementer']) {
    assert.match(config, new RegExp(`${name}:[\\s\\S]*requiredFirstReadPath`));
  }
  assert.match(config, /dispatcher:[\s\S]*maxTurns: 30/);
  assert.match(config, /triage:[\s\S]*fixedResponseMaxTokens: 1000/);
});

test('agent prompts document the shared response-budget contract', () => {
  for (const name of ['architect', 'implementer', 'repair', 'reviewer', 'dispatcher']) {
    const source = fs.readFileSync(`agents/${name}/AGENTS.md`, 'utf8');
    assert.match(source, /set_response_budget/);
    assert.match(source, /SHORT[\s\S]*2048/);
    assert.match(source, /NORMAL[\s\S]*4096/);
    assert.match(source, /DEEP[\s\S]*8192/);
  }
  const triage = fs.readFileSync('agents/triage/AGENTS.md', 'utf8');
  assert.match(triage, /fixed maximum of \*\*1000 output tokens\*\*/);
  assert.match(triage, /`set_response_budget` is intentionally unavailable/);
  assert.match(fs.readFileSync('scripts/pi-common/stage-config.mjs', 'utf8'), /triage:[\s\S]*fixedResponseMaxTokens: 1000/);
});

test('reviewer metrics carry the linked issue and trivial reviews use the fast-path contract', () => {
  const workflow = fs.readFileSync('.github/workflows/pi-pr-review.yml', 'utf8');
  const runner = fs.readFileSync('scripts/pi-run-stage.mjs', 'utf8');
  const stageConfig = fs.readFileSync('scripts/pi-common/stage-config.mjs', 'utf8');
  const prompt = fs.readFileSync('agents/reviewer/AGENTS.md', 'utf8');
  assert.ok(workflow.includes('ISSUE=$(jq -r \'\.issue\' "$CONTEXT")'));
  assert.match(runner, /PI_ISSUE: env\.PI_ISSUE \?\? env\.ISSUE \?\? ''/);
  assert.match(runner, /writeGithubEnv\(env, 'PI_ISSUE', childEnv\.PI_ISSUE\)/);
  assert.match(prompt, /\*\*trivial\*\* — tiny self-contained diff/);
  assert.match(stageConfig, /do not rerun pytest, Ruff, or git diff --check/);
  assert.match(prompt, /### Trivial fast path/);
  assert.match(prompt, /History or prior attempts are valid when they materially answer a concrete question/);
  assert.match(prompt, /Never load skills for trivial reviews/);
  assert.ok(prompt.includes('**Never rerun them.**'));
  assert.ok(!prompt.includes('Before reviewing, read `docs/PROJECT_CONTEXT.md`'));
});
test('implementer plans before complexity and delegates repository inspection afterward', () => {
  const config = fs.readFileSync('scripts/pi-common/stage-config.mjs', 'utf8');
  const agent = fs.readFileSync('agents/implementer/AGENTS.md', 'utf8');
  assert.match(config, /implementer:[\s\S]*requireComplexity: true[\s\S]*preComplexityAllowedTools: \[\][\s\S]*delegatedTools: \['read', 'bash', 'grep', 'find', 'ls'\]/);
  const contract = [
    'Read this `agents/implementer/AGENTS.md`',
    'Use the GitHub issue title/body already supplied in the prompt',
    'Write a short top-level execution plan',
    '1000 output tokens',
    'The very next action after the plan must be `declare_task_complexity`',
    'Immediately execute the first plan item',
  ];
  let previous = -1;
  for (const marker of contract) {
    const position = agent.indexOf(marker);
    assert.ok(position > previous, `implementer startup marker missing or out of order: ${marker}`);
    previous = position;
  }
  assert.match(agent, /Do not modify repository files or perform implementation work before step 4 is complete/);
  assert.match(agent, /main agent must not call `read`, `bash`, `grep`, `find`, or `ls` directly/);
  assert.match(agent, /missing context is only one small file immediately before an edit/);
  assert.match(agent, /complex[\s\S]*implement this same issue to completion/i);
  assert.match(agent, /After successful `submit_result`, \*\*stop immediately\*\*/);
});

test('reviewer orients and plans before declaring complexity', () => {
  const config = fs.readFileSync('scripts/pi-common/stage-config.mjs', 'utf8');
  const agent = fs.readFileSync('agents/reviewer/AGENTS.md', 'utf8');
  assert.match(config, /reviewer:[\s\S]*requireComplexity: true[\s\S]*preComplexityAllowedTools: \['read', 'bash'\]/);
  for (const value of ['Read `agents/reviewer/AGENTS.md`', 'Read the linked issue', 'Inspect the complete PR diff', 'Write a concise review plan', '1000 tokens', 'Call `declare_task_complexity`', 'Continue the semantic review']) {
    assert.ok(agent.includes(value), `reviewer startup marker missing: ${value}`);
  }
});

test('repair orients and plans before declaring complexity', () => {
  const config = fs.readFileSync('scripts/pi-common/stage-config.mjs', 'utf8');
  const agent = fs.readFileSync('agents/repair/AGENTS.md', 'utf8');
  assert.match(config, /repair:[\s\S]*requireComplexity: true[\s\S]*preComplexityAllowedTools: \['read', 'bash'\]/);
  for (const value of ['Read `agents/repair/AGENTS.md`', 'Read the concrete blocking Reviewer finding', 'Inspect the PR diff', 'Write a short repair plan', '1000 output tokens', 'Call `declare_task_complexity`', 'Immediately execute the first plan item']) {
    assert.ok(agent.includes(value), `repair startup marker missing: ${value}`);
  }
});

test('dispatcher stays a narrow scope classifier and does not treat complexity as decomposition', () => {
  const agent = fs.readFileSync('agents/dispatcher/AGENTS.md', 'utf8');
  assert.match(agent, /candidates.*authoritative/is);
  assert.match(agent, /Size alone is not a reason for ARCHITECT/);
  assert.match(agent, /Complexity alone is not a reason for ARCHITECT/);
  assert.match(agent, /Read the project documentation once, before reading the dispatcher candidates/);
  assert.match(agent, /Do not repeatedly reread project documentation for each candidate/);
  assert.match(agent, /Do not inspect repository code, Git history, queue state/);
  assert.match(agent, /That classification is your entire job/);
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


test('repair preserves current dev behavior when a PR test is stale', () => {
  const repair = fs.readFileSync('agents/repair/AGENTS.md', 'utf8');
  assert.match(repair, /Current `dev` wins for behavior outside the repaired issue's scope/);
  assert.match(repair, /test carried by the PR expects behavior that contradicts confirmed current-`dev` behavior/);
  assert.match(repair, /treat the PR test expectation as stale/);
  assert.match(repair, /Preserve current-`dev` behavior/);
  assert.match(repair, /next tool call `edit` or `write`/i);
  assert.match(repair, /Do not redesign current `dev`, debate which side should win, or repeatedly reread the same evidence/);
});


test('deterministic review failure routes directly to PR Fix instead of stopping the pipeline', () => {
  const workflow = fs.readFileSync('.github/workflows/pi-pr-review.yml', 'utf8');
  assert.match(workflow, /name: Run deterministic review checks[\s\S]*?id: checks[\s\S]*?continue-on-error: true/);
  assert.match(workflow, /name: Mark deterministic check failure for repair[\s\S]*?steps\.checks\.outcome == 'failure'[\s\S]*?review-state\.mjs" dispatch "\$PR" CHANGES_REQUESTED/);
  assert.match(workflow, /name: Run independent review\n\s+if: steps\.load\.outputs\.skip != 'true' && steps\.checks\.outcome == 'success'/);
  assert.match(workflow, /name: Apply review result\n\s+if: steps\.load\.outputs\.skip != 'true' && steps\.checks\.outcome == 'success'/);
});

test('stage runner owns the terminal marker contract for every model-driven workflow', () => {
  const runner = fs.readFileSync('scripts/pi-run-stage.mjs', 'utf8');
  assert.match(runner, /PI_TERMINAL_RESULT_FILE/);
  assert.match(runner, /exited without its terminal tool/);
  for (const name of ['pi-architect.yml', 'pi-dispatcher.yml', 'pi-triage.yml', 'pi-pr-review.yml', 'pi-pr-fix.yml', 'pi-issue-agent.yml']) {
    const workflow = fs.readFileSync(`.github/workflows/${name}`, 'utf8');
    assert.doesNotMatch(workflow, /Require terminal .* result|PI_TERMINAL_RESULT_FILE/);
  }
});

test('DRAINING cannot create new issue work but still recovers published PR work', () => {
  for (const [name, step] of [
    ['pi-dispatcher.yml', 'Validate and start selected issues'],
    ['pi-triage.yml', 'Validate and apply triage decisions'],
    ['pi-architect.yml', 'Validate and publish child tasks'],
  ]) {
    const workflow = fs.readFileSync(`.github/workflows/${name}`, 'utf8');
    const index = workflow.indexOf(`- name: ${step}`);
    assert.ok(index >= 0, `${name}: missing ${step}`);
    assert.match(workflow.slice(index, index + 220), /if: vars\.PI_AUTOMATION_MODE == 'RUNNING'/);
  }
  const reconcile = fs.readFileSync('scripts/pi-reconcile.mjs', 'utf8');
  assert.match(reconcile, /issueRecoveryAllowed = automationMode === 'RUNNING'/);
  assert.match(reconcile, /prRecoveryAllowed = automationMode === 'RUNNING' \|\| automationMode === 'DRAINING'/);
  assert.match(reconcile, /issueRecoveryTarget/);
  assert.match(reconcile, /clear lost issue ownership without re-queueing/);
  assert.match(reconcile, /passed-pr-needs-merge-gate/);
  assert.match(reconcile, /pi-auto-merge\.yml/);
});

test('Architect split publication is two-phase and Dispatcher wakes only from ready labels', () => {
  const architect = fs.readFileSync('scripts/pi-architect.mjs', 'utf8');
  const reconcile = fs.readFileSync('scripts/pi-reconcile.mjs', 'utf8');
  const workflow = fs.readFileSync('.github/workflows/pi-architect.yml', 'utf8');
  assert.match(architect, /architect-children:/);
  assert.match(architect, /body: parentBody[\s\S]*architect:epic/);
  assert.match(architect, /dispatcher:ready/);
  assert.match(reconcile, /partial-architect-split-child/);
  assert.doesNotMatch(workflow, /Wake Dispatcher after Architect publication|workflow-dispatch\.mjs" pi-dispatcher\.yml/);
  assert.match(fs.readFileSync('.github/workflows/pi-dispatcher.yml', 'utf8'), /github\.event\.label\.name == 'dispatcher:ready'/);
});

test('terminal result parsers do not accept legacy free-text markers', () => {
  for (const [name, forbidden] of [
    ['pi-architect.mjs', 'ARCHITECT_RESULT:'],
    ['pi-dispatcher.mjs', 'DISPATCH_RESULT:'],
    ['pi-triage.mjs', 'TRIAGE_RESULT:'],
  ]) {
    const source = fs.readFileSync(`scripts/${name}`, 'utf8');
    assert.match(source, /expected submit_result tool output|Expected submit_result tool output/);
    assert.doesNotMatch(source, new RegExp("startsWith\\(['\"]" + forbidden.replace(/[.*+?^$\{\}()|[\]\\]/g, '\\$&')));
  }
  const review = fs.readFileSync('scripts/pi-review-result.mjs', 'utf8');
  assert.match(review, /did not call submit_result/);
  assert.doesNotMatch(review, /matchAll\(\/\^\[ \\t\]/);
});

test('publication never invents a successful result and PR Fix publishes a clean integrated HEAD', () => {
  const issuePublication = fs.readFileSync('scripts/pi-common/issue-publication.mjs', 'utf8');
  assert.match(issuePublication, /Implementer result metadata is required before PR publication/);
  assert.doesNotMatch(issuePublication, /See the diff for implementation details/);

  const repair = fs.readFileSync('scripts/pi-common/repair-publication.mjs', 'utf8');
  assert.match(repair, /const localHead = git\(\['rev-parse','HEAD'\]/);
  assert.match(repair, /if \(localHead === expectedHead\) return/);
  assert.match(repair, /\$\{localHead\}:refs\/heads\/\$\{headRef\}/);
});

test('trusted subprocess and GitHub IO share bounded infrastructure helpers', () => {
  const processHelper = fs.readFileSync('scripts/pi-common/process.mjs', 'utf8');
  assert.match(processHelper, /spawnSync/);
  assert.match(processHelper, /timeout:/);
  assert.match(processHelper, /SIGKILL/);

  for (const name of ['agent-change-policy.mjs', 'issue-worktree.mjs', 'finalize-product-tree.mjs']) {
    const source = fs.readFileSync(`scripts/pi-common/${name}`, 'utf8');
    assert.match(source, /\.\/git\.mjs/);
    assert.doesNotMatch(source, /node:child_process/);
  }
  const repair = fs.readFileSync('scripts/pi-common/repair-publication.mjs', 'utf8');
  assert.doesNotMatch(repair, /spawnSync\('rm'/);

  const github = fs.readFileSync('scripts/pi-common/github-api.mjs', 'utf8');
  assert.match(github, /AbortSignal\.timeout/);
  assert.match(github, /PI_GITHUB_HTTP_TIMEOUT_MS/);
  const usage = fs.readFileSync('scripts/pi-usage-collect.mjs', 'utf8');
  assert.match(usage, /githubClient/);
  assert.doesNotMatch(usage, /https:\/\/api\.github\.com/);
});

test('log rendering finalizes after continuations and redacts generic secret fields', () => {
  const source = fs.readFileSync('scripts/pi-log-filter.mjs', 'utf8');
  assert.match(source, /lastAgentEndSeen/);
  assert.match(source, /reportFinal\(lastAgentEndSeen \? "completed" : "interrupted"\)/);
  assert.match(source, /private\[_-\]\?key/);
});


test('stage runner owns model phase and issue metadata', () => {
  const runner = fs.readFileSync('scripts/pi-run-stage.mjs', 'utf8');
  const config = fs.readFileSync('scripts/pi-common/stage-config.mjs', 'utf8');
  assert.match(runner, /PI_PHASE: env\.PI_PHASE \?\? config\.phase \?\? stage/);
  assert.match(runner, /writeGithubEnv\(env, 'PI_PHASE', childEnv\.PI_PHASE\)/);
  for (const phase of ['architect', 'dispatcher', 'triage', 'review', 'repair', 'implementation']) {
    assert.ok(config.includes(`phase: '${phase}'`));
  }
  for (const name of ['pi-architect.yml', 'pi-pr-review.yml', 'pi-pr-fix.yml', 'pi-issue-agent.yml']) {
    const workflow = fs.readFileSync(`.github/workflows/${name}`, 'utf8');
    assert.doesNotMatch(workflow, /^\s+PI_PHASE:/m);
    assert.doesNotMatch(workflow, /^\s+PI_ISSUE:/m);
  }
});


test('implementer publication does not transport unused issue title or deleted task files', () => {
  const workflow = fs.readFileSync('.github/workflows/pi-issue-agent.yml', 'utf8');
  const publication = fs.readFileSync('scripts/pi-common/issue-publication.mjs', 'utf8');
  const worktree = fs.readFileSync('scripts/pi-common/issue-worktree.mjs', 'utf8');
  assert.doesNotMatch(workflow, /PI_ISSUE_TITLE|pi-task-/);
  assert.doesNotMatch(publication, /issueTitle/);
  assert.doesNotMatch(worktree, /taskFile|\[task-file\]/);
});


test('model workflows use native GITHUB_REPOSITORY instead of redundant repository aliases', () => {
  for (const name of ['pi-architect.yml', 'pi-dispatcher.yml', 'pi-triage.yml', 'pi-pr-review.yml', 'pi-pr-fix.yml', 'pi-issue-agent.yml']) {
    const workflow = fs.readFileSync(`.github/workflows/${name}`, 'utf8');
    assert.doesNotMatch(workflow, /^\s+(?:REPO|GITHUB_REPOSITORY):\s*\$\{\{ github\.repository \}\}/m);
  }
  const issue = fs.readFileSync('.github/workflows/pi-issue-agent.yml', 'utf8');
  const architect = fs.readFileSync('.github/workflows/pi-architect.yml', 'utf8');
  assert.match(issue, /\$\{GITHUB_REPOSITORY\}\/actions\/runs/);
  assert.match(architect, /\$\{GITHUB_REPOSITORY\}\/actions\/runs/);
});
