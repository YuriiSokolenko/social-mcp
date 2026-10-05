import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readScript } from './helpers/resolved-source.mjs';

import { issueBranch, checkpointBranch, projectConfig } from '../scripts/pi-common/project-config.mjs';
import { isControlPlanePath } from '../scripts/pi-common/control-plane-policy.mjs';

test('CI validates the committed dev state without synthetic PR integration inputs', () => {
  const workflow = fs.readFileSync('.github/workflows/ci.yml', 'utf8');
  assert.match(workflow, /^\s*push:/m);
  assert.doesNotMatch(workflow, /integration_base_sha|target_sha|target_ref|exact[- ]pair/i);
  assert.doesNotMatch(workflow, /git merge --no-ff|social-mcp\/integration/);
});

test('merge gate requires green CI for the exact current PR head without synthetic integration state', () => {
  const gate = readScript('scripts/pi-auto-merge.mjs', 'utf8');
  assert.match(gate, /actions\/workflows\/.*\/runs\?event=pull_request&head_sha=/);
  assert.match(gate, /head_sha=/);
  assert.match(gate, /pr\.head\.sha/);
  assert.match(gate, /ci\.state === 'pending'/);
  assert.match(gate, /ci\.state === 'code_failure'/);
  assert.match(gate, /ci\.state === 'infra_failure'/);
  assert.match(gate, /review:changes-requested/);
  assert.doesNotMatch(gate, /integration_base_sha|repair_base_sha|BASE_SHA|social-mcp\/integration|social-mcp\/pi-review/i);
  assert.match(gate, /dispatchWorkflow\('pi-pr-fix\.yml'/);
  assert.match(gate, /merge_method: 'squash'/);
});

test('architecture guard keeps exact-head PR CI but rejects synthetic dev-pair orchestration', () => {
  const guard = fs.readFileSync('docs/ci-architecture.md', 'utf8');
  assert.match(guard, /exact PR HEAD.*CI/is);
  assert.match(guard, /before merge/is);
  assert.match(guard, /Do not reintroduce/i);
  assert.match(guard, /captured dev SHA|synthetic/i);
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
    'pi-review-invalidate.yml',
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


test('implementer integrates latest dev before shared post-backend validation and publication', () => {
  const workflow = fs.readFileSync('.github/workflows/pi-issue-agent.yml', 'utf8');
  const tool = readScript('scripts/pi-implementer-result-tool.mjs', 'utf8');
  assert.doesNotMatch(workflow, /name: Integrate latest dev before publication/);
  const finalizer = readScript('scripts/pi-common/finalize-product-tree.mjs', 'utf8');
  assert.match(tool, /integrateLatestDev/);
  assert.match(finalizer, /fetch', 'origin', 'dev/);
  assert.match(finalizer, /merge', '--no-edit', 'origin\/dev/);
  assert.match(tool, /Merge conflicts are still unresolved|Latest dev conflicts with the implementation/);
  const validation = readScript('scripts/pi-common/stage-validation-recovery.mjs', 'utf8');
  const runner = readScript('scripts/pi-run-stage.mjs', 'utf8');
  assert.doesNotMatch(tool, /validateFinalProductTree/);
  assert.match(validation, /validateFinalProductTree/);
  assert.match(
    validation,
    /result = await runBackendAttempt\(currentSpec, runBackend\)[\s\S]*validate\(\{[\s\S]*cwd: spec\.cwd,[\s\S]*ledgerPath: spec\.environment\.PI_VALIDATION_LEDGER_FILE,[\s\S]*backend: result\.backend,[\s\S]*env: spec\.environment,[\s\S]*\}\)/,
  );
  assert.match(runner, /runStageWithValidationRecovery\(spec, runBackend,/);
  assert.match(runner, /return await runSelectedStage\(spec, \{ backend, workspace \}\)/);
  const publication = readScript('scripts/pi-common/issue-publication.mjs', 'utf8');
  assert.match(workflow, /issue-publication\.mjs" review/);
  assert.match(publication, /dispatchWorkflow\('pi-pr-review\.yml'/);
  assert.doesNotMatch(workflow, /name: Wake merge gate/);
});

test('review PASS is required before merge gate can merge', () => {
  const review = fs.readFileSync('.github/workflows/pi-pr-review.yml', 'utf8');
  const gate = readScript('scripts/pi-auto-merge.mjs', 'utf8');
  assert.match(review, /Run deterministic review checks/);
  assert.match(readScript('scripts/pi-common/review-state.mjs', 'utf8'), /review:passed/);
  assert.match(review, /Wake merge gate after PASS/);
  assert.match(gate, /review:passed/);
});

test('PR fix resolves current-dev conflicts in the live repair session and returns to fresh review', () => {
  const workflow = fs.readFileSync('.github/workflows/pi-pr-fix.yml', 'utf8');
  const tool = readScript('scripts/pi-repair-result-tool.mjs', 'utf8');
  const stageConfig = readScript('scripts/pi-common/stage-config.mjs', 'utf8');
  assert.match(workflow, /pi-run-stage\.mjs" repair/);
  assert.match(stageConfig, /repair:[\s\S]*resultTool: 'pi-repair-result-tool\.mjs'/);
  const finalizer = readScript('scripts/pi-common/finalize-product-tree.mjs', 'utf8');
  assert.match(tool, /integrateLatestDev/);
  assert.match(tool, /validateFinalProductTree/);
  assert.match(finalizer, /fetch', 'origin', 'dev/);
  assert.match(finalizer, /merge', '--no-edit', 'origin\/dev/);
  assert.match(tool, /PR conflicts with current dev/);
  assert.match(finalizer, /runProductChecks\(\{ cwd, ledgerPath, backend, env \}\)/);
  assert.match(workflow, /name: Start fresh review/);
  assert.match(readScript('scripts/pi-common/repair-publication.mjs', 'utf8'), /dispatchWorkflow\('pi-pr-review\.yml'/);
  assert.doesNotMatch(workflow, /name: Wake merge gate/);
});

test('stale reviewer verdict is discarded without self-rescheduling', () => {
  const workflow = fs.readFileSync('.github/workflows/pi-pr-review.yml', 'utf8');
  const state = readScript('scripts/pi-common/review-state.mjs', 'utf8');
  assert.match(state, /pr\.head\.sha !== reviewedHead/);
  assert.match(state, /status: 'stale'/);
  assert.match(workflow, /STALE_REVIEW=true/);
  assert.doesNotMatch(workflow, /name: Restart review after PR head changed/);
});


test('implementer resume always rebases saved work onto latest dev and never uses main as a base', () => {
  const agent = fs.readFileSync('agents/implementer/AGENTS.md', 'utf8');
  const worktree = readScript('scripts/pi-common/issue-worktree.mjs', 'utf8');
  assert.match(worktree, /worktree', 'add', '-B'.*origin\/dev/s);
  assert.match(worktree, /merge-base', 'origin\/dev', resumeRef/);
  assert.match(worktree, /diff', '--binary', base, resumeRef/);
  assert.match(worktree, /apply', '--3way', patch/);
  assert.match(worktree, /checkpointExpected[\s\S]*issueBranchExpected/);
  assert.match(agent, /latest fetched `origin\/dev`/);
  assert.doesNotMatch(agent, /origin\/main/);
});


test('Pi usage is isolated from dev and metrics pushes do not run project CI', () => {
  const collector = readScript('scripts/pi-usage-collect.mjs', 'utf8');
  const ci = fs.readFileSync('.github/workflows/ci.yml', 'utf8');
  assert.match(collector, /const metricsBranch = "pi-metrics"/);
  assert.match(collector, /ref=\$\{metricsBranch\}/);
  assert.match(collector, /branch: metricsBranch/);
  assert.doesNotMatch(collector, /ref=dev/);
  assert.match(ci, /push:\n\s+branches: \[dev\]/);
});


test('merge gate has permission for its late-conflict PR Fix dispatch', () => {
  const workflow = fs.readFileSync('.github/workflows/pi-auto-merge.yml', 'utf8');
  const gate = readScript('scripts/pi-auto-merge.mjs', 'utf8');
  assert.match(gate, /dispatchWorkflow\('pi-pr-fix\.yml'/);
  assert.match(workflow, /permissions:\n(?:\s+.*\n)*?\s+actions: write/);
});


test('terminal PR CI wakes only from completed workflow_run while authoritative dev CI keeps its direct continuation', () => {
  const ci = fs.readFileSync('.github/workflows/ci.yml', 'utf8');
  const terminalWake = fs.readFileSync('.github/workflows/ci-terminal-wake.yml', 'utf8');

  assert.match(ci, /always\(\)/);
  assert.match(ci, /contains\(fromJSON\('\["push","workflow_dispatch"\]'\), github\.event_name\)/);
  assert.match(ci, /github\.ref == 'refs\/heads\/dev'/);
  assert.match(ci, /Continue merge queue after green dev CI/);
  assert.doesNotMatch(ci, /github\.event_name == 'pull_request' \|\|/);

  assert.match(terminalWake, /workflow_run:/);
  assert.match(terminalWake, /workflows: \["CI"\]/);
  assert.match(terminalWake, /types: \[completed\]/);
  assert.match(terminalWake, /workflow_run\.event == 'pull_request'/);
  assert.match(terminalWake, /workflow_run\.head_repository\.full_name == github\.repository/);
  assert.match(terminalWake, /runs-on: \[self-hosted, n150, control\]/);
  assert.doesNotMatch(terminalWake, /runs-on: \[self-hosted[^\n]*n150[^\n]*general/);
  assert.match(
    terminalWake,
    /concurrency:\n\s+group: ci-terminal-wake-\$\{\{ github\.event\.workflow_run\.id \}\}\n\s+cancel-in-progress: false/,
  );
  assert.doesNotMatch(terminalWake, /workflow_run\.conclusion/);
  assert.match(terminalWake, /ref: dev/);
  assert.match(terminalWake, /workflow-dispatch\.mjs pi-auto-merge\.yml/);
  assert.doesNotMatch(terminalWake, /workflow_run\.head_sha|workflow_run\.pull_requests/);
  assert.doesNotMatch(terminalWake, /workflows: \["CI Terminal Wake"\]/);
  assert.doesNotMatch(ci, /contains\(github\.event\.head_commit\.message/);
});

test('dedicated control runner label is reserved for terminal-wake orchestration', () => {
  const workflowDir = '.github/workflows';

  const stripComment = (value) => value.replace(/\s+#.*$/, '').trim();
  const normalizeLabel = (value) => value.trim().replace(/^['"]|['"]$/g, '').toLowerCase();
  const simpleScalar = /^[a-z0-9_.-]+$/i;

  const parseList = (value) => {
    const clean = stripComment(value).trim();
    if (!clean.startsWith('[') || !clean.endsWith(']')) return null;
    const labels = clean.slice(1, -1).split(',').map(normalizeLabel).filter(Boolean);
    return labels.every(label => simpleScalar.test(label)) ? labels : null;
  };

  const runsOnSpecs = (workflow) => {
    const lines = workflow.split('\n');
    const specs = [];

    for (let i = 0; i < lines.length; i += 1) {
      const match = /^(\s*)runs-on:\s*(.*)$/.exec(lines[i]);
      if (!match) continue;

      const baseIndent = match[1].length;
      const inline = stripComment(match[2]);
      if (inline) {
        if (inline.includes('${{')) {
          specs.push({ parsed: false, labels: [], group: null, raw: inline });
          continue;
        }

        const list = parseList(inline);
        if (list) {
          specs.push({ parsed: true, labels: list, group: null, raw: inline });
          continue;
        }

        const scalar = normalizeLabel(inline);
        specs.push({
          parsed: simpleScalar.test(scalar),
          labels: simpleScalar.test(scalar) ? [scalar] : [],
          group: null,
          raw: inline,
        });
        continue;
      }

      const blockLines = [];
      for (let j = i + 1; j < lines.length; j += 1) {
        const line = lines[j];
        if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
        const indent = /^(\s*)/.exec(line)[1].length;
        if (indent <= baseIndent) break;
        blockLines.push(stripComment(line.trim()));
      }

      if (blockLines.some(line => line.includes('${{'))) {
        specs.push({ parsed: false, labels: [], group: null, raw: blockLines.join(' ') });
        continue;
      }

      let parsed = true;
      let group = null;
      const labels = [];
      let sawStructuredKey = false;

      for (let j = 0; j < blockLines.length; j += 1) {
        const line = blockLines[j];
        const groupMatch = /^group:\s*(.+)$/.exec(line);
        if (groupMatch) {
          sawStructuredKey = true;
          const value = normalizeLabel(groupMatch[1]);
          if (!simpleScalar.test(value)) parsed = false;
          else group = value;
          continue;
        }

        const labelsMatch = /^labels:\s*(.*)$/.exec(line);
        if (labelsMatch) {
          sawStructuredKey = true;
          const value = labelsMatch[1].trim();
          if (value) {
            const inlineLabels = parseList(value);
            if (inlineLabels) labels.push(...inlineLabels);
            else {
              const scalar = normalizeLabel(value);
              if (!simpleScalar.test(scalar)) parsed = false;
              else labels.push(scalar);
            }
            continue;
          }

          let k = j + 1;
          for (; k < blockLines.length && /^-\s+/.test(blockLines[k]); k += 1) {
            const label = normalizeLabel(blockLines[k].replace(/^-\s+/, ''));
            if (!simpleScalar.test(label)) parsed = false;
            else labels.push(label);
          }
          j = k - 1;
          continue;
        }

        if (!sawStructuredKey && /^-\s+/.test(line)) {
          const label = normalizeLabel(line.replace(/^-\s+/, ''));
          if (!simpleScalar.test(label)) parsed = false;
          else labels.push(label);
          continue;
        }

        parsed = false;
      }

      if (labels.length === 0 && group === null) parsed = false;
      specs.push({ parsed, labels, group, raw: blockLines.join(' ') });
    }

    return specs;
  };

  const exactLabels = (labels, expected) =>
    labels.length === expected.length && expected.every(label => labels.includes(label));

  const controlRunnerLabels = new Set(['self-hosted', 'linux', 'x64', 'n150', 'control']);
  const canMatchControlRunner = (spec) =>
    spec.parsed &&
    spec.group === null &&
    spec.labels.length > 0 &&
    spec.labels.every(label => controlRunnerLabels.has(label));

  const assertWorkflowIsolation = (name, workflow, terminalWake = false) => {
    for (const line of workflow.split('\n')) {
      const code = stripComment(line);
      if (!/runs-on\s*:/.test(code) && !/["']runs-on["']\s*:/.test(code)) continue;
      assert.match(
        code,
        /^\s*runs-on:\s*/,
        `${name}: runs-on must use the canonical unquoted block/scalar key form`,
      );
    }

    const specs = runsOnSpecs(workflow);
    for (const spec of specs) {
      assert.equal(
        spec.parsed,
        true,
        `${name}: runs-on must be statically parseable; dynamic or unknown forms are forbidden`,
      );
    }

    if (terminalWake) {
      assert.ok(
        specs.length > 0 &&
          specs.every(spec => spec.group === null && exactLabels(spec.labels, ['self-hosted', 'n150', 'control'])),
        `${name}: terminal wake must target exactly self-hosted,n150,control with no runner group`,
      );
      return;
    }

    for (const spec of specs) {
      assert.ok(
        !spec.labels.includes('control'),
        `${name}: control label must stay reserved for terminal-wake orchestration`,
      );
      assert.equal(
        canMatchControlRunner(spec),
        false,
        `${name}: runs-on labels must not be satisfiable by the dedicated control runner`,
      );
    }
  };

  assert.throws(
    () => assertWorkflowIsolation(
      'dynamic-fixture.yml',
      'jobs:\n  unsafe:\n    runs-on: [self-hosted, ${{ matrix.pool }}]',
    ),
    /statically parseable/,
    'dynamic runs-on expressions must fail through the same validator used for real workflows',
  );

  assert.throws(
    () => assertWorkflowIsolation(
      'quoted-key-fixture.yaml',
      'jobs:\n  unsafe:\n    "runs-on": [self-hosted, n150]',
    ),
    /canonical unquoted/,
    'quoted runs-on keys must fail closed instead of bypassing parsing',
  );

  assert.throws(
    () => assertWorkflowIsolation(
      'flow-map-fixture.yaml',
      'jobs: { unsafe: { runs-on: [self-hosted, n150] } }',
    ),
    /canonical unquoted/,
    'flow-map runs-on forms must fail closed instead of bypassing parsing',
  );

  assert.throws(
    () => assertWorkflowIsolation(
      'case-fixture.yml',
      'jobs:\n  unsafe:\n    runs-on: [self-hosted, Linux, X64, n150]',
    ),
    /must not be satisfiable/,
    'label matching must be case-insensitive like GitHub',
  );

  const groupWithComment = runsOnSpecs(
    'jobs:\n  heavy:\n    runs-on:\n      group: control-machines\n      labels: [self-hosted, n150, general] # control only in comment',
  )[0];
  assert.deepEqual(
    { parsed: groupWithComment.parsed, labels: groupWithComment.labels, group: groupWithComment.group },
    { parsed: true, labels: ['self-hosted', 'n150', 'general'], group: 'control-machines' },
    'runner group names and comments must not be mistaken for control labels',
  );

  const workflowNames = fs.readdirSync(workflowDir).filter(name => /\.ya?ml$/.test(name));
  for (const name of workflowNames) {
    const workflow = fs.readFileSync(`${workflowDir}/${name}`, 'utf8');
    assertWorkflowIsolation(
      name,
      workflow,
      name === 'ci-terminal-wake.yml' || name === 'ci-terminal-wake.yaml',
    );
  }

  for (const name of ['ci.yml', 'pi-auto-merge.yml']) {
    const workflow = fs.readFileSync(`${workflowDir}/${name}`, 'utf8');
    assert.ok(
      runsOnSpecs(workflow).some(spec => spec.labels.includes('n150') && spec.labels.includes('general')),
      `${name}: heavy/general work must stay on n150/general`,
    );
  }
});

test('pi:needs-human on a PR stops review, repair, and merge automation', () => {
  const guard = readScript('scripts/pi-common/pr-guard.mjs', 'utf8');
  const reviewState = readScript('scripts/pi-common/review-state.mjs', 'utf8');
  const repairPublication = readScript('scripts/pi-common/repair-publication.mjs', 'utf8');
  const merge = readScript('scripts/pi-auto-merge.mjs', 'utf8');
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
  const publication = readScript('scripts/pi-common/issue-publication.mjs', 'utf8');
  const conflictCheck = publication.indexOf("'diff','--name-only','--diff-filter=U'");
  const stage = publication.indexOf("'add','-A'", conflictCheck);
  assert.ok(conflictCheck >= 0 && stage > conflictCheck);
  assert.match(publication, /reason:'conflicts'/);
});


test('review verdict exists only for the unchanged reviewed PR head', () => {
  const review = fs.readFileSync('.github/workflows/pi-pr-review.yml', 'utf8');
  const repair = fs.readFileSync('.github/workflows/pi-pr-fix.yml', 'utf8');
  const reviewState = readScript('scripts/pi-common/review-state.mjs', 'utf8');
  const repairPublication = readScript('scripts/pi-common/repair-publication.mjs', 'utf8');
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
  const reconcile = readScript('scripts/pi-reconcile.mjs', 'utf8');
  assert.match(reconcile, /liveReviews/);
  assert.match(reconcile, /liveFixes/);
  assert.match(reconcile, /labels\.has\('pi:needs-human'\)/);
  assert.match(reconcile, /labels\.has\('review:passed'\)/);
  assert.match(reconcile, /needsFix = labels\.has\('review:changes-requested'\)/);
  assert.match(reconcile, /workflowFile\(needsFix \? 'repair' : 'reviewer'\)/);
});

test('code-failure ownership remains recoverable when immediate PR Fix dispatch fails', () => {
  const gate = fs.readFileSync('scripts/pi-auto-merge.mjs', 'utf8');
  const reconcile = readScript('scripts/pi-reconcile.mjs', 'utf8');

  const branchStart = gate.indexOf("if (ci.state === 'code_failure')");
  const branchEnd = gate.indexOf('\n  try {\n    const merged = await api(', branchStart);
  assert.ok(branchStart >= 0 && branchEnd > branchStart, 'code-failure branch must be present');
  const branch = gate.slice(branchStart, branchEnd);

  const ownership = branch.indexOf('withReviewVerdict([...prLabels], REVIEW_CHANGES_REQUESTED)');
  const dispatch = branch.indexOf("dispatchWorkflow(workflowFile('repair')");
  assert.ok(ownership >= 0 && dispatch > ownership, 'ownership must transfer before PR Fix dispatch');
  assert.match(branch, /PR Fix dispatch failed after ownership transfer; Reconciler will recover it/);
  assert.match(reconcile, /needsFix = labels\.has\('review:changes-requested'\)/);
  assert.match(reconcile, /workflowFile\(needsFix \? 'repair' : 'reviewer'\)/);
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
  const state = readScript('scripts/pi-common/review-state.mjs', 'utf8');
  assert.match(review, /review-state\.mjs" apply/);
  assert.match(state, /pi:needs-human/);
  assert.match(state, /pr\.head\.sha !== reviewedHead/);
  assert.doesNotMatch(review, /Restart review after PR head changed/);
});


test('reconciler gives normal PR handoffs a grace period before recovery dispatch', () => {
  const source = readScript('scripts/pi-reconcile.mjs', 'utf8');
  assert.match(source, /RECOVERY_GRACE_MS = 10 \* 60 \* 1000/);
  assert.match(source, /pr\.updated_at \?\? pr\.created_at/);
  assert.match(source, /prAgeMs < RECOVERY_GRACE_MS/);
});


test('Pi issue branch pushes invalidate verdict without creating a second review scheduler', () => {
  const review = fs.readFileSync('.github/workflows/pi-pr-review.yml', 'utf8');
  const invalidate = fs.readFileSync('.github/workflows/pi-review-invalidate.yml', 'utf8');
  const usage = fs.readFileSync('.github/workflows/pi-usage.yml', 'utf8');
  const state = readScript('scripts/pi-common/review-state.mjs', 'utf8');
  assert.doesNotMatch(review, /pull_request:[\s\S]*types: \[synchronize\]/);
  assert.match(review, /review:\n    if: github\.event_name == 'workflow_dispatch'/);
  assert.match(invalidate, /push:[\s\S]*branches:[\s\S]*'pi\/issue-\*'/);
  assert.match(invalidate, /runs-on: ubuntu-latest/);
  assert.match(invalidate, /gh pr list[\s\S]*--head "\$GITHUB_REF_NAME"[\s\S]*--base dev/);
  assert.match(invalidate, /review-state\.mjs" invalidate "\$PR" "\$GITHUB_SHA"/);
  assert.match(state, /pi-review:verdict:/);
  assert.match(state, /status: 'current-verdict'/);
  assert.doesNotMatch(invalidate, /dispatchWorkflow|pi-pr-review\.yml/);
  assert.doesNotMatch(usage, /PR Review Invalidate/);
  assert.doesNotMatch(review, /Restart review after PR head changed/);
});


test('late merge conflict leaves recoverable PR Fix ownership', () => {
  const gate = readScript('scripts/pi-auto-merge.mjs', 'utf8');
  assert.match(gate, /withReviewVerdict\(\[\.\.\.prLabels\], 'review:changes-requested'\)/);
  assert.match(gate, /dispatchWorkflow\('pi-pr-fix\.yml'/);
  const reconcile = readScript('scripts/pi-reconcile.mjs', 'utf8');
  assert.match(reconcile, /needsFix = labels\.has\('review:changes-requested'\)/);
  assert.match(reconcile, /workflowFile\(needsFix \? 'repair' : 'reviewer'\)/);
});


test('issue publication safely replaces only the branch head observed at run start', () => {
  const workflow = fs.readFileSync('.github/workflows/pi-issue-agent.yml', 'utf8');
  const publication = readScript('scripts/pi-common/issue-publication.mjs', 'utf8');
  assert.match(workflow, /PI_ISSUE_BRANCH_EXPECTED/);
  assert.match(publication, /const ref = `refs\/heads\/\$\{issueBranch\(issue\)\}`/);
  assert.match(publication, /--force-with-lease=\$\{ref\}:\$\{expectedSha/);
  assert.equal(issueBranch(42), 'pi/issue-42');
  assert.match(publication, /Refusing to publish protected control-plane files/);
  assert.match(workflow, /PI_IMPLEMENTER_START_COMMIT.*PI_ISSUE_BRANCH_EXPECTED/);
  assert.doesNotMatch(publication, /push --set-upstream origin/);
});

test('issue publication attributes changes against the shared resolved candidate base', () => {
  const publication = readScript('scripts/pi-common/issue-publication.mjs', 'utf8');
  const candidate = readScript('scripts/pi-common/candidate-revision.mjs', 'utf8');
  assert.match(publication, /publicationBase[\s\S]*return resolveCandidateBase/);
  assert.match(candidate, /merge-base', '--is-ancestor', configuredBase, 'HEAD'/);
  assert.match(candidate, /return fallback/);
  assert.match(publication, /diff','--no-renames','--name-only','-z',base,'HEAD'/);
  assert.doesNotMatch(publication, /diff','--no-renames','--name-only','-z',startCommit,'HEAD'/);
});

test('the PR body Validation section is rendered from the validation ledger, never from a static claim', () => {
  const workflow = fs.readFileSync('.github/workflows/pi-issue-agent.yml', 'utf8');
  const publication = readScript('scripts/pi-common/issue-publication.mjs', 'utf8');
  assert.doesNotMatch(publication, /validationLines/);
  assert.match(publication, /renderValidationSection\(ledgerRecords, \{ corrupted: ledgerCorrupted, candidateRevision \}\)/);
  assert.match(workflow, /PI_VALIDATION_LEDGER_FILE/);
  assert.match(workflow, /issue-publication\.mjs" pr "\$ISSUE" "\$PI_IMPLEMENTER_RESULT_FILE" "\$\{\{ github\.repository_owner \}\}" "\$PI_VALIDATION_LEDGER_FILE"/);
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
  // Reviewer validates in workflow. Implementer validation is backend-neutral and
  // runs after the selected backend submits; publication must not rerun the suite.
  assert.match(fs.readFileSync('.github/workflows/pi-pr-review.yml', 'utf8'), /pi-common\/product-checks\.mjs/);
  assert.doesNotMatch(fs.readFileSync('.github/workflows/pi-issue-agent.yml', 'utf8'), /pi-common\/product-checks\.mjs/);
  const finalChecks = projectConfig().checks.final.map(step => step.builtin ?? [step.command, ...step.args].join(' '));
  assert.deepEqual(finalChecks, ['package_roots', 'ruff', 'git diff --check', 'pytest']);
  const repairTool = readScript('scripts/pi-repair-result-tool.mjs', 'utf8');
  const implementerTool = readScript('scripts/pi-implementer-result-tool.mjs', 'utf8');
  const validation = readScript('scripts/pi-common/stage-validation-recovery.mjs', 'utf8');
  assert.match(repairTool, /validate = validateFinalProductTree/);
  assert.match(repairTool, /validate\(\{ enforceAcceptedScope: false \}\)/);
  assert.doesNotMatch(implementerTool, /validateFinalProductTree/);
  assert.match(validation, /validateFinalProductTree/);
  assert.match(validation, /enforceAcceptedScope: true/);
  assert.match(readScript('scripts/pi-common/finalize-product-tree.mjs', 'utf8'), /runProductChecks\(\{ cwd, ledgerPath, backend, env \}\)/);
  const ci = fs.readFileSync('.github/workflows/ci.yml', 'utf8');
  assert.match(ci, /node --test tests\/\*\.test\.mjs/);
  assert.match(ci, /tests\/test_runner_autoscaler\.sh/);
});


test('all Pi agents are hard-blocked from CI control-plane changes', () => {
  for (const protectedPath of [
    '.github/workflows/ci.yml',
    'agents/implementer/AGENTS.md',
    'scripts/pi-run-stage.mjs',
    'scripts/pi-common/state-machine.mjs',
    'tests/pi-run-stage.test.mjs',
    'tests/test_runner_autoscaler.sh',
    'infra/github-runner-autoscaler/manager.sh',
    '.pi/settings.json',
    '.agent-harness.json',
  ]) assert.equal(isControlPlanePath(protectedPath), true, `missing protected control-plane path: ${protectedPath}`);
  for (const productPath of ['src/social_mcp/app.py', 'tests/test_app.py', 'docs/CI_RULES.md', 'scripts/other.mjs']) {
    assert.equal(isControlPlanePath(productPath), false, `product path must stay editable: ${productPath}`);
  }

  const implementerTool = readScript('scripts/pi-implementer-result-tool.mjs', 'utf8');
  const repairTool = readScript('scripts/pi-repair-result-tool.mjs', 'utf8');
  const validation = readScript('scripts/pi-common/stage-validation-recovery.mjs', 'utf8');
  assert.doesNotMatch(implementerTool, /validateFinalProductTree/);
  assert.match(validation, /validateFinalProductTree/);
  assert.match(validation, /enforceAcceptedScope: true/);
  assert.match(repairTool, /validate = validateFinalProductTree/);
  assert.match(repairTool, /validate\(\{ enforceAcceptedScope: false \}\)/);
  const finalizer = readScript('scripts/pi-common/finalize-product-tree.mjs', 'utf8');
  assert.match(finalizer, /forbiddenAgentPaths\(base, cwd\)/);
  const agentChanges = readScript('scripts/pi-common/agent-change-policy.mjs', 'utf8');
  for (const check of ["diff','--name-only", "diff','--cached','--name-only", "ls-files','--others','--exclude-standard"]) assert.ok(agentChanges.includes(check));
  assert.match(finalizer, /Agent changes to CI\/control-plane files are forbidden/);

  for (const name of ['pi-pr-review.yml', 'pi-pr-fix.yml']) {
    const workflow = fs.readFileSync(`.github/workflows/${name}`, 'utf8');
    assert.match(workflow, /pi-common\/pr-guard\.mjs/);
    assert.match(workflow, /steps\.load\.outputs\.skip/);
  }

  const guard = readScript('scripts/pi-common/pr-guard.mjs', 'utf8');
  assert.match(guard, /pages\(\`\/pulls\/\$\{prNumber\}\/files\`\)/);
  assert.match(guard, /pi:needs-human/);

  const gate = readScript('scripts/pi-auto-merge.mjs', 'utf8');
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

test('selected subagents inherit the main response ceiling through a child-only extension', () => {
  const settings = JSON.parse(fs.readFileSync('.pi/settings.json', 'utf8'));
  assert.deepEqual(
    settings.subagents.agentOverrides.scout.subagentOnlyExtensions,
    ['./scripts/pi-subagent-response-budget.mjs'],
  );
  assert.deepEqual(
    settings.subagents.agentOverrides['implementation-planner'].subagentOnlyExtensions,
    ['./scripts/pi-subagent-response-budget.mjs', './scripts/pi-planner-evidence.mjs'],
  );
  const runtime = readScript('scripts/pi-agent-runtime.mjs', 'utf8');
  const child = readScript('scripts/pi-subagent-response-budget.mjs', 'utf8');
  assert.match(runtime, /PI_SUBAGENT_RESPONSE_MAX_TOKENS/);
  assert.match(child, /PI_SUBAGENT_RESPONSE_MAX_TOKENS/);
  assert.match(child, /Math\.min\(requested, modelLimit\)/);
  assert.equal(isControlPlanePath('.pi/settings.json'), true);
});

test('one progress controller owns loop safety, complexity, and response budgets', () => {
  const runtime = readScript('scripts/pi-agent-runtime.mjs', 'utf8');
  const controller = readScript('scripts/pi-common/progress-controller.mjs', 'utf8');
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
  const helper = readScript('scripts/pi-common/terminal-tool.mjs', 'utf8');
  assert.match(helper, /registerSubmitNudge/);
  assert.match(helper, /terminalResult/);
});

test('Triage submission uses the shared terminal contract', () => {
  const source = readScript('scripts/pi-triage-result-tool.mjs', 'utf8');
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


test('stage runner delegates shared Pi extensions to the Pi backend once for all agents', () => {
  const runner = readScript('scripts/pi-run-stage.mjs', 'utf8');
  const backend = readScript('scripts/pi-common/pi-stage-backend.mjs', 'utf8');
  assert.match(runner, /runPi = runPiStage/);
  assert.match(runner, /candidate => runPi\(candidate, \{ workspace \}\)/);
  assert.equal(backend.split('pi-bash-timeout.mjs').length - 1, 1);
  assert.equal(backend.split('pi-agent-runtime.mjs').length - 1, 1);
  assert.match(backend, /config\.resultTool/);
});

test('stage configuration is the single source of per-agent runtime limits', () => {
  const config = readScript('scripts/pi-common/stage-config.mjs', 'utf8');
  assert.doesNotMatch(config, /requiredFirstReadPath:/);
  assert.match(config, /dispatcher:[\s\S]*maxTurns: 30/);
  assert.match(config, /triage:[\s\S]*fixedResponseMaxTokens: 1000/);
});

test('runtime owns response budgets instead of duplicating them in role contracts', () => {
  const controller = readScript('scripts/pi-common/progress-controller.mjs', 'utf8');
  assert.match(controller, /short: 2048/);
  assert.match(controller, /normal: 4096/);
  assert.match(controller, /deep: 8192/);
  assert.match(readScript('scripts/pi-common/stage-config.mjs', 'utf8'), /triage:[\s\S]*fixedResponseMaxTokens: 1000/);

  for (const name of ['architect', 'implementer', 'repair', 'reviewer', 'dispatcher', 'triage']) {
    const source = fs.readFileSync(`agents/${name}/AGENTS.md`, 'utf8');
    assert.doesNotMatch(source, /SHORT[\s\S]*2048|NORMAL[\s\S]*4096|DEEP[\s\S]*8192/);
  }
});

test('reviewer metrics carry the linked issue and trivial reviews use the fast-path contract', () => {
  const workflow = fs.readFileSync('.github/workflows/pi-pr-review.yml', 'utf8');
  const runner = readScript('scripts/pi-run-stage.mjs', 'utf8');
  const guard = readScript('scripts/pi-common/pr-guard.mjs', 'utf8');
  const prompt = fs.readFileSync('agents/reviewer/AGENTS.md', 'utf8');
  assert.ok(workflow.includes('ISSUE=$(jq -r \'\.issue\' "$CONTEXT")'));
  assert.ok(workflow.includes('REVIEW_CONTEXT=$CONTEXT'));
  assert.match(guard, /loadIssue\(issueNumber\)/);
  assert.match(guard, /review:[\s\S]*issue:[\s\S]*changedFiles/);
  assert.match(runner, /PI_ISSUE: env\.PI_ISSUE \?\? env\.ISSUE \?\? ''/);
  assert.match(runner, /writeGithubEnv\(env, 'PI_ISSUE', spec\.environment\.PI_ISSUE\)/);
  assert.match(prompt, /\*\*trivial\*\* — tiny self-contained diff/);
  assert.ok(prompt.includes('**Never rerun them.**'));
  assert.match(prompt, /### Trivial fast path/);
  assert.match(prompt, /History or prior attempts are valid when they materially answer a concrete question/);
  assert.match(prompt, /Never load skills for trivial reviews/);
  const sharedContract = fs.readFileSync('agents/AGENTS.md', 'utf8');
  assert.match(sharedContract, /blocked, failed, cancelled, or truncated tool call did not execute/i);
  assert.ok(!prompt.includes('Before reviewing, read `docs/PROJECT_CONTEXT.md`'));
});
test('fresh implementer uses one planner/classifier result while restored and repair work submit directly', () => {
  const config = readScript('scripts/pi-common/stage-config.mjs', 'utf8');
  const agent = fs.readFileSync('agents/implementer/AGENTS.md', 'utf8');
  const runtime = readScript('scripts/pi-agent-runtime.mjs', 'utf8');
  const repoSearchSource = readScript('scripts/pi-common/repo-search.mjs', 'utf8');
  const planner = fs.readFileSync('.pi/agents/implementation-planner.md', 'utf8');
  const settings = fs.readFileSync('.pi/settings.json', 'utf8');
  const runner = readScript('scripts/pi-run-stage.mjs', 'utf8');
  const backend = readScript('scripts/pi-common/pi-stage-backend.mjs', 'utf8');

  assert.match(config, /implementer:[\s\S]*implementationPlannerAgent: 'implementation-planner'[\s\S]*implementationPlannerMaxTokens: 2048[\s\S]*implementationPlannerTimeoutMs: 900000/);
  assert.doesNotMatch(config, /prepare_implementation/);
  assert.doesNotMatch(config, /complexityClassifierAgent|complexityClassifierTimeoutMs/);
  assert.match(config, /initialEvidenceBudgetByComplexity:[\s\S]*trivial: 2[\s\S]*nontrivial: 6/);
  assert.match(config, /delegatedTools: \['grep', 'find', 'ls'\]/);
  assert.doesNotMatch(config, /directReadMaxLines|directReadCalls/);
  assert.match(config, /implementer:[\s\S]*boundedDirectBash: true/);

  assert.match(agent, /### Restored work[\s\S]*Call `submit_result` with no arguments immediately[\s\S]*Do \*\*not\*\* inspect repository files/);
  assert.doesNotMatch(agent, /prepare_implementation/);
  assert.match(agent, /role overlay follows the shared agent contract in the initial prompt/i);
  assert.match(config, /shared_agent_contract[\s\S]*role_contract[\s\S]*trusted_context/);
  assert.match(agent, /Do not pass `already_satisfied` for restored work/);
  assert.match(agent, /zero diff[\s\S]*records the issue as already satisfied automatically/);
  assert.match(agent, /### Fresh work[\s\S]*runtime has already prepared the top-level implementation plan before this session started/);
  assert.match(agent, /Task classification alone never requires delegation/);
  assert.match(agent, /2 actions for trivial[\s\S]*6 for nontrivial/);
  assert.match(agent, /submit_result[\s\S]*records that the agent considers the implementation complete/);
  assert.match(agent, /shared stage harness runs the authoritative checks/);
  assert.doesNotMatch(agent, /trivial_repo_lookup|RepoMap|repo map orientation|complexity-classifier/);

  const bootstrapPlanner = readScript('scripts/pi-common/implementation-planner.mjs', 'utf8');
  assert.match(bootstrapPlanner, /IMPLEMENTATION_PREPARATION_TRANSPORT_SCHEMA/);
  assert.match(bootstrapPlanner, /enum: \['trivial', 'nontrivial'\]/);
  assert.match(runtime, /controller\.applyPreparedImplementation\(preparedImplementation\)/);
  assert.doesNotMatch(runtime, /prepare_implementation/);
  assert.doesNotMatch(runtime, /trivial_repo_lookup|trivialRepoLookup|runStructuredComplexityClassifier|complexityClassifierAgent/);
  assert.match(runtime, /directActionImplementer[\s\S]*requireComplexity: false/);
  assert.match(runtime, /validationRepair[\s\S]*PI_VALIDATION_REPAIR/);
  assert.match(bootstrapPlanner, /freshBaseCommit/);
  assert.match(bootstrapPlanner, /LSP workspace root:/);
  assert.match(runtime, /name: 'structural_edit'/);
  assert.match(runtime, /structuralEdit\(ctx\.cwd, params\)/);
  assert.match(runtime, /name: 'safe_edit'/);
  assert.match(runtime, /name: 'repo_search'/);
  assert.match(runtime, /repoSearch\(ctx\.cwd, params\)/);
  assert.match(bootstrapPlanner, /implementationPlannerMaxTokens \?\? 2048[\s\S]*request\.toolBudget = \{ hard: cap \+ 3 \}/);
  assert.match(readScript('scripts/pi-common/structured-subagent.mjs', 'utf8'), /result: schema \? \{ kind: 'structured', schema \} : \{ kind: 'text' \}/);

  assert.match(repoSearchSource, /\['ls-files', '-z'\]/);
  assert.match(repoSearchSource, /\['grep', '-n', '-I', '-F'/);
  assert.match(planner, /inheritSkills: true/);
  assert.match(planner, /trivial \| nontrivial/);
  assert.match(planner, /Dispatcher already owns Architect routing/);
  assert.doesNotMatch(settings, /complexity-classifier/);
  assert.match(backend, /if \(spec\.stage === 'architect'\) extensions\.push\(REPOMAP_PACKAGE\)/);
  assert.doesNotMatch(runner, /\['implementer', 'architect'\]\.includes\(stage\)/);
});
test('semantic routing, Git Context lanes, and safe edit contracts stay explicit', () => {
  const mcp = JSON.parse(fs.readFileSync('.mcp.json', 'utf8'));
  const implementer = fs.readFileSync('agents/implementer/AGENTS.md', 'utf8');
  const reviewer = fs.readFileSync('agents/reviewer/AGENTS.md', 'utf8');
  const repair = fs.readFileSync('agents/repair/AGENTS.md', 'utf8');
  const architect = fs.readFileSync('agents/architect/AGENTS.md', 'utf8');
  const dispatcher = fs.readFileSync('agents/dispatcher/AGENTS.md', 'utf8');
  const triage = fs.readFileSync('agents/triage/AGENTS.md', 'utf8');
  const stageConfig = readScript('scripts/pi-common/stage-config.mjs', 'utf8');
  const progress = readScript('scripts/pi-common/progress-controller.mjs', 'utf8');
  const structuralEdit = readScript('scripts/pi-common/structural-edit.mjs', 'utf8');
  const safeEdit = readScript('scripts/pi-common/safe-edit.mjs', 'utf8');
  const resultTool = readScript('scripts/pi-implementer-result-tool.mjs', 'utf8');

  assert.ok(mcp.mcpServers.lsp.includeTools.includes('lsp_start_server'));
  assert.ok(mcp.mcpServers.lsp.directTools.includes('lsp_start_server'));
  assert.ok(mcp.mcpServers.lsp.includeTools.includes('lsp_find_symbol'));
  assert.ok(mcp.mcpServers.lsp.directTools.includes('lsp_find_symbol'));
  assert.match(implementer, /call `lsp_start_server` once[\s\S]*exact absolute workspace root supplied in the prepared state[\s\S]*then call `lsp_find_symbol`/i);
  assert.match(implementer, /Do not call `lsp_server_status` first/i);
  assert.match(implementer, /cold-start call is control-plane setup, not evidence/i);
  assert.match(implementer, /Do not use it before LSP merely to rediscover an already-named source symbol/i);
  assert.match(implementer, /Treat history as provenance evidence, never current source truth, current-symbol discovery, or an edit anchor/i);
  assert.match(implementer, /structural_edit.*exactly one AST match/i);
  assert.match(implementer, /safe_edit.*bounded line\/range/i);
  assert.match(implementer, /post-edit preview[\s\S]*Do not spend another evidence action/i);
  assert.match(structuralEdit, /--json=compact[\s\S]*matches\.length !== 1[\s\S]*byteOffset[\s\S]*atomicWrite/);
  assert.match(safeEdit, /POST_EDIT_PREVIEW_MAX_CHARS[\s\S]*post_edit:/);
  assert.match(reviewer, /Historical intent \/ provenance/);
  assert.match(reviewer, /prefer one narrow local Git Context MCP call/i);
  assert.match(repair, /prefer one narrow Git Context MCP call/i);
  assert.match(architect, /Do not use history by default/i);
  assert.doesNotMatch(dispatcher, /blame_context|commit_story|file_history|search_commits|file_contributors/);
  assert.doesNotMatch(triage, /blame_context|commit_story|file_history|search_commits|file_contributors/);
  assert.match(stageConfig, /initialEvidenceBudgetByComplexity:[\s\S]*trivial: 2[\s\S]*nontrivial: 6/);
  assert.match(stageConfig, /controlTools: \['set_response_budget', 'subagents_enable', 'lsp_start_server', 'request_large_mutation_budget'\]/);
  assert.match(stageConfig, /actionTools: \['accept_mutation_scope', 'structural_edit', 'safe_edit', 'edit', 'write', 'begin_coding_session', 'rollback_last_mutation', 'recover_worktree', 'undo_mutation', 'submit_result'\]/);
  assert.match(progress, /const MUTATION_TOOLS = new Set\(\['structural_edit', 'safe_edit', 'edit', 'write', 'begin_coding_session', 'recover_worktree', 'undo_mutation'\]\)/);
  assert.match(resultTool, /IMPLEMENTER_MUTATION_TOOLS = Object\.freeze\(\['structural_edit', 'safe_edit', 'edit', 'write'\]\)/);
  assert.match(resultTool, /IMPLEMENTER_MUTATION_TOOLS\.filter\(name => active\.has\(name\)\)/);
  assert.match(resultTool, /capabilitySnapshotGuidance\(names\)/);
});

test('implementer has an explicit already-satisfied terminal path without duplicate edits', () => {
  const workflow = fs.readFileSync('.github/workflows/pi-issue-agent.yml', 'utf8');
  const tool = readScript('scripts/pi-implementer-result-tool.mjs', 'utf8');
  const transition = readScript('scripts/pi-transition.mjs', 'utf8');
  const config = readScript('scripts/pi-common/stage-config.mjs', 'utf8');

  assert.match(config, /shared_agent_contract[\s\S]*role_contract[\s\S]*trusted_context/);
  assert.doesNotMatch(config, /Read and follow agents\/implementer\/AGENTS\.md first/);
  assert.doesNotMatch(tool, /If there is no real diff, implement the task/);
  assert.match(tool, /already_satisfied/);
  assert.match(tool, /Latest dev already contains the exact requested end state/);
  assert.match(tool, /nudgeMaxCount: 3/);
  assert.match(tool, /PI_PRODUCTIVE_STATE/);
  assert.match(tool, /diff', '--no-renames', '--name-only', '-z', 'origin\/dev'/);
  assert.match(tool, /already_satisfied requires zero diff against latest dev/);
  assert.match(workflow, /if \[ "\$OUTCOME" = "already_satisfied" \]; then/);
  assert.match(workflow, /issue satisfied/);
  assert.match(transition, /state: 'closed', state_reason: 'completed'/);
});


test('fresh implementer metadata preflight stays before integration and shared expensive checks stay outside Pi', () => {
  const tool = readScript('scripts/pi-implementer-result-tool.mjs', 'utf8');
  const validation = readScript('scripts/pi-common/stage-validation-recovery.mjs', 'utf8');
  const guard = tool.indexOf('validateFreshChangedSubmission(params)');
  assert.ok(guard >= 0);
  assert.ok(guard < tool.indexOf('integrateLatestDev({', guard));
  assert.match(tool, /code: 'missing_publication_fields'/);
  assert.doesNotMatch(tool, /validateFinalProductTree|runProductChecks/);
  assert.match(
    validation,
    /result = await runBackendAttempt\(currentSpec, runBackend\)[\s\S]*validate\(\{[\s\S]*cwd: spec\.cwd,[\s\S]*ledgerPath: spec\.environment\.PI_VALIDATION_LEDGER_FILE,[\s\S]*backend: result\.backend,[\s\S]*env: spec\.environment,[\s\S]*\}\)/,
  );
});

test('stage runner relies on installed pi-subagents instead of registering a duplicate subagent tool', () => {
  const runner = readScript('scripts/pi-run-stage.mjs', 'utf8');
  assert.doesNotMatch(runner, /pi-subagent\.mjs/);
});

test('reviewer orients and plans before declaring complexity', () => {
  const config = readScript('scripts/pi-common/stage-config.mjs', 'utf8');
  const agent = fs.readFileSync('agents/reviewer/AGENTS.md', 'utf8');
  assert.match(config, /reviewer:[\s\S]*requireComplexity: true[\s\S]*preComplexityAllowedTools: \['read', 'bash', 'lsp_start_server', 'lsp_find_symbol'\]/);
  for (const value of ['Read the linked issue', 'Inspect the complete PR diff', 'Write a concise review plan', '1000 tokens', 'Call `declare_task_complexity`', 'Continue the semantic review']) {
    assert.ok(agent.includes(value), `reviewer startup marker missing: ${value}`);
  }
  assert.match(agent, /Known-symbol semantic navigation/);
  assert.match(agent, /lsp_start_server/);
  assert.match(agent, /lsp_find_symbol/);
  assert.match(agent, /Fall back to literal\/index search only when LSP/);
  assert.match(agent, /current code and relevant tests are authoritative/i);
  assert.match(agent, /issue text and inspected current code conflict/i);
  assert.match(agent, /CHANGES_REQUESTED/);
  assert.match(agent, /current code and relevant tests are authoritative/i);
  assert.match(agent, /issue text and inspected current code conflict/i);
  assert.match(config, /Reviewer LSP workspace root/);
});

test('repair orients and plans before declaring complexity', () => {
  const config = readScript('scripts/pi-common/stage-config.mjs', 'utf8');
  const agent = fs.readFileSync('agents/repair/AGENTS.md', 'utf8');
  assert.match(config, /repair:[\s\S]*requireComplexity: true[\s\S]*preComplexityAllowedTools: \['read', 'bash'\]/);
  for (const value of ['Read the concrete blocking Reviewer finding', 'Inspect the PR diff', 'Write a short repair plan', '1000 output tokens', 'Call `declare_task_complexity`', 'Immediately execute the first plan item']) {
    assert.ok(agent.includes(value), `repair startup marker missing: ${value}`);
  }
});

test('dispatcher stays a narrow scope classifier and does not treat complexity as decomposition', () => {
  const agent = fs.readFileSync('agents/dispatcher/AGENTS.md', 'utf8');
  assert.match(agent, /candidates.*authoritative/is);
  assert.match(agent, /Size alone is not a reason for ARCHITECT/);
  assert.match(agent, /Complexity alone is not a reason for ARCHITECT/);
  assert.match(agent, /prepared context is sufficient/i);
  assert.match(agent, /Runtime closes exploration as soon as the prepared context has been read/);
  assert.match(agent, /Do not inspect repository code, project documentation, Git history, queue state/);
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
  assert.match(workflow, /name: Run independent review\n\s+id: independent\n\s+if: >-[\s\S]*?steps\.checks\.outcome == 'success'[\s\S]*?steps\.record\.outputs\.status/);
  assert.match(workflow, /name: Apply review result\n\s+if: steps\.load\.outputs\.skip != 'true' && steps\.checks\.outcome == 'success' && steps\.independent\.outcome == 'success'/);
});

test('failed independent reviews persist recovery state, retry once, and retain the reviewer trace', () => {
  const workflow = fs.readFileSync('.github/workflows/pi-pr-review.yml', 'utf8');
  const state = readScript('scripts/pi-common/review-state.mjs', 'utf8');
  assert.match(workflow, /id: independent[\s\S]*?continue-on-error: true/);
  assert.match(workflow, /name: Preserve reviewer trace\n\s+if: always\(\)[\s\S]*?actions\/upload-artifact@v4[\s\S]*?pi-review-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}\.jsonl/);
  assert.doesNotMatch(workflow, /recover_failed_review:/);
  assert.match(workflow, /name: Fail job after independent review infrastructure failure[\s\S]*?workflow_run recovery owns the bounded retry/);
  assert.doesNotMatch(workflow, /recover-failure "\$PR" "\$HEAD_SHA" "\$GITHUB_RUN_ID"/);
  assert.doesNotMatch(workflow, /needs\.review\.result/);
  assert.match(workflow, /REVIEW_RUN_ATTEMPT: \$\{\{ github\.run_attempt \}\}/);
  assert.match(workflow, /actions: write/);
  assert.match(state, /pi-review:failure-retry:/);
  assert.match(state, /pi-review:failure-exhausted:/);
  assert.match(state, /pi:needs-human/);
  assert.match(state, /dispatchWorkflow\('pi-pr-review\.yml'/);
  assert.match(state, /infrastructure failure, not a code-review verdict/);
});

test('stage execution owns the terminal marker contract for every model-driven workflow', () => {
  const runner = readScript('scripts/pi-run-stage.mjs', 'utf8');
  const backend = readScript('scripts/pi-common/pi-stage-backend.mjs', 'utf8');
  assert.match(runner, /PI_TERMINAL_RESULT_FILE/);
  assert.match(backend, /exited without its terminal tool/);
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
  const reconcile = readScript('scripts/pi-reconcile.mjs', 'utf8');
  assert.match(reconcile, /issueRecoveryAllowed = automationMode === 'RUNNING'/);
  assert.match(reconcile, /prRecoveryAllowed = automationMode === 'RUNNING' \|\| automationMode === 'DRAINING'/);
  assert.match(reconcile, /issueRecoveryTarget/);
  assert.match(reconcile, /clear lost issue ownership without re-queueing/);
  assert.match(reconcile, /passed-pr-needs-merge-gate/);
  assert.match(reconcile, /pi-auto-merge\.yml/);
});

test('Architect split publication is two-phase and Dispatcher wakes only from ready labels', () => {
  const architect = readScript('scripts/pi-architect.mjs', 'utf8');
  const reconcile = readScript('scripts/pi-reconcile.mjs', 'utf8');
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
  const review = readScript('scripts/pi-review-result.mjs', 'utf8');
  assert.match(review, /did not call submit_result/);
  assert.doesNotMatch(review, /matchAll\(\/\^\[ \\t\]/);
});

test('publication never invents a successful result and PR Fix publishes a clean integrated HEAD', () => {
  const issuePublication = readScript('scripts/pi-common/issue-publication.mjs', 'utf8');
  assert.match(issuePublication, /Implementer result metadata is required before PR publication/);
  assert.doesNotMatch(issuePublication, /See the diff for implementation details/);

  const repair = readScript('scripts/pi-common/repair-publication.mjs', 'utf8');
  assert.match(repair, /const localHead = git\(\['rev-parse','HEAD'\]/);
  assert.match(repair, /if \(localHead === expectedHead\) return/);
  assert.match(repair, /\$\{localHead\}:refs\/heads\/\$\{headRef\}/);
});

test('trusted subprocess and GitHub IO share bounded infrastructure helpers', () => {
  const processHelper = readScript('scripts/pi-common/process.mjs', 'utf8');
  assert.match(processHelper, /spawnSync/);
  assert.match(processHelper, /timeout:/);
  assert.match(processHelper, /SIGKILL/);

  for (const name of ['agent-change-policy.mjs', 'issue-worktree.mjs', 'finalize-product-tree.mjs']) {
    const source = fs.readFileSync(`scripts/pi-common/${name}`, 'utf8');
    assert.match(source, /\.\/git\.mjs/);
    assert.doesNotMatch(source, /node:child_process/);
  }
  const repair = readScript('scripts/pi-common/repair-publication.mjs', 'utf8');
  assert.doesNotMatch(repair, /spawnSync\('rm'/);

  const github = readScript('scripts/pi-common/github-api.mjs', 'utf8');
  assert.match(github, /AbortSignal\.timeout/);
  assert.match(github, /PI_GITHUB_HTTP_TIMEOUT_MS/);
  const usage = readScript('scripts/pi-usage-collect.mjs', 'utf8');
  assert.match(usage, /githubClient/);
  assert.doesNotMatch(usage, /https:\/\/api\.github\.com/);
});

test('log rendering finalizes after continuations and redacts generic secret fields', () => {
  const source = readScript('scripts/pi-log-filter.mjs', 'utf8');
  assert.match(source, /lastAgentEndSeen/);
  assert.match(source, /reportFinal\(lastAgentEndSeen \? "completed" : "interrupted"\)/);
  assert.match(source, /private\[_-\]\?key/);
});


test('stage runner owns model phase and issue metadata', () => {
  const runner = readScript('scripts/pi-run-stage.mjs', 'utf8');
  const config = readScript('scripts/pi-common/stage-config.mjs', 'utf8');
  assert.match(runner, /PI_PHASE: env\.PI_PHASE \?\? config\.phase \?\? stage/);
  assert.match(runner, /writeGithubEnv\(env, 'PI_PHASE', spec\.environment\.PI_PHASE\)/);
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
  const publication = readScript('scripts/pi-common/issue-publication.mjs', 'utf8');
  const worktree = readScript('scripts/pi-common/issue-worktree.mjs', 'utf8');
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


test('text architecture map is maintained only for architecture-changing work', () => {
  const map = fs.readFileSync('docs/architecture/PROJECT_MAP.md', 'utf8');
  const implementer = fs.readFileSync('agents/implementer/AGENTS.md', 'utf8');
  const reviewer = fs.readFileSync('agents/reviewer/AGENTS.md', 'utf8');
  const architect = fs.readFileSync('agents/architect/AGENTS.md', 'utf8');
  const context = fs.readFileSync('docs/PROJECT_CONTEXT.md', 'utf8');

  assert.match(map, /## Product architecture/);
  assert.match(map, /## Pi development pipeline/);
  assert.match(map, /## Component ownership/);
  assert.match(map, /Update this file in the same PR/);
  assert.doesNotMatch(map, /mermaid/i);
  assert.match(implementer, /docs\/architecture\/PROJECT_MAP\.md/);
  assert.match(reviewer, /docs\/architecture\/PROJECT_MAP\.md/);
  assert.match(architect, /docs\/architecture\/PROJECT_MAP\.md/);
  assert.match(context, /docs\/architecture\/PROJECT_MAP\.md/);
});

test('implementer action-required aborts keep defensive execution-failure provenance through publication fallback', () => {
  const workflow = fs.readFileSync('.github/workflows/pi-issue-agent.yml', 'utf8');
  const runtime = readScript('scripts/pi-agent-runtime.mjs', 'utf8');
  const overview = fs.readFileSync('docs/CI_PIPELINE_OVERVIEW.md', 'utf8');

  assert.match(runtime, /tool_choice: 'required'/);
  assert.match(runtime, /PI_ACTION_REQUIRED_TOOL_CHOICE_ARMED/);
  assert.match(runtime, /PI_ACTION_REQUIRED_TOOL_CHOICE_SATISFIED/);
  assert.match(runtime, /failure_class: 'model_execution_abort'/);
  assert.match(runtime, /PI_RUNTIME_FAILURE_FILE/);

  assert.match(workflow, /PI_RUNTIME_FAILURE_FILE=\$RUNNER_TEMP\/pi-runtime-failure-/);
  assert.match(workflow, /Pi execution aborted before terminal submission \[\$FAILURE_CLASS\/\$FAILURE_CODE\]/);
  assert.equal(
    (workflow.match(/\.failure_code == "PI_ACTION_REQUIRED_ABORT"/g) ?? []).length,
    2,
    'both workflow consumers accept only the known runtime-abort code',
  );
  assert.equal(
    (workflow.match(/\(\.reason \| type == "string"\)/g) ?? []).length,
    2,
    'both workflow consumers require a string reason before accepting the record',
  );
  assert.equal(
    (workflow.match(/FAILURE_REASON="Implementer runtime aborted after repeated action-required responses without a usable tool action"/g) ?? []).length,
    2,
    'accepted records are rendered through fixed trusted text rather than file content',
  );
  assert.equal(
    (workflow.match(/\.failure_code == "PI_TERMINAL_RECOVERY_BLOCKED"/g) ?? []).length,
    4,
    'both workflow consumers validate and branch on the known terminal-recovery blocked code',
  );
  assert.equal(
    (workflow.match(/FAILURE_REASON="Terminal recovery exhausted or could not select a capability-valid deterministic repair;/g) ?? []).length,
    2,
    'terminal-recovery blocked records also render through fixed trusted text',
  );
  assert.doesNotMatch(workflow, /FAILURE_REASON="\$\(jq/);
  assert.doesNotMatch(workflow, /FAILURE_CODE="\$\(jq/);
  assert.doesNotMatch(workflow, /FAILURE_CLASS="\$\(jq/);
  assert.equal(
    (workflow.match(/runtime_failure_metadata_invalid/g) ?? []).length,
    2,
    'both workflow failure consumers fail closed to an explicit invalid-metadata classification',
  );
  assert.match(overview, /PI_RUNTIME_FAILURE_FILE.*diagnostic provenance, not an authorization boundary/s);
  assert.match(overview, /\$RUNNER_TEMP.*Implementer shell\/tool process may be able to write/s);
  assert.match(overview, /must never authorize publication, review, or merge/s);

  const abortIndex = workflow.indexOf('Pi execution aborted before terminal submission');
  const genericNoChangeIndex = workflow.indexOf('Pi completed the task but produced no repository changes');
  assert.ok(abortIndex >= 0 && genericNoChangeIndex > abortIndex, 'runtime abort is classified before generic no-change fallback');
});

test('blocked implementer outcome is a deliberate human gate', () => {
  const workflow = fs.readFileSync('.github/workflows/pi-issue-agent.yml', 'utf8');
  const runtime = readScript('scripts/pi-agent-runtime.mjs', 'utf8');
  const tool = readScript('scripts/pi-implementer-result-tool.mjs', 'utf8');
  const agent = fs.readFileSync('agents/implementer/AGENTS.md', 'utf8');
  const shared = readScript('scripts/pi-common/implementer-result.mjs', 'utf8');
  const recovery = readScript('scripts/pi-common/stage-validation-recovery.mjs', 'utf8');
  const miniSwe = readScript('scripts/pi-common/mini-swe-stage-backend.mjs', 'utf8');

  assert.match(shared, /changed.*already_satisfied.*blocked/s);
  assert.match(tool, /blocked_reason/);
  assert.match(tool, /blocked_reason requires a clean worktree/);
  assert.match(runtime, /submit_result with blocked_reason now/);
  assert.match(agent, /submit_result\(\{blocked_reason:/);
  assert.match(recovery, /outcome !== IMPLEMENTER_OUTCOMES\.changed/);
  assert.match(miniSwe, /writeImplementerResult/);

  assert.match(workflow, /OUTCOME="\$\(jq -r '\.outcome/);
  assert.match(
    workflow,
    /if \[ "\$OUTCOME" = "blocked" \]; then[\s\S]*?issue needs-human[\s\S]*?\$BLOCKED_REASON[\s\S]*?exit 0/,
  );
});
