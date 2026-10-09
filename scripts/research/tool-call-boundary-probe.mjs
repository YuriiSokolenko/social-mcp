#!/usr/bin/env node
// Standalone, local-only diagnostic for OpenAI-compatible tool-call boundaries.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export const TOOL_SCHEMAS = {
  write: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'], additionalProperties: false },
  submit_result: { type: 'object', properties: { resultText: { type: 'string' } }, required: ['resultText'], additionalProperties: false },
};
const TOOLS = Object.entries(TOOL_SCHEMAS).map(([name, parameters]) => ({ type: 'function', function: { name, description: name === 'write' ? 'Write synthetic source code into a file' : 'Submit a synthetic implementation summary', strict: true, parameters } }));

// Incremental SSE parser. raw contains the exact received bytes (as UTF-8 text); event data
// and argument strings are retained verbatim after SSE framing, without JSON repair.
export class SseToolCallParser {
  constructor() { this.pending = ''; this.raw = ''; this.events = []; this.choices = new Map(); this.sawDone = false; this.protocolError = null; this.firstTokenMs = null; this.startedAt = Date.now(); this.decoder = new TextDecoder(); }
  push(chunk) {
    const text = Buffer.isBuffer(chunk) || chunk instanceof Uint8Array ? this.decoder.decode(chunk, { stream: true }) : String(chunk);
    this.raw += text; this.pending += text;
    let match;
    while ((match = /\r?\n\r?\n/.exec(this.pending))) {
      const block = this.pending.slice(0, match.index); this.pending = this.pending.slice(match.index + match[0].length);
      this.#event(block);
    }
  }
  #event(block) {
    const lines = block.split(/\r?\n/); const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
    if (!data) { this.events.push({ raw: block, data: null }); return; }
    this.events.push({ raw: block, data });
    if (data === '[DONE]') { this.sawDone = true; return; }
    let payload; try { payload = JSON.parse(data); } catch { this.protocolError ??= 'malformed_sse_json'; return; }
    if (payload?.model) this.model = payload.model;
    if (payload?.choices?.length && this.firstTokenMs == null && payload.choices.some(c => c.delta && (c.delta.content || c.delta.reasoning || c.delta.tool_calls?.length))) this.firstTokenMs = Date.now() - this.startedAt;
    for (const choice of payload?.choices ?? []) {
      const ci = Number.isInteger(choice.index) ? choice.index : 0;
      const cstate = this.choices.get(ci) ?? { index: ci, content: '', reasoning: '', toolCalls: new Map(), finishReasons: [] }; this.choices.set(ci, cstate);
      if (typeof choice.delta?.content === 'string') cstate.content += choice.delta.content;
      if (typeof choice.delta?.reasoning === 'string') cstate.reasoning += choice.delta.reasoning;
      if (typeof choice.delta?.reasoning_content === 'string') cstate.reasoning += choice.delta.reasoning_content;
      for (const call of choice.delta?.tool_calls ?? []) {
        const ti = Number.isInteger(call.index) ? call.index : 0;
        const t = cstate.toolCalls.get(ti) ?? { index: ti, id: '', type: '', name: '', arguments: '' }; cstate.toolCalls.set(ti, t);
        if (typeof call.id === 'string') t.id += call.id;
        if (typeof call.type === 'string') t.type = call.type;
        if (typeof call.function?.name === 'string') t.name += call.function.name;
        if (typeof call.function?.arguments === 'string') t.arguments += call.function.arguments;
      }
      if (choice.finish_reason !== undefined && choice.finish_reason !== null) cstate.finishReasons.push(choice.finish_reason);
    }
    if (payload.usage) this.usage = payload.usage;
  }
  finish() {
    const tail = this.decoder.decode();
    if (tail) { this.raw += tail; this.pending += tail; }
    if (this.pending) { this.#event(this.pending); this.pending = ''; }
    return { raw: this.raw, events: this.events, choices: [...this.choices.values()].map(c => ({ ...c, toolCalls: [...c.toolCalls.values()] })), sawDone: this.sawDone, missingDone: !this.sawDone, protocolError: this.protocolError, usage: this.usage ?? null, model: this.model ?? null, firstTokenMs: this.firstTokenMs };
  }
}

