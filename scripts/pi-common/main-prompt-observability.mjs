import { createHash } from 'node:crypto';

import { providerToolNames } from './session-state.mjs';

function serializedComponent(value) {
  return JSON.stringify(value ?? null);
}

function componentFingerprint(value) {
  const serialized = serializedComponent(value);
  return {
    bytes: Buffer.byteLength(serialized, 'utf8'),
    hash: createHash('sha256').update(serialized).digest('hex'),
  };
}

function messageText(message) {
  if (typeof message?.content === 'string') return message.content;
  if (!Array.isArray(message?.content)) return '';
  return message.content.map(part => typeof part === 'string' ? part : String(part?.text ?? '')).join('\n');
}

export function mainPromptRequestMetadata(payload, previous = null) {
  const messages = Array.isArray(payload?.messages) ? payload.messages : [];
  const systemMessages = messages.filter(message => message?.role === 'system');
  const initialUserIndex = messages.findIndex(message => message?.role === 'user');
  const initialUser = initialUserIndex >= 0 ? messages[initialUserIndex] : null;
  const history = messages.filter((message, index) =>
    message?.role !== 'system' && index !== initialUserIndex
  );
  const tools = Array.isArray(payload?.tools) ? payload.tools : [];
  const system = componentFingerprint(systemMessages);
  const user = componentFingerprint(initialUser);
  const toolSchema = componentFingerprint(tools);
  const conversation = componentFingerprint(history);
  const request = componentFingerprint(payload);
  const initialUserText = messageText(initialUser);

  return {
    systemMessageCount: systemMessages.length,
    systemPromptBytes: system.bytes,
    systemPromptHash: system.hash,
    initialUserContextBytes: user.bytes,
    initialUserContextHash: user.hash,
    sharedContractCount: (initialUserText.match(/<shared_agent_contract\b/g) ?? []).length,
    roleContractCount: (initialUserText.match(/<role_contract\b/g) ?? []).length,
    activeToolCount: tools.length,
    activeTools: providerToolNames(payload),
    toolSchemaBytes: toolSchema.bytes,
    toolSchemaHash: toolSchema.hash,
    historyBytes: conversation.bytes,
    requestBodyBytes: request.bytes,
    previousHashes: {
      systemPromptHash: previous?.systemPromptHash ?? null,
      initialUserContextHash: previous?.initialUserContextHash ?? null,
      toolSchemaHash: previous?.toolSchemaHash ?? null,
    },
    changedFromPrevious: {
      system: previous ? previous.systemPromptHash !== system.hash : null,
      initialUserContext: previous ? previous.initialUserContextHash !== user.hash : null,
      toolSchema: previous ? previous.toolSchemaHash !== toolSchema.hash : null,
    },
  };
}

export function assertMainPromptComposition(metadata) {
  if (metadata.systemMessageCount !== 1) {
    throw new Error(`Main provider request must contain exactly one role=system message; got ${metadata.systemMessageCount}`);
  }
  if (metadata.sharedContractCount !== 1 || metadata.roleContractCount !== 1) {
    throw new Error(
      `Main initial context must contain exactly one shared contract and one Implementer role contract; got shared=${metadata.sharedContractCount} role=${metadata.roleContractCount}`,
    );
  }
}
