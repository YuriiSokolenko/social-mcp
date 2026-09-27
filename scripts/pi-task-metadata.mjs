export function taskMetadata(issue, { required = true } = {}) {
  const body = issue?.body ?? "";
  const header = body.match(/^## Task metadata\s*\r?\n([\s\S]*?)(?=\r?\n##\s|$)/);
  if (!header) {
    if (!required) return { valid: false, errors: ["missing Task metadata section"], priority: null, dependencies: [] };
    throw new Error("missing Task metadata section");
  }
  const priority = /^Priority:\s*(P[012])\s*$/mi.exec(header[1])?.[1]?.toUpperCase();
  const raw = /^Depends on:\s*\[([^\]]*)\]\s*$/mi.exec(header[1])?.[1];
  const errors = [];
  if (!priority) errors.push("Task metadata Priority must be P0, P1, or P2");
  const validDependencies = raw !== undefined && (!raw.trim() || /^#?\d+(?:\s*,\s*#?\d+)*$/.test(raw.trim()));
  if (!validDependencies) errors.push("Task metadata Depends on must be an inline issue list, for example [#12, #18] or []");
  const dependencies = validDependencies && raw.trim()
    ? raw.split(",").map(value => Number(value.trim().replace(/^#/, "")))
    : [];
  if (dependencies.includes(issue?.number)) errors.push("task depends on itself");
  if (errors.length && required) throw new Error(errors.join("; "));
  return { valid: errors.length === 0, errors, priority: priority ?? null, dependencies };
}

export function withTaskMetadata(body, priority, dependencies) {
  const block = `## Task metadata\nPriority: ${priority}\nDepends on: [${dependencies.map(number => `#${number}`).join(", ")}]\n\n`;
  const source = body ?? "";
  if (/^## Task metadata/m.test(source)) {
    return source.replace(/^## Task metadata\s*\r?\n[\s\S]*?(?=^##\s|(?![\s\S]))/m, block);
  }
  return block + source;
}