export function validateToolCall(call) {
  let parsed;
  try { parsed = JSON.parse(call.arguments); } catch (error) { return { status: 'malformed_json', error: error.message, parsed: undefined, missing: [] }; }
  const schema = TOOL_SCHEMAS[call.name];
  if (!schema) return { status: 'unknown_tool', error: `Unknown tool: ${call.name}`, parsed, missing: [] };
  const missing = schema.required.filter(key => !Object.hasOwn(parsed ?? {}, key));
  const issues = [];
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) issues.push('arguments must be an object');
  else {
    for (const key of missing) issues.push(`${key}: must have required property ${key}`);
    for (const [key, value] of Object.entries(parsed)) {
      if (!Object.hasOwn(schema.properties, key)) issues.push(`${key}: additional property is not allowed`);
      else if (typeof value !== 'string') issues.push(`${key}: must be string`);
    }
  }
  return { status: issues.length ? 'schema_error' : 'valid', error: issues.join('; ') || null, parsed, missing };
}

function localUrl(value) {
  const u = new URL(value); const host = u.hostname.toLowerCase();
  const isLocal = host === 'localhost' || host === '::1' || host === '[::1]' || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
  if (u.protocol !== 'http:' || !isLocal || u.username || u.password) throw new Error(`Only explicit local/private HTTP endpoints without embedded credentials are allowed: ${value}`);
  return u.toString().replace(/\/$/, '');
}
const argValue = (args, key, fallback) => args.has(key) ? args.get(key) : fallback;
function parseArgs(argv) {
  const map = new Map(); const booleans = new Set(['dry-run', 'probe-reasoning', 'help']);
  for (let i = 0; i < argv.length; i++) { const token = argv[i]; if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`); const key = token.slice(2); if (booleans.has(key)) { map.set(key, true); continue; } if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new Error(`Missing value for --${key}`); map.set(key, argv[++i]); }
  return map;
}
function boolArg(v, name) { if (v === true || v === 'true') return true; if (v === 'false') return false; throw new Error(`--${name} must be true or false`); }
function largePayload() {
  return `# BEGIN TOOL_CALL_BOUNDARY_PROBE\n"""Synthetic deterministic probe; do not execute."""\n\n` + Array.from({ length: 180 }, (_, i) => `def transform_${String(i + 1).padStart(3, '0')}(value):\n    """Return a stable transformed value for case ${i + 1}."""\n    return f"case-${i + 1}:" + str(value)\n`).join('\n') + `\n# END TOOL_CALL_BOUNDARY_PROBE\n`;
}
const PROMPTS = {
  write: {
    small: 'Call write exactly once. Use path "probe/synthetic_small.py" and content for a valid Python file of 10-20 lines. Include marker lines # BEGIN TOOL_CALL_BOUNDARY_PROBE and # END TOOL_CALL_BOUNDARY_PROBE. Do not explain in text.',
    large: `Call write exactly once with path "probe/synthetic_large.py". The content must be a valid Python module with exactly 180 functions named transform_001 through transform_180, each accepting value, having a short docstring, and returning a deterministic f-string prefixed case-N:. Include the exact first marker # BEGIN TOOL_CALL_BOUNDARY_PROBE and final marker # END TOOL_CALL_BOUNDARY_PROBE. Do not summarize or omit functions. This synthetic file is not to be executed.`,
  },
  submit_result: { result: 'Call submit_result exactly once with resultText exactly: "Synthetic probe completed; no files were written and no generated code was executed."' },
};
function scenarios(args) {
  const suite = argValue(args, 'suite', 'quick'); if (!['quick', 'full', 'targeted'].includes(suite)) throw new Error('--suite must be quick, full, or targeted');
  const repeat = Number(argValue(args, 'repeat', suite === 'full' ? 3 : 1)); if (!Number.isInteger(repeat) || repeat < 1 || repeat > 100) throw new Error('--repeat must be 1..100');
  const list = [];
  if (suite === 'quick') list.push(
    { tool: 'write', toolChoice: 'required', strict: true, stream: true, payload: 'small', budget: 2048, reasoning: 'default' },
    { tool: 'write', toolChoice: 'required', strict: true, stream: false, payload: 'large', budget: 2048, reasoning: 'default' },
    { tool: 'write', toolChoice: 'required', strict: true, stream: true, payload: 'large', budget: 16384, reasoning: 'default' },
    { tool: 'submit_result', toolChoice: 'required', strict: true, stream: false, payload: 'result', budget: 2048, reasoning: 'default' },
  );
  if (suite === 'full') {
    // Deliberate pairwise coverage; avoid the full Cartesian product.
    const rows = [
      ['write','auto',false,true,'small',2048,'default'], ['write','required',true,false,'large',2048,'default'],
      ['write','named',false,false,'small',16384,'default'], ['write','named',true,true,'large',16384,'default'],
      ['submit_result','auto',true,false,'result',2048,'default'], ['submit_result','required',false,true,'result',16384,'default'],
      ['submit_result','named',true,true,'result',2048,'default'], ['submit_result','named',false,false,'result',16384,'default'],
      ['write','required',true,false,'small',16384,'thinking-off'], ['write','required',true,true,'small',2048,'thinking-off'],
    ];
    for (const [tool, toolChoice, strict, stream, payload, budget, reasoning] of rows) list.push({ tool, toolChoice, strict, stream, payload, budget, reasoning });
  }
  if (suite === 'targeted') list.push({ tool: argValue(args,'tool','write'), toolChoice: argValue(args,'tool-choice','required'), strict: boolArg(argValue(args,'strict','true'),'strict'), stream: boolArg(argValue(args,'stream','true'),'stream'), payload: argValue(args,'payload','small'), budget: Number(argValue(args,'budget','2048')), reasoning: argValue(args,'reasoning','default') });
  if (args.has('probe-reasoning')) {
    const base = list.filter(x => x.reasoning === 'default'); for (const item of base) list.push({ ...item, reasoning: 'thinking-off' });
  }
  for (const x of list) {
    if (!TOOL_SCHEMAS[x.tool]) throw new Error(`Unsupported tool: ${x.tool}`);
    if (!['auto','required','named'].includes(x.toolChoice)) throw new Error(`Unsupported tool choice: ${x.toolChoice}`);
    if (!['small','large','result'].includes(x.payload) || (x.tool === 'write' && x.payload === 'result') || (x.tool === 'submit_result' && x.payload !== 'result')) throw new Error(`Payload ${x.payload} does not match ${x.tool}`);
    if (![2048,16384].includes(Number(x.budget))) throw new Error('Budget must be 2048 or 16384');
    x.budget = Number(x.budget);
  }
  return { suite, repeat, cases: list };
}
function requestFor(s) {
  const tool = TOOLS.map(t => ({ ...t, function: { ...t.function, strict: s.strict } }));
  const toolChoice = s.toolChoice === 'named' ? { type: 'function', function: { name: s.tool } } : s.toolChoice;
  let user = s.tool === 'write' ? PROMPTS.write[s.payload] : PROMPTS.submit_result.result;
  if (s.tool === 'write' && s.payload === 'large') user += `\n\nRequired deterministic reference structure (do not copy as a shortcut; generate the complete content):\n${largePayload()}`;
  const body = { model: null, messages: [{ role: 'system', content: 'You are a diagnostic model. All tool calls are synthetic data; never execute them. Return the requested tool call.' }, { role: 'user', content: user }], tools: tool, tool_choice: toolChoice, max_completion_tokens: s.budget, temperature: 0, stream: s.stream };
  if (s.reasoning === 'thinking-off') body.chat_template_kwargs = { enable_thinking: false };
  return body;
}
async function getJson(url, timeout) {
  try { const response = await fetch(url, { signal: AbortSignal.timeout(timeout) }); const raw = Buffer.from(await response.arrayBuffer()); let json = null; try { json = JSON.parse(raw.toString()); } catch {} return { url, status: response.status, headers: Object.fromEntries(response.headers), data: json, raw: raw.toString('utf8') }; }
  catch (error) { return { url, error: error.message }; }
}
function parseNonStream(body, rawText) {
  let data; try { data = JSON.parse(rawText); } catch (error) { return { raw: rawText, malformedResponse: error.message, choices: [], missingDone: false }; }
  const choices = (data.choices ?? []).map(choice => ({ index: choice.index ?? 0, content: typeof choice.message?.content === 'string' ? choice.message.content : '', reasoning: choice.message?.reasoning_content ?? choice.message?.reasoning ?? '', finishReasons: choice.finish_reason == null ? [] : [choice.finish_reason], toolCalls: (choice.message?.tool_calls ?? []).map(call => ({ index: call.index ?? 0, id: call.id ?? '', type: call.type ?? '', name: call.function?.name ?? '', arguments: call.function?.arguments ?? '' })) }));
  return { raw: rawText, choices, usage: data.usage ?? null, model: data.model ?? null, missingDone: false, firstTokenMs: null };
}
export function classifyToolResponse(s, parsed, calls, validations, response, modelsComparable, endpointName) {
  const finish = parsed.choices.flatMap(c => c.finishReasons); const text = parsed.choices.map(c => c.content).join(''); const reasoning = parsed.choices.map(c => c.reasoning).join('');
  const invalid = validations.some(v => v.status !== 'valid'); const truncated = finish.includes('length') || ((parsed.usage?.completion_tokens ?? parsed.usage?.output_tokens ?? -1) >= s.budget);
  let category = 'UNKNOWN';
  if (response && response.status >= 400) category = 'SERVER_ERROR'; else if (truncated) category = 'OUTPUT_TRUNCATION'; else if (parsed.transportError || parsed.missingDone) category = endpointName === 'proxy' ? 'PROXY' : 'UNKNOWN'; else if (invalid && validations.some(v => v.status === 'schema_error')) category = 'SCHEMA_ERROR'; else if (invalid && validations.some(v => v.status === 'malformed_json')) category = 'MODEL_OR_BACKEND'; else if (response && response.status >= 200 && response.status < 300 && !calls.length && s.toolChoice !== 'auto') category = 'MODEL_OR_BACKEND';
  const requiredViolation = !parsed.transportError && !parsed.missingDone && response?.status >= 200 && response.status < 300 && s.toolChoice !== 'auto' && calls.length === 0;
  return { category, requiredViolation, reasoningOnly: !calls.length && !text && Boolean(reasoning), ordinaryText: !calls.length && Boolean(text), tokenCeilingReached: truncated, modelsComparable };
}
function summaryRow(result) { return `${result.id} | ${result.endpointName} | ${result.case.tool}/${result.case.toolChoice}/${result.case.strict?'strict':'non-strict'}/${result.case.stream?'stream':'non-stream'}/${result.case.payload}/${result.case.budget}/${result.case.reasoning} | ${result.outcome.category} | ${result.validation.map(x=>x.status).join(',')||'no tool call'} | [raw](raw-responses/${result.id}.bin)`; }
function p95(xs) { if (!xs.length) return null; return [...xs].sort((a,b)=>a-b)[Math.ceil(xs.length*.95)-1]; }

export async function run(argv = process.argv.slice(2)) {
  const args = parseArgs(argv); if (args.has('help')) { console.log('Usage: node scripts/research/tool-call-boundary-probe.mjs --direct-url URL --proxy-url URL [--suite quick|full|targeted] [--dry-run]'); return 0; }
  const major = Number(process.versions.node.split('.')[0]); if (major < 22) throw new Error(`Node.js 22 or newer is required; found ${process.version}`);
  const plan = scenarios(args);
  const direct = localUrl(argValue(args,'direct-url','http://127.0.0.1:3009/v1'));
  const proxy = localUrl(argValue(args,'proxy-url','http://127.0.0.1:4001/v1'));
  const endpoints = [{ name:'direct', base:direct }, { name:'proxy', base:proxy }];
  const concurrency = Number(argValue(args,'concurrency','1')), timeout = Number(argValue(args,'timeout-ms','120000'));
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new Error('--concurrency must be 1..16');
  if (!Number.isInteger(timeout) || timeout < 1000) throw new Error('--timeout-ms must be >= 1000');
  const maxRequests = Number(argValue(args,'max-requests','1000'));
  if (!Number.isInteger(maxRequests) || maxRequests < 1) throw new Error('--max-requests must be a positive integer');
  const jobs = endpoints.flatMap(endpoint => plan.cases.flatMap((c, ci) => Array.from({length:plan.repeat},(_,ri)=>({ endpoint, case:c, caseIndex:ci, repeatIndex:ri, id:`${endpoint.name}-case${ci+1}-r${ri+1}` }))));
  const seed=args.has('seed')?Number(args.get('seed')):null;
  if(seed!==null&&!Number.isSafeInteger(seed))throw new Error('--seed must be an integer');
  const manifest = { createdAt:new Date().toISOString(), suite:plan.suite, repeat:plan.repeat, requestCount:jobs.length, seed, endpoints:endpoints.map(e=>({name:e.name,url:e.base})), cases:plan.cases, requests:jobs.map(j=>({id:j.id,endpoint:j.endpoint.name,caseIndex:j.caseIndex+1,repeat:j.repeatIndex+1})), constraint_activation:'unverified', safety:'synthetic tool calls only; calls are never executed' };
  if (jobs.length > maxRequests) throw new Error(`Manifest has ${jobs.length} requests, exceeding --max-requests ${maxRequests}`);
  console.log(JSON.stringify(manifest,null,2));
  if (args.has('dry-run')) return 0;
  const output = path.resolve(argValue(args,'output-dir',path.join('reports','tool-call-boundary-probe',new Date().toISOString().replace(/[:.]/g,'-'))));
  for (const dir of ['requests','raw-responses','parsed-responses']) await fs.mkdir(path.join(output,dir),{recursive:true});
  await fs.writeFile(path.join(output,'manifest.json'),JSON.stringify(manifest,null,2));
  await fs.writeFile(path.join(output,'results.jsonl'),'');
  const timeoutMs = timeout;
  const environments = await Promise.all(endpoints.map(async e => {
    const [models, version, openapi] = await Promise.all([getJson(`${e.base}/models`,timeoutMs),getJson(`${e.base.replace(/\/v1$/,'')}/version`,timeoutMs),getJson(`${e.base.replace(/\/v1$/,'')}/openapi.json`,timeoutMs)]);
    return { name:e.name,base:e.base,models,version,openapi,modelIds:models.data?.data?.map(m=>m.id) ?? [], configEvidence:'Read-only endpoints only; parser/template/guided-decoding configuration is unverified unless exposed by server.' };
  }));
  const directIds = environments.find(e=>e.name==='direct').modelIds; const proxyIds = environments.find(e=>e.name==='proxy').modelIds;
  const common = directIds.filter(id=>proxyIds.includes(id));
  await fs.writeFile(path.join(output,'environment.json'),JSON.stringify({node:process.version,platform:process.platform,arch:process.arch,os:os.release(),endpoints:environments,modelComparison:{directIds,proxyIds,commonIds:common,comparable:common.length>0}},null,2));
  const selectedModels = {direct:argValue(args,'direct-model',common[0]??directIds[0]??null),proxy:argValue(args,'proxy-model',common[0]??proxyIds[0]??null)};
  const results = []; let cursor=0;
  async function worker() { while (cursor < jobs.length) { const job=jobs[cursor++]; const id=job.id; let req=requestFor(job.case); req.model=selectedModels[job.endpoint.name]; if (args.has('seed')) req.seed=Number(args.get('seed')); const serialized=JSON.stringify(req,null,2); const requestPath=`requests/${id}.json`; await fs.writeFile(path.join(output,requestPath),serialized);
    const started=Date.now(); let response=null, bodyRaw='', rawBuffer=Buffer.alloc(0), parsed; const responseChunks=[]; let streamParser=null;
    try {
      response=await fetch(`${job.endpoint.base}/chat/completions`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(req),signal:AbortSignal.timeout(timeoutMs)});
      if (job.case.stream) {
        streamParser=new SseToolCallParser(); streamParser.startedAt=started;
        if (response.body) for await (const chunk of response.body) { const bytes=Buffer.from(chunk); responseChunks.push(bytes); streamParser.push(bytes); }
        rawBuffer=Buffer.concat(responseChunks); parsed=streamParser.finish();
      } else { rawBuffer=Buffer.from(await response.arrayBuffer()); bodyRaw=rawBuffer.toString('utf8'); parsed=parseNonStream(req,bodyRaw); }
      parsed.status=response.status; parsed.headers=Object.fromEntries(response.headers);
    }
    catch(error) {
      rawBuffer=Buffer.concat(responseChunks); bodyRaw=rawBuffer.toString('utf8');
      parsed=job.case.stream&&streamParser ? streamParser.finish() : {raw:bodyRaw,choices:[],missingDone:false};
      parsed.transportError=error.message; parsed.status=response?.status??null; parsed.headers=response?Object.fromEntries(response.headers):{};
    }
    const latencyMs=Date.now()-started; const calls=parsed.choices.flatMap(c=>c.toolCalls.map(t=>({...t,choiceIndex:c.index}))); const validation=calls.map(validateToolCall); const actualModel=response?.headers.get('x-model-id') ?? parsed.model ?? req.model;
    const outcome=classifyToolResponse(job.case,parsed,calls,validation,response,common.length>0 && common.includes(actualModel),job.endpoint.name);
    const providerArguments=calls.map(call=>({choiceIndex:call.choiceIndex,toolIndex:call.index,name:call.name,arguments:call.arguments}));
    const payloadStructure=calls.map((call,index)=>{const content=validation[index]?.parsed?.content;if(typeof content!=='string')return null;const expected=job.case.payload==='large'?180:job.case.payload==='small'?null:null;return {startsWithMarker:content.startsWith('# BEGIN TOOL_CALL_BOUNDARY_PROBE'),endsWithMarker:content.trimEnd().endsWith('# END TOOL_CALL_BOUNDARY_PROBE'),expectedFunctionCount:expected,actualFunctionCount:(content.match(/^def transform_\d{3}\(value\):/gm)||[]).length};});
    const result={id,caseIndex:job.caseIndex+1,repeat:job.repeatIndex+1,endpointName:job.endpoint.name,endpoint:job.endpoint.base,model:actualModel,case:job.case,toolChoice:req.tool_choice,strict:job.case.strict,reasoningControls:job.case.reasoning==='thinking-off'?req.chat_template_kwargs:{},max_completion_tokens:job.case.budget,temperature:req.temperature,seed:req.seed??null,stream:req.stream,request:requestPath,httpStatus:response?.status??null,httpHeaders:parsed.headers??{},latencyMs,firstTokenMs:parsed.firstTokenMs??null,finishReasons:parsed.choices.flatMap(c=>c.finishReasons),usage:parsed.usage??null,completionTokens:parsed.usage?.completion_tokens??parsed.usage?.output_tokens??null,reasoningTokens:parsed.usage?.completion_tokens_details?.reasoning_tokens??parsed.usage?.output_tokens_details?.reasoning_tokens??null,RAW_PROVIDER_ARGUMENTS:providerArguments,PI_PARSED_ARGUMENTS:'unavailable: real Pi provider parser is not installed/replayed; see README',calls,validation,VALIDATION_RESULT:validation,payloadStructure,outcome,rawFile:`raw-responses/${id}.bin`,parsedFile:`parsed-responses/${id}.json`,sseMissingDone:parsed.missingDone??false,transportError:parsed.transportError??null};
    await fs.writeFile(path.join(output,result.rawFile),rawBuffer); await fs.writeFile(path.join(output,result.parsedFile),JSON.stringify({...parsed,choices:parsed.choices.map(c=>({...c,toolCalls:c.toolCalls}))},null,2)); results.push(result); console.log(`${id}: HTTP ${result.httpStatus??'ERROR'} ${outcome.category}`);
  }}
  await Promise.all(Array.from({length:Math.min(concurrency,jobs.length)},worker));
  results.sort((a,b)=>a.id.localeCompare(b.id));
  await fs.writeFile(path.join(output,'results.jsonl'),results.map(result=>JSON.stringify(result)).join('\n')+'\n');
  const categories=Object.fromEntries(['MODEL_OR_BACKEND','PROXY','PI_PARSING','OUTPUT_TRUNCATION','SCHEMA_ERROR','SERVER_ERROR','UNKNOWN'].map(k=>[k,results.filter(r=>r.outcome.category===k).length]));
  const failures=results.filter(r=>r.transportError||r.httpStatus>=400||r.outcome.requiredViolation||r.validation.some(v=>v.status!=='valid')||!r.calls.length&&r.case.toolChoice!=='auto');
  const validToolCalls=results.filter(r=>r.validation.length&&r.validation.every(v=>v.status==='valid')).length;
  const summary={requestCount:results.length,categories,validToolCalls,validToolCallPercent:results.length?Math.round(10000*validToolCalls/results.length)/100:0,missing_path:results.filter(r=>r.validation.some(v=>v.missing.includes('path'))).length,missing_content:results.filter(r=>r.validation.some(v=>v.missing.includes('content'))).length,missing_resultText:results.filter(r=>r.validation.some(v=>v.missing.includes('resultText'))).length,malformedJson:results.filter(r=>!r.transportError&&r.validation.some(v=>v.status==='malformed_json')).length,incompleteArgumentsOnTransport:results.filter(r=>r.transportError&&r.validation.some(v=>v.status==='malformed_json')).length,reasoningOnly:results.filter(r=>r.outcome.reasoningOnly).length,ordinaryTextOnly:results.filter(r=>r.outcome.ordinaryText).length,requiredViolations:results.filter(r=>r.outcome.requiredViolation).length,strictErrors:results.filter(r=>r.strict&&!r.transportError&&(r.httpStatus>=400||r.validation.some(v=>v.status!=='valid'))).length,tool_calls_finish_with_invalid_args:results.filter(r=>r.finishReasons.includes('tool_calls')&&r.validation.some(v=>v.status!=='valid')).length,stop_finish_with_tool_call:results.filter(r=>r.finishReasons.includes('stop')&&r.calls.length>0).length,missingDone:results.filter(r=>r.sseMissingDone).length,transportErrors:results.filter(r=>r.transportError).length,latencyMs:{mean:results.length?results.reduce((s,r)=>s+r.latencyMs,0)/results.length:null,p95:p95(results.map(r=>r.latencyMs))},environment:environments,failures:failures.map(r=>({id:r.id,category:r.outcome.category,endpoint:r.endpointName,raw:r.rawFile,validation:r.validation,requiredViolation:r.outcome.requiredViolation}))};
  await fs.writeFile(path.join(output,'summary.json'),JSON.stringify(summary,null,2));
  const rows=results.map(summaryRow).join('\n');
  const dimensions=[['Endpoint',['direct','proxy'],r=>r.endpointName],['Streaming',['stream','non-stream'],r=>r.case.stream?'stream':'non-stream'],['Budget',['2048','16384'],r=>String(r.case.budget)]];
  const comparisons=dimensions.map(([label,keys,keyOf])=>`${label} | requests | valid calls | valid % | malformed JSON | required violations\n---|---:|---:|---:|---:|---:\n${keys.map(key=>{const group=results.filter(r=>keyOf(r)===key);const valid=group.filter(r=>r.validation.length&&r.validation.every(v=>v.status==='valid')).length;return `${key} | ${group.length} | ${valid} | ${group.length?(100*valid/group.length).toFixed(1):'n/a'}% | ${group.filter(r=>r.validation.some(v=>v.status==='malformed_json')).length} | ${group.filter(r=>r.outcome.requiredViolation).length}`;}).join('\n')}`).join('\n\n');
  const report=`# Tool-call boundary probe\n\n- Run: ${manifest.createdAt}\n- Suite: ${plan.suite}; requests: ${results.length}\n- Constraint activation: **unverified** (successful strict calls do not establish constrained decoding).\n- Model IDs: direct ${JSON.stringify(directIds)}; proxy ${JSON.stringify(proxyIds)}; common ${JSON.stringify(common)}. Comparable IDs: ${common.length?common.join(', '):'none; do not compare direct and proxy as the same model'}.\n- vLLM parser, reasoning parser, chat template overrides, automatic tool choice and guided decoding: ${environments.map(e=>`${e.name}: ${e.configEvidence}`).join(' ')}\n\n## Summary\n\n- Valid tool calls: ${summary.validToolCalls}/${results.length} (${summary.validToolCallPercent}%)\n- Missing path/content/resultText: ${summary.missing_path}/${summary.missing_content}/${summary.missing_resultText}\n- Malformed JSON without transport interruption: ${summary.malformedJson}; incomplete arguments on transport errors: ${summary.incompleteArgumentsOnTransport}; reasoning-only: ${summary.reasoningOnly}; ordinary-text-only: ${summary.ordinaryTextOnly}; required violations: ${summary.requiredViolations}; strict errors: ${summary.strictErrors}; transport errors: ${summary.transportErrors}\n- tool_calls with invalid args: ${summary.tool_calls_finish_with_invalid_args}; stop with a tool call: ${summary.stop_finish_with_tool_call}; missing [DONE]: ${summary.missingDone}\n- Categories: ${JSON.stringify(categories)}\n- Latency mean/p95: ${summary.latencyMs.mean?.toFixed(1)??'n/a'} / ${summary.latencyMs.p95??'n/a'} ms\n\n## Direct/proxy, streaming and budget comparisons\n\n${comparisons}\n\nThe table uses only this run's observed cases. Payload and strict differences are represented in the request table below. Thinking-off cases are labeled in each combination; unsupported template kwargs may be ignored by an endpoint.\n\n## Requests\n\nID | endpoint | combination | classification | validation | raw\n---|---|---|---|---|---\n${rows}\n\n## Boundary interpretation\n\nA direct/proxy difference with the same model ID localizes a change to the proxy path only when request bodies and server identities are comparable. This probe cannot distinguish model sampling from vLLM parser behavior without raw vLLM-side evidence; it records raw HTTP responses at each exposed boundary. The PI_PARSING category is reserved for actual optional replay evidence and is not inferred by this run. RAW_PROVIDER_ARGUMENTS is preserved; PI_PARSED_ARGUMENTS is explicitly unavailable without the real parser, and VALIDATION_RESULT is the independent syntax/schema check. Review each raw response and parsed artifact. Incomplete arguments below the token ceiling are not automatically labeled truncation.\n`;
  await fs.writeFile(path.join(output,'report.md'),report);
  console.log(`Report: ${path.join(output,'report.md')}`); return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run().then(code=>{process.exitCode=code;}).catch(error=>{console.error(error.stack??error);process.exitCode=1;});
