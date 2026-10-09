import test from 'node:test';
import assert from 'node:assert/strict';

import implementerSkillIndex, { compactImplementerSkillPrompt, curateImplementerSkillPrompt } from '../scripts/pi-implementer-skill-index.mjs';
import { buildPiInvocation, buildBootstrapInvocation } from '../scripts/pi-common/pi-stage-backend.mjs';
import { mainPromptRequestMetadata } from '../scripts/pi-common/main-prompt-observability.mjs';

const catalog = names => `<skills>
The following skills provide specialized instructions for specific tasks.
Use the read tool to load a skill's file when the task matches its description.
<available_skills>
${names.map(name => ` <skill>
  <name>${name}</name>
  <description>Detailed specialized guidance for ${name}, including lengthy setup, multiple usage cases, extra documentation and examples. Use this when working with ${name} related repository changes and when preserving specific operational invariants. ${'Implementation notes and compatibility guidance. '.repeat(8)}</description>
  <location>/work/.agents/skills/${name}/SKILL.md</location>
 </skill>`).join('\n')}
</available_skills>
</skills>`;

const allNames = [
  ...Array.from({ length: 28 }, (_, i) => `general-skill-${i}`),
  'python-testing-patterns',
  'docker-compose',
  'github-actions-hardening',
];

test('#593 Main skill catalog shrinks without removing discoverable skills, paths or contracts', () => {
  const before = [
    '<system>Keep trusted safety rules and runtime controls.</system>',
    catalog(allNames),
    '<project_context>preserve original repository constraints</project_context>',
  ].join('\n');
  const after = compactImplementerSkillPrompt(before);
  assert.ok(Buffer.byteLength(after) < Buffer.byteLength(before) * 0.65, 'long skill descriptions must shrink substantially');
  assert.equal((after.match(/<skill>/g) ?? []).length, allNames.length);
  for (const name of allNames) {
    assert.ok(after.includes(`<name>${name}</name>`));
    assert.ok(after.includes(`<location>/work/.agents/skills/${name}/SKILL.md</location>`));
  }
  assert.match(after, /read the listed SKILL.md before applying a skill/);
  assert.match(after, /<system>Keep trusted safety rules and runtime controls.<\/system>/);
  assert.match(after, /<project_context>preserve original repository constraints<\/project_context>/);
  assert.equal(compactImplementerSkillPrompt(after), after, 'repeat Main starts must be stable');
});

test('#593 unfamiliar skill schemas and non-skill prompts remain unchanged', () => {
  const unknown = '<skills><available_skills><skill id="new-format"/></available_skills></skills>';
  assert.equal(compactImplementerSkillPrompt(unknown), unknown);
  assert.equal(compactImplementerSkillPrompt('<system>no skills</system>'), '<system>no skills</system>');
  const duplicated = `${catalog(['kiss'])}\n${catalog(['solid'])}`;
  assert.equal(compactImplementerSkillPrompt(duplicated), duplicated);
});

test('#593 malformed skill missing location cannot steal the following skill path', () => {
  const valid = catalog(['python-testing-patterns', 'docker-compose']);
  assert.notEqual(compactImplementerSkillPrompt(valid), valid, 'valid long descriptions should compact');

  const firstPath = '<location>/work/.agents/skills/python-testing-patterns/SKILL.md</location>';
  const malformed = valid.replace(firstPath, '');
  assert.notEqual(malformed, valid, 'the fixture must remove the first skill location');
  assert.equal(
    compactImplementerSkillPrompt(malformed),
    malformed,
    'fail open: do not merge two entries or lose docker-compose and its path',
  );
  const missingDescription = valid.replace(/<description>[\s\S]*?<\/description>/, '');
  assert.equal(compactImplementerSkillPrompt(missingDescription), missingDescription);
});

test('#593 XML escapes in skill summaries are valid after truncation', () => {
  const long = `<skills><available_skills><skill><name>special</name><description>${'Automation &amp; tools '.repeat(20)}</description><location>/tmp/SKILL.md</location></skill></available_skills></skills>`;
  const compact = compactImplementerSkillPrompt(long);
  assert.match(compact, /Automation &amp; tools/);
  assert.doesNotMatch(compact, /&am(?!p;)/);
  assert.match(compact, /<location>\/tmp\/SKILL.md<\/location>/);
});

