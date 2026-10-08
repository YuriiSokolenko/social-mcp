import test from 'node:test';
import assert from 'node:assert/strict';

import implementerSkillIndex, { compactImplementerSkillPrompt } from '../scripts/pi-implementer-skill-index.mjs';
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
  const compressed = compactImplementerSkillPrompt('<role>safe</role>\\n' + catalog(allNames));
  const first = {
    messages: [
      { role: 'system', content: compressed },
      { role: 'user', content: '<shared_agent_contract/>\\n<role_contract/>' },
    ],
    tools: [],
  };
  const firstMetrics = mainPromptRequestMetadata(first);
  assert.equal(firstMetrics.systemTextBytes, Buffer.byteLength(compressed, 'utf8'));
  assert.equal(firstMetrics.skillCount, allNames.length);
  assert.equal(firstMetrics.skillNames.length, allNames.length);
  assert.equal(firstMetrics.skillNames.at(-1), 'github-actions-hardening');
  assert.ok(firstMetrics.skillCatalogBytes > 0);
  const next = mainPromptRequestMetadata({
    ...first,
    messages: [...first.messages, { role: 'assistant', content: 'progress' }],
  }, firstMetrics);
  assert.equal(next.skillCatalogBytes, firstMetrics.skillCatalogBytes);
  assert.equal(next.systemTextBytes, firstMetrics.systemTextBytes);
  assert.equal(next.changedFromPrevious.system, false);
});
