import test from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { SseToolCallParser, classifyToolResponse, compressEvidenceBuffer, evaluateComparability, pairComparisonRecords, timeoutSettings, validateToolCall, plannerSyntheticMessages } from '../scripts/research/tool-call-boundary-probe.mjs';

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
  assert.deepEqual(validateToolCall({name:'submit_result',arguments:'{}'}).missing,['resultText','files']);
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
  assert.equal(validateToolCall({name:'submit_result',arguments:'{"resultText":"done","files":["a.py"]}'}).status,'valid');
});

test('#681 planner probe dry-run produces matched auto, required and named tool-choice cases', () => {
  const child = spawnSync(process.execPath, [
    'scripts/research/tool-call-boundary-probe.mjs', '--suite', 'planner',
    '--dry-run', '--repeat', '1', '--max-requests', '12',
  ], { encoding: 'utf8', timeout: 15000 });
  assert.equal(child.status, 0, child.stderr);
  const manifest = JSON.parse(child.stdout);
  assert.equal(manifest.requestCount, 12);
  assert.equal(manifest.cases.length, 6);
  assert.deepEqual(manifest.cases.map(c => c.toolChoice),
    ['auto', 'required', 'named', 'auto', 'required', 'named']);
  assert.deepEqual(manifest.cases.map(c => c.contextVariant),
    ['short', 'short', 'short', 'research', 'research', 'research']);
  assert.ok(manifest.cases.every(c => c.tool === 'submit_plan' && c.budget === 4096 &&
    c.payload === 'plan' && c.stream === true && c.strict === true));
  assert.equal(manifest.requests.filter(r => r.endpoint === 'direct').length, 6);
  assert.equal(manifest.requests.filter(r => r.endpoint === 'proxy').length, 6);
  assert.equal(validateToolCall({ name: 'submit_plan', arguments: '{"planText":"Update src/a.py and test."}' }).status, 'valid');
  assert.deepEqual(validateToolCall({ name: 'submit_plan', arguments: '{}' }).missing, ['planText']);
  assert.equal(validateToolCall({ name: 'submit_plan', arguments: '{"planText":123}' }).status, 'schema_error');
  assert.equal(validateToolCall({ name: 'submit_plan', arguments: '{"planText":""}' }).status, 'schema_error');
});

test('#681 synthetic Planner research history includes completed begin and retains only submit_plan at wire', () => {
  const short = plannerSyntheticMessages('short');
  const research = plannerSyntheticMessages('research');
  assert.ok(short.length < research.length);
  assert.equal(research.filter(m => m.role === 'tool').length, 25);
  assert.equal(research.filter(m => m.role === 'assistant' && m.tool_calls?.[0]?.function?.name === 'read').length, 24);
  assert.equal(research.at(-2).tool_call_id, 'synthetic_begin_submission');
  assert.equal(research.at(-1).role, 'user');
  assert.match(research.at(-1).content, /complete actionable plan/);
  assert.doesNotMatch(research.at(-1).content, /planText exactly|Call submit_plan exactly/);
  assert.ok(JSON.stringify(research).length > 10000);
  assert.ok(research.some(m => m.role === 'tool' && m.content.includes('preserve cancellation')));
});

test('submit_result files must be an array of strings, not JSON encoded text', () => {
  assert.equal(validateToolCall({name:'submit_result',arguments:'{"resultText":"done","files":["a.py"]}'}).status,'valid');
  assert.equal(validateToolCall({name:'submit_result',arguments:'{"resultText":"done","files":"[\\"a.py\\"]"}'}).status,'schema_error');
  assert.equal(validateToolCall({name:'submit_result',arguments:'{"resultText":"done","files":[1]}'}).status,'schema_error');
});