test('#593 hook only modifies Main, and pi invocation leaves Planner and child isolation intact', () => {
  let handler;
  implementerSkillIndex({ on: (name, callback) => { assert.equal(name, 'before_agent_start'); handler = callback; } });
  const previous = process.env.PI_STAGE;
  const child = process.env.PI_CODING_SESSION;
  const before = catalog(['python-testing-patterns', 'docker-compose']);
  try {
    process.env.PI_STAGE = 'reviewer';
    assert.equal(handler({ systemPrompt: before }), undefined);
    process.env.PI_STAGE = 'implementer';
    process.env.PI_CODING_SESSION = '{"sessionId":"child"}';
    assert.equal(handler({ systemPrompt: before }), undefined);
    delete process.env.PI_CODING_SESSION;
    assert.ok(handler({ systemPrompt: before }).systemPrompt.length < before.length);
  } finally {
    if (previous === undefined) delete process.env.PI_STAGE;
    else process.env.PI_STAGE = previous;
    if (child === undefined) delete process.env.PI_CODING_SESSION;
    else process.env.PI_CODING_SESSION = child;
  }

  const spec = stage => ({
    stage, prompt: 'do task', cwd: '/task', environment: { PI_STAGE: stage },
    model: { provider: 'test', id: 'test' },
    artifacts: { terminalResultPath: '/tmp/test-terminal' },
  });
  const main = buildPiInvocation(spec('implementer'), '/trusted');
  const reviewer = buildPiInvocation(spec('reviewer'), '/trusted');
  const bootstrap = buildBootstrapInvocation(spec('implementer'), '/trusted');
  assert.ok(main.pi.args.includes('/trusted/scripts/pi-implementer-skill-index.mjs'));
  assert.ok(!reviewer.pi.args.includes('/trusted/scripts/pi-implementer-skill-index.mjs'));
  assert.ok(!bootstrap.args.includes('/trusted/scripts/pi-implementer-skill-index.mjs'));
});

test('#593 provider-side Main metadata measures exact UTF-8 skills bytes on first and later requests', () => {
  const compressed = compactImplementerSkillPrompt('<role>safe</role>\n' + catalog(allNames));
  const first = {
    messages: [
      { role: 'system', content: compressed },
      { role: 'user', content: '<shared_agent_contract/>\n<role_contract/>' },
    ],
    tools: [],
  };
  const firstMetrics = mainPromptRequestMetadata(first);
  assert.equal(firstMetrics.systemTextBytes, Buffer.byteLength(compressed, 'utf8'));
  assert.equal(firstMetrics.skillCount, allNames.length);
  assert.equal('skillNames' in firstMetrics, false, 'names are logged once by PI_MAIN_SKILLS, not per request');
  assert.ok(firstMetrics.skillCatalogBytes > 0);
  const next = mainPromptRequestMetadata({
    ...first,
    messages: [...first.messages, { role: 'assistant', content: 'progress' }],
  }, firstMetrics);
  assert.equal(next.skillCatalogBytes, firstMetrics.skillCatalogBytes);
  assert.equal(next.systemTextBytes, firstMetrics.systemTextBytes);
  assert.equal(next.changedFromPrevious.system, false);
});


test('#685 Python Main promotes relevant skills and keeps every other exact read path', () => {
  const before = '<role>Trusted safety and task contract remain unchanged.</role>\n'
    + catalog(allNames) + '\n<project_context>original planText remains unmodified</project_context>';
  const after = curateImplementerSkillPrompt(before, {
    taskText: 'Create src/social_mcp/diagnostics/smoke_unique_terms.py and tests/diagnostics/test_smoke_unique_terms.py. Verify with pytest.',
  });
  const featured = after.match(/<available_skills>([\s\S]*?)<\/available_skills>/)?.[1] ?? '';
  const index = after.match(/<skill_discovery_index>([\s\S]*?)<\/skill_discovery_index>/)?.[1] ?? '';
  assert.match(featured, /<name>python-testing-patterns<\/name>/);
  assert.doesNotMatch(featured, /<name>docker-compose<\/name>/);
  assert.match(index, /docker-compose\t\/work\/\.agents\/skills\/docker-compose\/SKILL\.md/);
  assert.match(index, /github-actions-hardening\t\/work\/\.agents\/skills\/github-actions-hardening\/SKILL\.md/);
  assert.equal((featured.match(/<skill>/g) ?? []).length
    + index.split('\n').filter(line => line.includes('\t')).length, allNames.length);
  assert.ok((featured.match(/<skill>/g) ?? []).length < 6);
  assert.ok(Buffer.byteLength(after) < Buffer.byteLength(before) * 0.5,
    'the 31-entry catalog should shrink substantially without removing any skill path');
  assert.match(after, /Trusted safety and task contract remain unchanged/);
  assert.match(after, /original planText remains unmodified/);
  assert.match(after, /tool actually present in this request/);
  assert.equal(curateImplementerSkillPrompt(after, { taskText: 'Python pytest' }), after,
    'later phase transitions must not duplicate or widen the index');
});

