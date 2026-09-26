function parentOf(body) {
  const match = /<!-- architect-parent:(\\d+); architect-key:[a-z][a-z0-9-]* -->/.exec(body ?? '');
  return match ? Number(match[1]) : null;
}
function childNumbers(body) {
  const match = /<!-- architect-children:([1-9]\\d*(?:,[1-9]\\d*)*) -->/.exec(body ?? '');
  return match ? match[1].split(',').map(Number) : [];
}

export function ancestorChain(issueNumber, issuesByNumber, maxDepth = 4) {
  const chain = [];
  const seen = new Set([issueNumber]);
  let current = issuesByNumber.get(issueNumber);
  while (current) {
    const parent = parentOf(current.body);
    if (!parent) return chain;
    if (seen.has(parent)) throw new Error(`Architect ancestry cycle at #${parent}`);
    chain.push(parent);
    if (chain.length > maxDepth) throw new Error(`Architect tree exceeds maximum depth ${maxDepth}`);
    seen.add(parent);
    current = issuesByNumber.get(parent);
    if (!current) throw new Error(`Architect parent #${parent} does not exist`);
  }
  return chain;
}

function assertDependencyGraph(nodes) {
  const visiting = new Set();
  const visited = new Set();
  const visit = number => {
    if (visiting.has(number)) throw new Error(`Dependency cycle includes #${number}`);
    if (visited.has(number)) return;
    visiting.add(number);
    for (const dependency of nodes.get(number) ?? []) if (nodes.has(dependency)) visit(dependency);
    visiting.delete(number);
    visited.add(number);
  };
  for (const number of nodes.keys()) visit(number);
}

export function validateArchitectPlanAgainstBacklog(plan, parent, issues, taskReader, { maxDepth = 4 } = {}) {
  const byNumber = new Map(issues.map(issue => [issue.number, issue]));
  const source = byNumber.get(parent);
  if (!source) throw new Error(`Parent issue #${parent} does not exist`);
  const ancestors = ancestorChain(parent, byNumber, maxDepth);
  const forbidden = new Set([parent, ...ancestors]);

  if (plan.action === 'keep') return plan;
  if (plan.action === 'revise') {
    for (const dependency of plan.depends_on) {
      if (!byNumber.has(dependency)) throw new Error(`Dependency #${dependency} does not exist`);
      if (forbidden.has(dependency)) throw new Error(`Issue #${parent} cannot depend on itself or ancestor #${dependency}`);
    }
    return plan;
  }

  if (childNumbers(source.body).length) throw new Error(`Issue #${parent} is already split`);
  if (ancestors.length >= maxDepth) throw new Error(`Splitting #${parent} would exceed maximum Architect depth ${maxDepth}`);

  const inherited = taskReader(parent).dependencies;
  for (const dependency of inherited) {
    if (!byNumber.has(dependency)) throw new Error(`Inherited dependency #${dependency} does not exist`);
    if (forbidden.has(dependency)) throw new Error(`Issue #${parent} inherits ancestor/self dependency #${dependency}`);
  }

  // Existing repository task graph must already be acyclic before Architect adds children.
  const graph = new Map();
  for (const issue of issues) {
    try { graph.set(issue.number, taskReader(issue.number).dependencies); }
    catch { /* issues without task metadata are outside the executable graph */ }
  }
  assertDependencyGraph(graph);
  return plan;
}
