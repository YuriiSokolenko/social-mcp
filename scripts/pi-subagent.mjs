import fs from 'node:fs';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { Type } from 'typebox';

const CHILD_TOOLS = 'read,bash,grep,find,ls';
const MAX_RESULT_CHARS = 12000;

function messageText(message) {
  if (!message || message.role !== 'assistant' || !Array.isArray(message.content)) return '';
  return message.content
    .filter(part => part?.type === 'text' && typeof part.text === 'string')
    .map(part => part.text)
    .join('');
}

function addUsage(total, usage) {
  if (!usage) return;
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens']) {
    if (Number.isFinite(usage[key])) total[key] += usage[key];
  }
}

function appendMetric(usage, elapsedMs) {
  if (!process.env.PI_METRICS_FILE) return;
  const issue = /^\d+$/.test(process.env.PI_ISSUE ?? '') ? Number(process.env.PI_ISSUE) : 0;
  const metric = {
    issue,
    phase: process.env.PI_PHASE ?? 'implementation',
    call: 'subagent',
    response: 1,
    usage,
    responseMs: elapsedMs,
  };
  fs.appendFileSync(process.env.PI_METRICS_FILE, JSON.stringify(metric) + '\n');
}

async function runSubagent(task, signal) {
  const provider = process.env.PI_PROVIDER || 'hp-laguna';
  const model = process.env.PI_MODEL || 'qwen3.8-flash-next';
  const prompt = [
    'You are a read-only repository subagent working for a parent coding agent.',
    'Answer exactly one bounded repository question.',
    'You may use read, grep, find, ls, and bash only for read-only inspection or focused verification.',
    'Never edit/write files, never mutate Git state, never commit/push, never change GitHub state, and never call external production APIs.',
    'Prefer the smallest set of tool calls needed. Return compact conclusions, relevant paths/symbols, exact snippets or edit anchors when requested, and verification results.',
    'Do not take ownership of the parent task and do not produce a top-level implementation plan.',
    '',
    'Delegated task:',
    task,
  ].join('\n');

  const args = [
    '--provider', provider,
    '--model', model,
    '--mode', 'json',
    '--no-session',
    '--no-extensions',
    '--tools', CHILD_TOOLS,
    prompt,
  ];
  const startedAt = Date.now();
  const child = spawn('pi', args, {
    cwd: process.cwd(),
    env: { ...process.env, PI_STAGE: '', PI_PHASE: 'subagent' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');

  let stderr = '';
  child.stderr.on('data', chunk => {
    stderr = (stderr + chunk).slice(-8000);
  });

  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
  let finalText = '';
  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, childSignal) => resolve({ code: code ?? 1, signal: childSignal }));
  });
  const abort = () => child.kill('SIGTERM');
  signal?.addEventListener('abort', abort, { once: true });

  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event.type === 'message_end' && event.message?.role === 'assistant') {
        addUsage(usage, event.message.usage);
        const text = messageText(event.message);
        if (text.trim()) finalText = text;
      }
    }
    const result = await closed;
    if (signal?.aborted) throw new Error('Subagent aborted');
    if (result.signal) throw new Error(`Subagent terminated by ${result.signal}`);
    if (result.code !== 0) throw new Error(`Subagent failed with exit code ${result.code}: ${stderr.trim().slice(-2000)}`);
    if (!finalText.trim()) throw new Error('Subagent completed without a final answer');

    appendMetric(usage, Date.now() - startedAt);
    const text = finalText.length > MAX_RESULT_CHARS
      ? finalText.slice(0, MAX_RESULT_CHARS) + '\n… subagent result truncated'
      : finalText;
    return { text, usage };
  } finally {
    signal?.removeEventListener('abort', abort);
    rl.close();
  }
}

export default function (pi) {
  pi.registerTool({
    name: 'subagent',
    label: 'Repository subagent',
    description: 'Delegate one bounded repository read/search/diagnostic/verification question to an isolated read-only Pi process. The parent agent retains all planning and mutation ownership.',
    promptSnippet: 'Delegate repository reads, search, diagnostics, focused verification, Git inspection, docs, and skills to an isolated read-only subagent.',
    promptGuidelines: [
      'Use subagent for repository facts instead of direct read/bash/grep/find/ls.',
      'Give subagent one concrete question and request compact evidence needed for the next edit or decision.',
    ],
    parameters: Type.Object({
      task: Type.String({ description: 'One bounded repository question or verification objective. Include the exact evidence or edit anchor the parent needs.' }),
    }),
    async execute(_toolCallId, params, signal) {
      const result = await runSubagent(params.task, signal);
      return {
        content: [{ type: 'text', text: result.text }],
        details: { usage: result.usage },
      };
    },
  });
}