test('#685 JS, Docker/CI and multi-domain tasks feature bounded relevant skills', () => {
  const names = ['python-testing-patterns', 'modern-javascript-patterns',
    'docker-compose', 'github-actions-hardening', 'security-review', 'repomap-navigation'];
  for (const [task, expected] of [
    ['Update src/main.mjs and run node tests.', ['modern-javascript-patterns']],
    ['Update Dockerfile and .github/workflows/test.yml for Docker CI.', ['docker-compose', 'github-actions-hardening']],
    ['Refactor Python pytest + TypeScript .ts, Dockerfile, GitHub Actions and security architecture.',
      ['python-testing-patterns', 'modern-javascript-patterns', 'docker-compose', 'github-actions-hardening', 'security-review']],
  ]) {
    const after = curateImplementerSkillPrompt(catalog(names), { taskText: task });
    const featured = after.match(/<available_skills>([\s\S]*?)<\/available_skills>/)?.[1] ?? '';
    for (const name of expected) assert.match(featured, new RegExp('<name>' + name + '</name>'), task);
    assert.ok((featured.match(/<skill>/g) ?? []).length <= 5, 'selection stays bounded');
    for (const name of names) {
      assert.ok(after.includes('/work/.agents/skills/' + name + '/SKILL.md'),
        'exact discovery location must remain available: ' + name);
    }
  }
});

test('#685 unfamiliar requests retain lossless dynamic discovery instead of guessed skills', () => {
  const names = ['python-testing-patterns', 'docker-compose', 'github-actions-hardening'];
  const before = catalog(names);
  const after = curateImplementerSkillPrompt(before, {
    taskText: 'Investigate the opaque flux calibrator with an unfamiliar cross-domain dependency.',
  });
  assert.equal((after.match(/<skill>/g) ?? []).length, 0);
  for (const name of names) {
    assert.match(after, new RegExp(name + '\\t/work/\\.agents/skills/' + name + '/SKILL\\.md'));
  }
  const malformed = before.replace('<location>/work/.agents/skills/docker-compose/SKILL.md</location>', '');
  assert.equal(curateImplementerSkillPrompt(malformed, { taskText: 'Dockerfile' }), malformed);
  const duplicated = catalog(['python-testing-patterns', 'python-testing-patterns']);
  assert.equal(curateImplementerSkillPrompt(duplicated, { taskText: 'pytest' }), duplicated);
  assert.equal(curateImplementerSkillPrompt('<system>no skills</system>', { taskText: 'pytest' }),
    '<system>no skills</system>');
});

test('#685 Main hook uses task prompt while isolated coding and non-Main sessions do not curate', () => {
  let handler;
  implementerSkillIndex({ on: (_name, callback) => { handler = callback; } });
  const stage = process.env.PI_STAGE;
  const child = process.env.PI_CODING_SESSION;
  const before = catalog(allNames);
  try {
    process.env.PI_STAGE = 'implementer';
    delete process.env.PI_CODING_SESSION;
    const first = handler({ systemPrompt: before, prompt: 'Create tests/test_terms.py with pytest.' });
    assert.ok(first?.systemPrompt.includes('<skill_discovery_index>'));
    assert.match(first.systemPrompt, /<name>python-testing-patterns<\/name>/);
    const later = handler({ systemPrompt: first.systemPrompt, prompt: 'submit_result' });
    assert.equal(later, undefined, 'a later phase must not mutate an already curated catalog');
    process.env.PI_CODING_SESSION = '{"sessionId":"child"}';
    assert.equal(handler({ systemPrompt: before, prompt: 'Python pytest' }), undefined);
    delete process.env.PI_CODING_SESSION;
    process.env.PI_STAGE = 'reviewer';
    assert.equal(handler({ systemPrompt: before, prompt: 'Python pytest' }), undefined);
  } finally {
    if (stage === undefined) delete process.env.PI_STAGE;
    else process.env.PI_STAGE = stage;
    if (child === undefined) delete process.env.PI_CODING_SESSION;
    else process.env.PI_CODING_SESSION = child;
  }
});


test('#685 provider-boundary metrics distinguish featured from indexed entries on first/later turns', () => {
  const system = curateImplementerSkillPrompt('<role>safe</role>\n' + catalog(allNames), {
    taskText: 'Create src/app.py with pytest',
  });
  const first = {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: '<shared_agent_contract/><role_contract/>' },
    ],
    tools: [],
  };
  const metadata = mainPromptRequestMetadata(first);
  assert.ok(metadata.skillCount > 0 && metadata.skillCount <= 5);
  assert.equal(metadata.indexedSkillCount + metadata.skillCount, 31);
  assert.equal(metadata.discoverableSkillCount, 31);
  assert.ok(metadata.skillCatalogBytes < 10398,
    'fixture: the curated catalog must be smaller than the #677 reference bytes');
  assert.equal(metadata.systemTextBytes, Buffer.byteLength(system));
  const next = mainPromptRequestMetadata({
    ...first,
    messages: [...first.messages, { role: 'assistant', content: 'verification complete' }],
  }, metadata);
  assert.equal(next.changedFromPrevious.system, false);
  assert.equal(next.discoverableSkillCount, metadata.discoverableSkillCount);
});
