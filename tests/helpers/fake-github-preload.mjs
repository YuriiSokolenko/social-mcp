/**
 * `node --import` preload that replaces global fetch with a stateful,
 * in-memory GitHub REST model for one repository.
 *
 * WHY: orchestration tests must run the production stage entrypoints
 * (scripts/pi-*.mjs) unmodified, across several processes, against one shared
 * GitHub state. The state lives in the JSON file named by
 * PI_FAKE_GITHUB_STORE, so each stage process observes what earlier stages did.
 *
 * The model covers only the routes the control plane uses. An unknown route
 * or any non-GitHub URL is an error, so a test can never reach a real service.
 *
 * Fault injection (store.faults, consumed in order, first match wins):
 *   { method, path, status, body }   respond with an HTTP error
 *   { method, path, kind: 'timeout' } never respond; rejects on the caller's abort signal
 *   { method, path, kind: 'network' } throw like a refused connection
 *   skip: N   let the first N matching requests through first
 *   times: N  fault N matching requests (default 1, -1 = always)
 * Interleaving (store.interleave) applies `patch` to the store just before a
 * matching request is served, to model another actor winning a race.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const storeFile = process.env.PI_FAKE_GITHUB_STORE;
if (!storeFile) throw new Error('PI_FAKE_GITHUB_STORE is required by the fake GitHub preload');

const load = () => JSON.parse(readFileSync(storeFile, 'utf8'));
const save = store => writeFileSync(storeFile, JSON.stringify(store, null, 1));
const now = () => new Date().toISOString();
const json = (value, status = 200) => Response.json(value, { status });
const empty = status => new Response(null, { status });
const error = (status, message) => new Response(JSON.stringify({ message }), { status });
const names = labels => (labels ?? []).map(label => typeof label === 'string' ? label : label.name);
const asLabels = list => [...new Set(list)].map(name => ({ name }));

function page(items, searchParams) {
  const perPage = Number(searchParams.get('per_page') ?? 30);
  const number = Number(searchParams.get('page') ?? 1);
  return items.slice((number - 1) * perPage, number * perPage);
}

function matches(rule, method, path) {
  return (!rule.method || rule.method === method) && new RegExp(rule.path).test(path);
}

function takeRule(list, method, path) {
  for (const rule of list ?? []) {
    if (!matches(rule, method, path)) continue;
    rule.seen = (rule.seen ?? 0) + 1;
    if (rule.seen <= (rule.skip ?? 0)) continue;
    const times = rule.times ?? 1;
    if (times !== -1 && (rule.used ?? 0) >= times) continue;
    rule.used = (rule.used ?? 0) + 1;
    return rule;
  }
  return null;
}

function deepMerge(target, patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && target[key] && typeof target[key] === 'object') {
      deepMerge(target[key], value);
    } else {
      target[key] = value;
    }
  }
}

function issueView(store, number) {
  const issue = store.issues[number];
  if (issue) return issue;
  const pr = store.pulls[number];
  if (!pr) return null;
  return { number, title: pr.title, body: pr.body, state: pr.state, labels: pr.labels, pull_request: {} };
}

function setLabels(store, number, labels) {
  const target = store.issues[number] ?? store.pulls[number];
  target.labels = asLabels(names(labels));
  target.updated_at = now();
  return target;
}

function route(store, method, pathname, searchParams, body) {
  const repoRoot = `/repos/${store.repo}`;
  if (!pathname.startsWith(repoRoot)) return error(404, `foreign repository ${pathname}`);
  const path = pathname.slice(repoRoot.length);
  let m;

  if (path === '/labels' && method === 'POST') {
    if (store.labelsCreated.includes(body.name)) return error(422, 'already_exists');
    store.labelsCreated.push(body.name);
    return json(body, 201);
  }

  if (path === '/issues' && method === 'GET') {
    const state = searchParams.get('state') ?? 'open';
    const all = [...Object.keys(store.issues), ...Object.keys(store.pulls)].map(Number).sort((a, b) => a - b)
      .map(number => issueView(store, number))
      .filter(item => state === 'all' || item.state === state);
    return json(page(all, searchParams));
  }
  if (path === '/issues' && method === 'POST') {
    const number = store.nextNumber++;
    store.issues[number] = {
      number, title: body.title, body: body.body, state: 'open', state_reason: null,
      labels: asLabels(body.labels ?? []), created_at: now(), updated_at: now(),
    };
    return json(store.issues[number], 201);
  }
  if ((m = /^\/issues\/(\d+)$/.exec(path))) {
    const number = Number(m[1]);
    const item = issueView(store, number);
    if (!item) return error(404, 'Not Found');
    if (method === 'GET') return json(item);
    if (method === 'PATCH') {
      const target = store.issues[number] ?? store.pulls[number];
      if (body.labels) target.labels = asLabels(names(body.labels));
      for (const key of ['title', 'body', 'state', 'state_reason']) if (key in body) target[key] = body[key];
      target.updated_at = now();
      return json(issueView(store, number));
    }
  }
  if ((m = /^\/issues\/(\d+)\/labels$/.exec(path)) && method === 'PUT') {
    if (!issueView(store, Number(m[1]))) return error(404, 'Not Found');
    return json(setLabels(store, Number(m[1]), body.labels).labels);
  }
  if ((m = /^\/issues\/(\d+)\/comments$/.exec(path))) {
    const number = Number(m[1]);
    if (method === 'GET') return json(page(store.comments.filter(item => item.issue === number), searchParams));
    if (method === 'POST') {
      const comment = { id: store.nextCommentId++, issue: number, body: body.body, user: { login: 'github-actions[bot]' } };
      store.comments.push(comment);
      return json(comment, 201);
    }
  }

  if (path === '/pulls' && method === 'GET') {
    const state = searchParams.get('state') ?? 'open';
    const head = searchParams.get('head');
    const base = searchParams.get('base');
    const list = Object.values(store.pulls)
      .filter(pr => state === 'all' || pr.state === state)
      .filter(pr => !head || `${pr.head.repo.full_name.split('/')[0]}:${pr.head.ref}` === head)
      .filter(pr => !base || pr.base.ref === base)
      .sort((a, b) => a.number - b.number);
    return json(page(list, searchParams));
  }
  if (path === '/pulls' && method === 'POST') {
    const sha = store.refs[`heads/${body.head}`];
    if (!sha) return error(422, `head ${body.head} does not exist`);
    if (Object.values(store.pulls).some(pr => pr.state === 'open' && pr.head.ref === body.head)) {
      return error(422, `A pull request already exists for ${body.head}`);
    }
    const number = store.nextNumber++;
    store.pulls[number] = {
      number, title: body.title, body: body.body, state: 'open', draft: false, merged: false, merged_at: null,
      merge_commit_sha: null, labels: [], changed_files: 1, files: [{ filename: 'src/app.py', status: 'modified' }],
      base: { ref: body.base, repo: { full_name: store.repo } },
      head: { ref: body.head, sha, repo: { full_name: store.repo } },
      html_url: `https://github.invalid/${store.repo}/pull/${number}`,
      created_at: now(), updated_at: now(),
    };
    return json(store.pulls[number], 201);
  }
  if ((m = /^\/pulls\/(\d+)$/.exec(path))) {
    const pr = store.pulls[m[1]];
    if (!pr) return error(404, 'Not Found');
    if (method === 'GET') return json(pr);
    if (method === 'PATCH') {
      for (const key of ['title', 'body', 'state']) if (key in body) pr[key] = body[key];
      pr.updated_at = now();
      return json(pr);
    }
  }
  if ((m = /^\/pulls\/(\d+)\/files$/.exec(path)) && method === 'GET') {
    return json(page(store.pulls[m[1]]?.files ?? [], searchParams));
  }
  if ((m = /^\/pulls\/(\d+)\/merge$/.exec(path)) && method === 'PUT') {
    const pr = store.pulls[m[1]];
    if (!pr || pr.state !== 'open') return error(405, 'Pull Request is not mergeable');
    if (pr.mergeable === false) return error(405, 'Pull Request has merge conflicts, resolve and retry');
    if (body.sha !== pr.head.sha) return error(409, 'Head branch was modified. Review and try the merge again.');
    const sha = `merge-${pr.number}-${pr.head.sha}`;
    Object.assign(pr, { state: 'closed', merged: true, merged_at: now(), merge_commit_sha: sha, updated_at: now() });
    store.refs['heads/dev'] = sha;
    store.merges.push({ pr: pr.number, sha: body.sha, merge_method: body.merge_method });
    return json({ merged: true, sha });
  }
  if ((m = /^\/commits\/([^/]+)\/pulls$/.exec(path)) && method === 'GET') {
    return json(Object.values(store.pulls).filter(pr => pr.merge_commit_sha === m[1]));
  }

  if ((m = /^\/git\/ref\/(.+)$/.exec(path)) && method === 'GET') {
    const ref = decodeURIComponent(m[1]);
    return store.refs[ref] ? json({ ref: `refs/${ref}`, object: { sha: store.refs[ref] } }) : error(404, 'Not Found');
  }
  if ((m = /^\/git\/matching-refs\/(.+)$/.exec(path)) && method === 'GET') {
    const prefix = decodeURIComponent(m[1]);
    const refs = Object.keys(store.refs).filter(ref => ref.startsWith(prefix)).sort()
      .map(ref => ({ ref: `refs/${ref}`, object: { sha: store.refs[ref] } }));
    return json(page(refs, searchParams));
  }
  if ((m = /^\/git\/refs\/(.+)$/.exec(path)) && method === 'DELETE') {
    const ref = decodeURIComponent(m[1]);
    if (!store.refs[ref]) return error(422, 'Reference does not exist');
    delete store.refs[ref];
    store.deletedRefs.push(ref);
    return empty(204);
  }

  if (path === '/actions/runs' && method === 'GET') {
    const status = searchParams.get('status');
    return json({ workflow_runs: page(store.runs.filter(run => !status || run.status === status), searchParams) });
  }
  if ((m = /^\/actions\/workflows\/([^/]+)\/runs$/.exec(path)) && method === 'GET') {
    const workflow = decodeURIComponent(m[1]);
    const runs = store.runs.filter(run => run.workflow === workflow)
      .filter(run => !searchParams.get('event') || run.event === searchParams.get('event'))
      .filter(run => !searchParams.get('head_sha') || run.head_sha === searchParams.get('head_sha'))
      .filter(run => !searchParams.get('branch') || run.head_branch === searchParams.get('branch'));
    return json({ workflow_runs: page(runs, searchParams) });
  }
  if ((m = /^\/actions\/runs\/(\d+)\/jobs$/.exec(path)) && method === 'GET') {
    const run = store.runs.find(item => item.id === Number(m[1]));
    return run ? json({ total_count: (run.jobs ?? []).length, jobs: run.jobs ?? [] }) : error(404, 'Not Found');
  }
  if ((m = /^\/actions\/runs\/(\d+)\/(rerun|rerun-failed-jobs)$/.exec(path)) && method === 'POST') {
    store.reruns.push({ run: Number(m[1]), action: m[2] });
    return empty(201);
  }
  if ((m = /^\/actions\/workflows\/([^/]+)\/dispatches$/.exec(path)) && method === 'POST') {
    store.dispatches.push({ workflow: decodeURIComponent(m[1]), ref: body.ref, inputs: body.inputs ?? null });
    return empty(204);
  }
  if ((m = /^\/actions\/variables\/([^/]+)$/.exec(path))) {
    const name = decodeURIComponent(m[1]);
    if (method === 'GET') return name in store.variables ? json({ name, value: store.variables[name] }) : error(404, 'Not Found');
    if (method === 'PATCH') {
      store.variables[name] = body.value;
      return empty(204);
    }
  }
  return null;
}

globalThis.fetch = async (input, options = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  if (url.origin !== 'https://api.github.com') throw new Error(`fake GitHub refuses non-GitHub request ${url.href}`);
  const method = (options.method ?? 'GET').toUpperCase();
  const body = options.body ? JSON.parse(options.body) : {};
  const store = load();
  const path = url.pathname.replace(`/repos/${store.repo}`, '');

  if (options.headers?.Authorization !== `Bearer ${process.env.GITHUB_TOKEN}`) {
    throw new Error('fake GitHub expected the synthetic test token on every request');
  }

  const interleave = takeRule(store.interleave, method, path);
  if (interleave) deepMerge(store, interleave.patch);

  const fault = takeRule(store.faults, method, path);
  if (fault) {
    store.requests.push({ method, path, fault: fault.kind ?? fault.status });
    save(store);
    if (fault.kind === 'network') throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED') });
    if (fault.kind === 'timeout') {
      return new Promise((_, reject) => {
        if (!options.signal) return; // a caller without a timeout would hang; that is itself the bug under test
        // A real stalled request holds an open socket; without this handle the
        // process would exit before the caller's (unref'd) timeout fires.
        const socket = setInterval(() => {}, 1000);
        const abort = () => { clearInterval(socket); reject(options.signal.reason); };
        if (options.signal.aborted) abort();
        else options.signal.addEventListener('abort', abort, { once: true });
      });
    }
    return error(fault.status, fault.body ?? `injected ${fault.status}`);
  }

  const response = route(store, method, url.pathname, url.searchParams, body);
  if (!response) {
    store.requests.push({ method, path, status: 'unrouted' });
    save(store);
    throw new Error(`fake GitHub has no route for ${method} ${url.pathname}${url.search}`);
  }
  store.requests.push({ method, path, status: response.status });
  save(store);
  return response;
};
