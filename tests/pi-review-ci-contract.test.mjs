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
  assert.match(gate, /pi-pr-fix\.yml\/dispatches/);
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
    'pi-dispatcher.yml',
    'pi-issue-agent.yml',
    'pi-pr-fix.yml',
    'pi-pr-review.yml',
    'pi-reconcile.yml',
    'pi-triage.yml',
    'pi-usage.yml',
  ];
  for (const name of workflows) {
    const workflow = fs.readFileSync(`.github/workflows/${name}`, 'utf8');
    assert.match(
      workflow,
      /uses:\s*actions\/checkout@v\d+[\s\S]*?with:[\s\S]*?ref:\s*dev/,
      `${name}: control-plane checkout must be pinned to dev`,
    );
  }

  const ci = fs.readFileSync('.github/workflows/ci.yml', 'utf8');
  assert.doesNotMatch(ci, /GITHUB_WORKSPACE\/scripts\/pi-|(?:node|bash)\s+scripts\/pi-/);
});


test('implementer resolves latest-dev integration inside the live agent session before publication', () => {
  const workflow = fs.readFileSync('.github/workflows/pi-issue-agent.yml', 'utf8');
  const tool = fs.readFileSync('scripts/pi-implementer-result-tool.mjs', 'utf8');
  assert.doesNotMatch(workflow, /name: Integrate latest dev before publication/);
  assert.match(tool, /fetch', 'origin', 'dev/);
  assert.match(tool, /merge', '--no-edit', 'origin\/dev/);
  assert.match(tool, /Merge conflicts are still unresolved|Latest dev conflicts with the implementation/);
  assert.match(tool, /pytest/);
  assert.match(tool, /ruff/);
  assert.match(workflow, /pi-pr-review\.yml\/dispatches/);
  assert.doesNotMatch(workflow, /name: Wake merge gate/);
});

test('review PASS is required before merge gate can merge', () => {
  const review = fs.readFileSync('.github/workflows/pi-pr-review.yml', 'utf8');
  const gate = fs.readFileSync('scripts/pi-auto-merge.mjs', 'utf8');
  assert.match(review, /Run deterministic review checks/);
  assert.match(review, /review:passed/);
  assert.match(review, /Wake merge gate after PASS/);
  assert.match(gate, /review:passed/);
});

test('PR fix resolves current-dev conflicts in the live repair session and returns to fresh review', () => {
  const workflow = fs.readFileSync('.github/workflows/pi-pr-fix.yml', 'utf8');
  const tool = fs.readFileSync('scripts/pi-repair-result-tool.mjs', 'utf8');
  assert.match(workflow, /pi-repair-result-tool\.mjs/);
  assert.match(tool, /fetch', 'origin', 'dev/);
  assert.match(tool, /merge', '--no-edit', 'origin\/dev/);
  assert.match(tool, /PR conflicts with current dev/);
  assert.match(tool, /pytest/);
  assert.match(tool, /ruff/);
  assert.match(workflow, /name: Start fresh review/);
  assert.match(workflow, /pi-pr-review\.yml\/dispatches/);
  assert.doesNotMatch(workflow, /name: Wake merge gate/);
});


test('stale reviewer verdict is discarded and current PR head is reviewed again', () => {
  const workflow = fs.readFileSync('.github/workflows/pi-pr-review.yml', 'utf8');
  assert.match(workflow, /PR changed during review; clearing stale verdict and scheduling a fresh review/);
  assert.match(workflow, /STALE_REVIEW=true/);
  assert.match(workflow, /name: Restart review after PR head changed/);
  assert.match(workflow, /pi-pr-review\.yml\/dispatches/);
});


