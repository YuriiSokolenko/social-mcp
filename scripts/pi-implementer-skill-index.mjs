// Compact Pi's Main-only skill descriptions without unregistering any discovered skill.
// Loaded exclusively by buildPiInvocation for the Implementer Main process.
const SKILLS_SECTION_RE = /<skills>[\s\S]*?<\/skills>/g;
const AVAILABLE_SKILLS_RE = /<available_skills>\s*([\s\S]*?)\s*<\/available_skills>/g;
const SKILL_ENTRY_RE = /\s*<skill>\s*<name>([\s\S]*?)<\/name>\s*<description>([\s\S]*?)<\/description>\s*<location>([\s\S]*?)<\/location>\s*<\/skill>\s*/g;
const DESCRIPTION_LIMIT = 144;

function decodeXml(value) {
  return value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function encodeXml(value) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function briefDescription(encoded) {
  const text = decodeXml(encoded).replace(/\s+/g, ' ').trim();
  if (text.length <= DESCRIPTION_LIMIT) return encodeXml(text);
  const prefix = text.slice(0, DESCRIPTION_LIMIT);
  const boundary = prefix.lastIndexOf(' ');
  const shortened = boundary >= DESCRIPTION_LIMIT * 0.65
    ? prefix.slice(0, boundary)
    : prefix;
  return encodeXml(`${shortened.trimEnd()}…`);
}

/**
 * Compact only a recognized Pi <skills> catalog. Preserve every name and the exact
 * read location so no task-specific skills become undiscoverable. If Pi changes
 * the markup, fail open (leave the complete original prompt untouched).
 */
export function compactImplementerSkillPrompt(systemPrompt) {
  if (typeof systemPrompt !== 'string') return systemPrompt;
  const sections = [...systemPrompt.matchAll(SKILLS_SECTION_RE)];
  if (sections.length !== 1) return systemPrompt;

  const oldSection = sections[0][0];
  const catalogs = [...oldSection.matchAll(AVAILABLE_SKILLS_RE)];
  if (catalogs.length !== 1) return systemPrompt;
  const entriesText = catalogs[0][1];
  const entries = [...entriesText.matchAll(SKILL_ENTRY_RE)];
  if (entries.length === 0 || entriesText.replace(SKILL_ENTRY_RE, '').trim()) return systemPrompt;
  if (entries.some(([, name, , location]) => !name.trim() || !location.trim())) return systemPrompt;

  const compactEntries = entries.map(([, name, description, location]) =>
    `<skill><name>${name.trim()}</name><description>${briefDescription(description)}</description><location>${location.trim()}</location></skill>`,
  ).join('\n');
  const compact = [
    '<skills>',
    'Available skills (all remain loaded). Match by name and summary; read the listed SKILL.md before applying a skill.',
    'Resolve relative references against the directory containing that skill file.',
    '<available_skills>',
    compactEntries,
    '</available_skills>',
    '</skills>',
  ].join('\n');
  // Avoid replacing a small or unusual catalog with a larger one.
  if (Buffer.byteLength(compact, 'utf8') >= Buffer.byteLength(oldSection, 'utf8')) return systemPrompt;
  return systemPrompt.slice(0, sections[0].index) + compact
    + systemPrompt.slice(sections[0].index + oldSection.length);
}

export default function implementerSkillIndex(pi) {
  pi.on('before_agent_start', event => {
    // The Bootstrap Planner has a separate Pi process. Coding child has its own
    // isolated extension allowlist and inheritSkills: false.
    if (process.env.PI_STAGE !== 'implementer' || process.env.PI_CODING_SESSION) return;
    const before = event.systemPrompt;
    const after = compactImplementerSkillPrompt(before);
    if (after === before) return;
    const names = [...after.matchAll(/<name>([^<]+)<\/name>/g)].map(match => match[1]);
    console.log(`PI_MAIN_SKILLS ${JSON.stringify({
      phase: 'catalog_compacted',
      originalBytes: Buffer.byteLength(before, 'utf8'),
      compactBytes: Buffer.byteLength(after, 'utf8'),
      savedBytes: Buffer.byteLength(before, 'utf8') - Buffer.byteLength(after, 'utf8'),
      skillCount: names.length,
      skillNames: names,
    })}`);
    return { systemPrompt: after };
  });
}
