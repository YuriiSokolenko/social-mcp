// Pure classification only. The runtime owns repair state, file checks, policy
// enforcement, mutation authorization and recovery decisions.
const CODING_REPAIR_BROAD_EDIT_LINE_LIMIT = 80;
const CODING_REPAIR_BROAD_EDIT_CHAR_LIMIT = 12000;

export function normalizeCodingRepairDiagnosticText(value) {
  return String(value ?? '')
    .trim()
    // Diagnostic text often embeds ephemeral paths, addresses and measured values.
    // Keep semantic numbers such as "expected 42" while removing volatile measurements.
    .replace(/\b0x[0-9a-f]+\b/gi, '<hex>')
    .replace(/\b[0-9a-f]{12,}\b/gi, '<hex>')
    .replace(/[A-Za-z]:\\(?:[^\\\s"'():]+\\)+[^\\\s"'():]*/g, '<path>')
    .replace(/(^|[\s"'(])\/(?:[^/\s"'():]+\/)+[^/\s"'():]*/g, '$1<path>')
    .replace(/(^|[^\w])[-+]?\d+(?:\.\d+)?(?:e[-+]?\d+)?(?:ns|us|µs|ms|s|bytes?|kb|mb|gb)(?=$|[^\w])/gi, '$1<number>')
    .replace(/\s+/g, ' ');
}

export function strictFailureSetReduction(current, best) {
  if (!Array.isArray(best) || current.length >= best.length) return false;
  const bestSet = new Set(best);
  return current.every(item => bestSet.has(item));
}

export function mutationTextExtent(value, key = '') {
  if (typeof value === 'string') {
    if (!/(?:text|content|rewrite|replacement|old|new|insert|value|pattern)/i.test(key)) {
      return { chars: 0, lines: 0 };
    }
    return { chars: value.length, lines: value.split('\n').length };
  }
  if (Array.isArray(value)) {
    return value.reduce((extent, item) => {
      const nested = mutationTextExtent(item, key);
      return { chars: Math.max(extent.chars, nested.chars), lines: Math.max(extent.lines, nested.lines) };
    }, { chars: 0, lines: 0 });
  }
  if (value && typeof value === 'object') {
    return Object.entries(value).reduce((extent, [nestedKey, nestedValue]) => {
      const nested = mutationTextExtent(nestedValue, nestedKey);
      return { chars: Math.max(extent.chars, nested.chars), lines: Math.max(extent.lines, nested.lines) };
    }, { chars: 0, lines: 0 });
  }
  return { chars: 0, lines: 0 };
}

export function codingMutationShape(toolName, input, snapshot) {
  if (toolName === 'write') return snapshot?.existed ? 'whole_file_rewrite' : 'creation';
  if (!['edit', 'safe_edit', 'structural_edit'].includes(toolName)) return 'other';
  const extent = mutationTextExtent(input);
  const safeEditSpan = toolName === 'safe_edit'
    ? Math.max(1, Number(input?.end_line ?? input?.start_line ?? 1) - Number(input?.start_line ?? 1) + 1)
    : 0;
  return (
    extent.chars > CODING_REPAIR_BROAD_EDIT_CHAR_LIMIT ||
    extent.lines > CODING_REPAIR_BROAD_EDIT_LINE_LIMIT ||
    safeEditSpan > CODING_REPAIR_BROAD_EDIT_LINE_LIMIT
  ) ? 'broad_edit' : 'targeted_edit';
}