test('implementer resume always rebases saved work onto latest dev and never uses main as a base', () => {
  const workflow = fs.readFileSync('.github/workflows/pi-issue-agent.yml', 'utf8');
  assert.match(workflow, /git worktree add -B "pi\/issue-\$\{ISSUE\}" "\$JOB_DIR" origin\/dev/);
  assert.match(workflow, /git merge-base origin\/dev "\$RESUME_REF"/);
  assert.match(workflow, /git diff --binary "\$BASE" "\$RESUME_REF"/);
  assert.match(workflow, /git -C "\$JOB_DIR" apply --3way/);
  assert.doesNotMatch(workflow, /START_REF="refs\/remotes\/origin\/\$\{CHECKPOINT\}"/);
  assert.doesNotMatch(workflow, /git rev-parse "\$\{START_REF\}\^"/);
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
  assert.match(gate, /pi-pr-fix\.yml\/dispatches/);
  assert.match(workflow, /permissions:\n(?:\s+.*\n)*?\s+actions: write/);
});


test('green dev CI wakes merge gate without parsing commit-message conventions', () => {
  const workflow = fs.readFileSync('.github/workflows/ci.yml', 'utf8');
  assert.match(workflow, /if: github\.event_name == 'push' && github\.ref == 'refs\/heads\/dev' && success\(\)/);
  assert.doesNotMatch(workflow, /contains\(github\.event\.head_commit\.message/);
});


test('pi:needs-human on a PR stops review, repair, and merge automation', () => {
  const review = fs.readFileSync('.github/workflows/pi-pr-review.yml', 'utf8');
  const repair = fs.readFileSync('.github/workflows/pi-pr-fix.yml', 'utf8');
  const merge = fs.readFileSync('scripts/pi-auto-merge.mjs', 'utf8');
  assert.match(review, /index\("pi:needs-human"\)/);
  assert.match(repair, /index\("pi:needs-human"\)/);
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
    assert.match(workflow, /id: load[\s\S]*?echo "skip=true" >> "\$GITHUB_OUTPUT"/);
    assert.match(workflow, /Create (?:review|PR) worktree\n\s+if: steps\.load\.outputs\.skip != 'true'/);
  }
});


test('implementer checkpoint never commits unresolved replay conflicts', () => {
  const workflow = fs.readFileSync('.github/workflows/pi-issue-agent.yml', 'utf8');
  const conflictCheck = workflow.indexOf('git diff --name-only --diff-filter=U');
  const stage = workflow.indexOf('git add -A', conflictCheck);
  assert.ok(conflictCheck >= 0 && stage > conflictCheck);
  assert.match(workflow, /preserving the previous checkpoint instead of saving conflict markers/);
});


test('review verdict exists only for the unchanged reviewed PR head', () => {
  const review = fs.readFileSync('.github/workflows/pi-pr-review.yml', 'utf8');
  const repair = fs.readFileSync('.github/workflows/pi-pr-fix.yml', 'utf8');
  assert.match(review, /PR changed during review; clearing stale verdict/);
  assert.match(review, /CURRENT_HEAD[\s\S]*?select\(startswith\("review:"\) \| not\)/);
  assert.doesNotMatch(repair, /Load PR[\s\S]{0,1200}?select\(startswith\("review:"\) \| not\)/);
  assert.match(repair, /Start fresh review[\s\S]*?select\(startswith\("review:"\) \| not\)/);
  assert.match(repair, /id: publish[\s\S]*?pi:needs-human[\s\S]*?published=false[\s\S]*?published=true/);
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


test('merge gate coalesces redundant wakes instead of queueing every scan', () => {
  const workflow = fs.readFileSync('.github/workflows/pi-auto-merge.yml', 'utf8');
  assert.match(workflow, /concurrency:\n\s+group: pi-auto-merge\n\s+cancel-in-progress: false/);
  assert.doesNotMatch(workflow, /queue: max/);
});


test('reviewer rechecks the human gate before publishing a verdict', () => {
  const review = fs.readFileSync('.github/workflows/pi-pr-review.yml', 'utf8');
  assert.match(review, /Apply review result[\s\S]*?PR_JSON=.*pulls\/\$\{PR\}[\s\S]*?pi:needs-human[\s\S]*?HUMAN_GATED=true[\s\S]*?exit 0/);
  assert.match(review, /Restart review after PR head changed[\s\S]*?env\.HUMAN_GATED != 'true'/);
});
