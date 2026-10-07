import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertMainPromptComposition,
  mainPromptRequestMetadata,
} from '../scripts/pi-common/main-prompt-observability.mjs';
import { agentContractPrompt, implementerCodingContractPrompt } from '../scripts/pi-common/stage-config.mjs';

const initialUser = {
  role: 'user',
  content: '<shared_agent_contract source="agents/AGENTS.md">shared</shared_agent_contract>\n'
    + '<role_contract source="agents/implementer/AGENTS.md">role</role_contract>\n'
    + '<trusted_context>prepared</trusted_context>',
};

const tool = name => ({
  type: 'function',
  function: { name, description: `${name} tool`, parameters: { type: 'object', properties: {} } },
});

test('#540 Main prompt metadata proves one system message and stable static components across turns', () => {
  const firstPayload = {
    model: 'test',
    messages: [
      { role: 'system', content: 'pi base system prompt' },
      initialUser,
    ],
    tools: [tool('write'), tool('submit_result')],
  };
  const first = mainPromptRequestMetadata(firstPayload);
  assertMainPromptComposition(first);
  assert.equal(first.systemMessageCount, 1);
  assert.equal(first.sharedContractCount, 1);
  assert.equal(first.roleContractCount, 1);
  assert.equal(first.activeToolCount, 2);
  assert.deepEqual(first.changedFromPrevious, {
    system: null,
    initialUserContext: null,
    toolSchema: null,
  });

  const secondPayload = {
    ...firstPayload,
    messages: [
      ...firstPayload.messages,
      { role: 'assistant', content: [{ type: 'text', text: 'working' }] },
      { role: 'tool', content: 'result', tool_call_id: '1' },
      { role: 'user', content: 'runtime steer' },
    ],
  };
  const second = mainPromptRequestMetadata(secondPayload, first);
  assert.equal(second.systemPromptHash, first.systemPromptHash);
  assert.equal(second.initialUserContextHash, first.initialUserContextHash);
  assert.equal(second.toolSchemaHash, first.toolSchemaHash);
  assert.deepEqual(second.changedFromPrevious, {
    system: false,
    initialUserContext: false,
    toolSchema: false,
  });
  assert.ok(second.historyBytes > first.historyBytes);
  assert.ok(second.requestBodyBytes > first.requestBodyBytes);

  const third = mainPromptRequestMetadata({
    ...secondPayload,
    tools: [...secondPayload.tools, tool('read')],
  }, second);
  assert.equal(third.systemPromptHash, first.systemPromptHash);
  assert.equal(third.initialUserContextHash, first.initialUserContextHash);
  assert.equal(third.changedFromPrevious.system, false);
  assert.equal(third.changedFromPrevious.initialUserContext, false);
  assert.equal(third.changedFromPrevious.toolSchema, true);
  assert.notEqual(third.toolSchemaHash, second.toolSchemaHash);
});

test('#540 duplicate system or contract composition fails deterministically', () => {
  const valid = {
    messages: [{ role: 'system', content: 'base' }, initialUser],
    tools: [],
  };
  assert.doesNotThrow(() => assertMainPromptComposition(mainPromptRequestMetadata(valid)));

  const duplicateSystem = {
    ...valid,
    messages: [{ role: 'system', content: 'base' }, { role: 'system', content: 'duplicate' }, initialUser],
  };
  assert.throws(
    () => assertMainPromptComposition(mainPromptRequestMetadata(duplicateSystem)),
    /exactly one role=system/,
  );

  const duplicateContract = {
    ...valid,
    messages: [
      { role: 'system', content: 'base' },
      { ...initialUser, content: `${initialUser.content}\n${initialUser.content}` },
    ],
  };
  assert.throws(
    () => assertMainPromptComposition(mainPromptRequestMetadata(duplicateContract)),
    /exactly one shared contract and one Implementer role contract/,
  );
});


test('#540 generated Main contract matches direct repository access policy without leaking it into coding overlay', () => {
  const env = { ...process.env, GITHUB_WORKSPACE: process.cwd() };
  const main = agentContractPrompt('implementer', env);
  assert.equal((main.match(/<shared_agent_contract\b/g) ?? []).length, 1);
  assert.equal((main.match(/<role_contract\b/g) ?? []).length, 1);
  assert.match(main, /read/);
  assert.match(main, /repo_search/);
  assert.match(main, /indexed_repo_search/);
  assert.match(main, /bash/);
  assert.match(main, /do \*\*not\*\* require a preceding `need_more_evidence` call/);
  assert.match(main, /PreparedImplementation as the starting plan/);
  assert.doesNotMatch(main, /Broad `bash` is also blocked/);

  const coding = implementerCodingContractPrompt(env);
  assert.match(coding, /<coding_role_contract/);
  assert.doesNotMatch(coding, /In this fresh Main mode the runtime keeps these repository tools directly callable/);
  assert.match(coding, /one concrete fact blocks the next safe action.*need_more_evidence/s);
});
