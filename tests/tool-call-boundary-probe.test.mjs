import test from 'node:test';
import assert from 'node:assert/strict';
import { SseToolCallParser, classifyToolResponse, validateToolCall } from '../scripts/research/tool-call-boundary-probe.mjs';

const frame = payload => `data: ${JSON.stringify(payload)}\n\n`;

test('SSE parser handles arbitrary TCP fragmentation and preserves argument text', () => {
  const raw = frame({ choices:[{ index:0, delta:{ tool_calls:[{ index:0, id:'call_1', function:{ name:'write', arguments:'{"path":"a.py",' } }] } }] }) +
    frame({ choices:[{ index:0, delta:{ tool_calls:[{ index:0, function:{ arguments:'"content":"x"}' } }] }, finish_reason:'tool_calls' }] }) + 'data: [DONE]\n\n';
  const parser = new SseToolCallParser();
  for (let i=0;i<raw.length;i+=3) parser.push(raw.slice(i,i+3));
  const result=parser.finish();
  assert.equal(result.raw,raw); assert.equal(result.sawDone,true);
  assert.equal(result.choices[0].toolCalls[0].arguments,'{"path":"a.py","content":"x"}');
  assert.deepEqual(result.choices[0].finishReasons,['tool_calls']);
});

test('SSE parser handles UTF-8 characters split across byte chunks and reports missing DONE', () => {
  const raw=frame({choices:[{index:0,delta:{tool_calls:[{index:0,function:{name:'submit_result',arguments:'{"resultText":"café"}'}}]}}]});
  const bytes=Buffer.from(raw); const parser=new SseToolCallParser();
  for(let i=0;i<bytes.length;i++) parser.push(bytes.subarray(i,i+1));
  const result=parser.finish(); assert.equal(result.raw,raw); assert.equal(result.missingDone,true);
  assert.equal(result.choices[0].toolCalls[0].arguments,'{"resultText":"café"}');
});

test('SSE parser keeps multiple calls separated by choice and tool index', () => {
  const parser=new SseToolCallParser();
  parser.push(frame({ choices:[{ index:0,delta:{tool_calls:[{index:0,function:{name:'write',arguments:'{}'}},{index:1,function:{name:'submit_result',arguments:'{}'}}]}},{index:1,delta:{tool_calls:[{index:0,function:{name:'write',arguments:'{}'}}]}}] }));
  const state=parser.finish();
  assert.equal(state.choices.length,2); assert.deepEqual(state.choices.map(c=>c.toolCalls.length),[2,1]);
});

test('malformed and missing-closing-brace arguments remain malformed, never become empty objects', () => {
  assert.equal(validateToolCall({name:'write',arguments:'{"path":"a.py"'}).status,'malformed_json');
  assert.equal(validateToolCall({name:'write',arguments:'{broken'}).status,'malformed_json');
});

test('valid JSON with absent required fields is a schema error with explicit missing fields', () => {
  const result=validateToolCall({name:'write',arguments:'{"content":"x"}'});
  assert.equal(result.status,'schema_error'); assert.deepEqual(result.missing,['path']);
  assert.deepEqual(validateToolCall({name:'submit_result',arguments:'{}'}).missing,['resultText']);
});

test('empty deltas and unexpected finish reasons do not invent a tool call', () => {
  const parser=new SseToolCallParser(); parser.push(frame({choices:[{index:0,delta:{},finish_reason:'content_filter'}]}));
  const state=parser.finish(); assert.deepEqual(state.choices[0].toolCalls,[]); assert.deepEqual(state.choices[0].finishReasons,['content_filter']);
});

test('JSON parseable wrong tool names are classified independently', () => {
  assert.equal(validateToolCall({name:'write_typo',arguments:'{}'}).status,'unknown_tool');
});

test('both tool schemas accept their required string fields', () => {
  assert.equal(validateToolCall({name:'write',arguments:'{"path":"p.py","content":"print(1)"}'}).status,'valid');
  assert.equal(validateToolCall({name:'submit_result',arguments:'{"resultText":"done"}'}).status,'valid');
});

test('transport interruption outranks partial malformed JSON and is not a tool-choice violation', () => {
  const outcome=classifyToolResponse({toolChoice:'required'}, {transportError:'timeout',missingDone:true,choices:[]}, [], [], {status:200}, false, 'proxy');
  assert.equal(outcome.category,'PROXY'); assert.equal(outcome.requiredViolation,false);
  const partial=classifyToolResponse({toolChoice:'required'}, {transportError:'timeout',missingDone:true,choices:[]}, [{name:'write'}], [{status:'malformed_json'}], {status:200}, false, 'proxy');
  assert.equal(partial.category,'PROXY'); assert.equal(partial.requiredViolation,false);
});

test('required is a violation only for a successful response that omits a tool call', () => {
  const failed=classifyToolResponse({toolChoice:'required'}, {choices:[]}, [], [], null, false, 'direct');
  assert.equal(failed.requiredViolation,false);
  const textResponse=classifyToolResponse({toolChoice:'required'}, {choices:[{content:'just text',reasoning:'',finishReasons:['stop']}]}, [], [], {status:200}, false, 'direct');
  assert.equal(textResponse.requiredViolation,true); assert.equal(textResponse.category,'MODEL_OR_BACKEND');
});