test('transport interruption outranks partial malformed JSON and is not a tool-choice violation', () => {
  const outcome=classifyToolResponse({toolChoice:'required'}, {transportError:'timeout',missingDone:true,choices:[]}, [], [], {status:200}, false, 'proxy');
  assert.equal(outcome.category,'TRANSPORT_ERROR'); assert.equal(outcome.requiredViolation,false);
  const partial=classifyToolResponse({toolChoice:'required'}, {transportError:'timeout',missingDone:true,choices:[]}, [{name:'write'}], [{status:'malformed_json'}], {status:200}, false, 'proxy');
  assert.equal(partial.category,'TRANSPORT_ERROR'); assert.equal(partial.requiredViolation,false);
});

test('client interruption is never classified as proven output truncation, even at token budget', () => {
  const outcome=classifyToolResponse({toolChoice:'required',budget:2048},{transportError:'timeout',missingDone:true,usage:{completion_tokens:2048},choices:[]},[],[],{status:200},true,'direct');
  assert.equal(outcome.category,'TRANSPORT_ERROR'); assert.equal(outcome.tokenCeilingReached,false);
});

test('unreachable direct endpoint makes the run NOT_COMPARABLE', () => {
  const result=evaluateComparability([{name:'direct',models:{error:'fetch failed'},modelIds:[]},{name:'proxy',models:{status:200},modelIds:['Qwen']}],{direct:'Qwen',proxy:'Qwen'});
  assert.equal(result.comparable,false); assert.match(result.reasons.join(' '),/direct \/v1\/models unavailable/);
});

test('different model IDs make the run NOT_COMPARABLE', () => {
  const result=evaluateComparability([{name:'direct',models:{status:200},modelIds:['Qwen-A']},{name:'proxy',models:{status:200},modelIds:['Qwen-B']}],{direct:'Qwen-A',proxy:'Qwen-B'});
  assert.equal(result.comparable,false); assert.match(result.reasons.join(' '),/model IDs differ/);
});

test('timeout metadata distinguishes the 600 second default from a CLI override', () => {
  assert.equal(timeoutSettings(new Map(),600000).origin,'default');
  assert.equal(timeoutSettings(new Map([['timeout-ms','900000']]),900000).effectiveRequestTimeoutMs,900000);
  assert.equal(timeoutSettings(new Map([['timeout-ms','900000']]),900000).origin,'explicit_cli');
});

test('paired comparison joins by scenario/repetition and preserves absent attempts', () => {
  const result=pairComparisonRecords([
    {pairKey:'case1-r1',caseIndex:1,repeat:1,endpointName:'direct',httpStatus:200,validation:[{status:'valid'}],latencyMs:20},
    {pairKey:'case1-r1',caseIndex:1,repeat:1,endpointName:'proxy',httpStatus:200,validation:[{status:'schema_error'}],latencyMs:30},
    {pairKey:'case1-r2',caseIndex:1,repeat:2,endpointName:'direct',httpStatus:null,validation:[],outcome:{category:'TRANSPORT_ERROR'}},
  ]);
  assert.equal(result.length,2); assert.equal(result[0].validityDifference,-1); assert.equal(result[0].latencyDifferenceMs,10);
  assert.equal(result[1].bothAttempted,false); assert.equal(result[1].proxy.category,'NOT_ATTEMPTED');
});

test('gzip evidence preserves every raw response byte', () => {
  const raw=Buffer.from('data: {"choices":[]}\r\n\r\ndata: [DONE]\n\n');
  assert.deepEqual(gunzipSync(compressEvidenceBuffer(raw)),raw);
});

test('required is a violation only for a successful response that omits a tool call', () => {
  const failed=classifyToolResponse({toolChoice:'required'}, {choices:[]}, [], [], null, false, 'direct');
  assert.equal(failed.requiredViolation,false);
  const textResponse=classifyToolResponse({toolChoice:'required'}, {choices:[{content:'just text',reasoning:'',finishReasons:['stop']}]}, [], [], {status:200}, false, 'direct');
  assert.equal(textResponse.requiredViolation,true); assert.equal(textResponse.category,'MODEL_OR_BACKEND');
});
