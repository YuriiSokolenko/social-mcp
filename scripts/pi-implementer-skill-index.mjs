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
  // An incomplete entry can make the regex consume the next skill's location.
  // Reject the entire catalog unless each opening <skill> has its own parsed entry.
  const openingSkillCount = (entriesText.match(/<skill>/g) ?? []).length;
  if (entries.length === 0 || entries.length !== openingSkillCount || entriesText.replace(SKILL_ENTRY_RE, '').trim()) return systemPrompt;
  if (entries.some(([, name, , location]) => !name.trim() || !location.trim())) return systemPrompt;

  const compactEntries = entries.map(([, name, description, location]) =>
    `<skill><name>${name.trim()}</name><description>${briefDescription(description)}</description><location>${location.trim()}</location></skill>`,
  ).join('\n');
  const compact = [
    '<skills>',
    'Available skills (all remain available). Match by name and summary; read the listed SKILL.md before applying a skill.',
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

// Main retains full Pi skill discovery. Only the advertised system-prompt catalog
// is curated; its non-featured entries stay in a lossless name/location index.
// This is a relevance hint, NEVER an authorization boundary or a tool grant.
const NON_DISTINCTIVE_SKILL_WORDS = new Set([
  'skill', 'skills', 'general', 'common', 'guide', 'guidance', 'patterns',
  'practice', 'practices', 'best', 'modern', 'agent', 'agents', 'tools',
  'development', 'implementation', 'code', 'coding', 'project', 'repository',
  'testing', 'test', 'workflow', 'workflows', 'use', 'using',
  // These recur as incidental acceptance/review notes in large Main prompts.
  'review', 'feedback', 'checklist', 'database', 'api', 'design',
]);
const SHORT_SKILL_ALIASES = new Set(['py', 'js', 'ts', 'ci']);
const TOPIC_SIGNALS = [
  { match: /(?:\.py\b|\.pyi\b|\bpython\b|\bpytest\b|\bruff\b|\bpy\b)/i, names: ['python', 'pytest', 'py'] },
  { match: /(?:\.(?:js|jsx|ts|tsx|mjs|cjs)\b|\bjavascript\b|\btypescript\b|\bnode\.?js\b|\bvitest\b|\bjs\b|\bts\b)/i,
    names: ['javascript', 'typescript', 'node', 'js', 'ts'] },
  { match: /(?:\bDockerfile\b|docker[\s-]?compose|compose\.ya?ml|\bdocker\b|\bcontainer(?:s)?\b)/i,
    names: ['docker', 'container', 'compose'] },
  { match: /(?:\.github\/workflows\/|\bgithub actions\b|\bCI\/CD\b|\bCI\b|\bworkflow_dispatch\b)/i,
    names: ['github', 'actions', 'ci', 'workflow'] },
  { match: /(?:\bOAuth\b|\bauthentication\b|\bauthorization\b|\bsecurity\b|\bthreat\b)/i,
    names: ['security', 'auth', 'oauth'] },
  { match: /(?:\barchitecture\b|\bmodule boundaries\b|\bdesign pattern\b)/i,
    names: ['architecture', 'design'] },
  { match: /(?:\bSQL\b|\bSQLite\b|\bPostgres(?:ql)?\b|\bRoom\b|\bmigrations?\b|\bDAO\b)/i,
    names: ['database', 'sql', 'sqlite', 'room', 'migration'] },
];

function relevantSkillNames(entries, taskText, limit = 5) {
  const text = typeof taskText === 'string' ? taskText.slice(0, 12000) : '';
  const terms = new Set((text.toLowerCase().match(/[a-z][a-z0-9]{1,}/g) ?? [])
    .filter(word => !NON_DISTINCTIVE_SKILL_WORDS.has(word)
      && (word.length > 2 || SHORT_SKILL_ALIASES.has(word))));
  const signals = TOPIC_SIGNALS.filter(topic => topic.match.test(text));
  const matches = entries.map(name => {
    const label = decodeXml(name).trim().toLowerCase();
    const words = label.split(/[^a-z0-9]+/)
      .filter(word => !NON_DISTINCTIVE_SKILL_WORDS.has(word)
        && (word.length > 2 || SHORT_SKILL_ALIASES.has(word)));
    const explicitName = Boolean(label) && terms.has(label)
      || Boolean(label) && text.toLowerCase().split(/[^a-z0-9-]+/).includes(label);
    const matchedWords = words.filter(word => terms.has(word)).length;
    // A lone incidental word never consumes a featured slot. Explicit skill
    // names, multiple distinct domain words and concrete topic signals do.
    const score = (explicitName ? 10 : 0) + (matchedWords >= 2 ? matchedWords * 3 : 0)
      + signals.reduce((total, signal) =>
        total + (words.some(word => signal.names.includes(word)) ? 9 : 0), 0);
    return { name, score };
  }).filter(item => item.score > 0);
  matches.sort((a, b) => b.score - a.score);
  return new Set(matches.slice(0, Math.max(0, Math.min(5, limit))).map(item => item.name));
}

/**
 * Keep up to five task-relevant full skill summaries and move the remainder to
 * an exact-path directory. Pi continues to register ALL skills. A model may
 * inspect any indexed SKILL.md when an actual serialized tool permits it.
 * When markup is unfamiliar or incomplete, retain the original Pi prompt.
 */
export function curateImplementerSkillPrompt(systemPrompt, { taskText = '', maxFeatured = 5 } = {}) {
  if (typeof systemPrompt !== 'string') return systemPrompt;
  // Never re-curate an already curated prompt: its omitted entries live in
  // the discovery index, not in <available_skills> (phase transitions are safe).
  if (systemPrompt.includes('<skill_discovery_index>')) return systemPrompt;
  const sections = [...systemPrompt.matchAll(SKILLS_SECTION_RE)];
  if (sections.length !== 1) return systemPrompt;
  const oldSection = sections[0][0];
  const catalogs = [...oldSection.matchAll(AVAILABLE_SKILLS_RE)];
  if (catalogs.length !== 1) return systemPrompt;
  const entriesText = catalogs[0][1];
  const entries = [...entriesText.matchAll(SKILL_ENTRY_RE)];
  const openingCount = (entriesText.match(/<skill>/g) ?? []).length;
  if (!entries.length || entries.length !== openingCount ||
      entriesText.replace(SKILL_ENTRY_RE, '').trim()) return systemPrompt;
  if (entries.some(([, name, , location]) =>
    !name.trim() || !location.trim() || /[\r\n\t]/.test(name.trim()) ||
    /[\r\n\t]/.test(location.trim()))) return systemPrompt;
  // Duplicate names would make the directory ambiguous: fail open.
  const allNames = entries.map(([, name]) => name.trim());
  if (new Set(allNames).size !== allNames.length) return systemPrompt;

  // Rank existing advertised skill names only, retaining discovery order on ties.
  const featuredNames = relevantSkillNames(entries.map(([, name]) => name), taskText, maxFeatured);
  const featured = [];
  const indexed = [];
  for (const [, name, description, location] of entries) {
    if (featuredNames.has(name)) {
      featured.push('<skill><name>' + name.trim() + '</name><description>'
        + briefDescription(description) + '</description><location>'
        + location.trim() + '</location></skill>');
    } else {
      // XML-encoded names/locations are preserved byte-for-byte, not guessed
      // from a directory pattern. No tool is invoked just to rediscover them.
      indexed.push(name.trim() + '\t' + location.trim());
    }
  }
  const replacement = [
    '<skills>',
    'Featured task-relevant instructions are listed below. Skills are not tools or permissions.',
    'All remaining discovered skills are indexed with exact SKILL.md paths. Inspect a file only through a tool actually present in this request; this listing does not grant one.',
    '<available_skills>',
    ...featured,
    '</available_skills>',
    '<skill_discovery_index>',
    'Other skills (name TAB exact SKILL.md path):',
    ...indexed,
    '</skill_discovery_index>',
    '</skills>',
  ].join('\n');
  // A failed optimization must not inflate the system prompt.
  if (Buffer.byteLength(replacement, 'utf8') >= Buffer.byteLength(oldSection, 'utf8')) {
    return compactImplementerSkillPrompt(systemPrompt);
  }
  return systemPrompt.slice(0, sections[0].index) + replacement
    + systemPrompt.slice(sections[0].index + oldSection.length);
}

export default function implementerSkillIndex(pi) {
  // Pi may rebuild its full system catalog on each before_agent_start. Freeze
  // the first Main task prompt instead of re-ranking against later phase text
  // (e.g. submit_result). This is selection state, not a tool grant.
  let initialTaskText = null;
  pi.on('before_agent_start', event => {
    // The Bootstrap Planner has a separate Pi process. Coding child has its own
    // isolated extension allowlist and inheritSkills: false.
    if (process.env.PI_STAGE !== 'implementer' || process.env.PI_CODING_SESSION) return;
    if (initialTaskText === null && typeof event.prompt === 'string' && event.prompt.trim()) {
      initialTaskText = event.prompt;
    }
    const before = event.systemPrompt;
    const after = curateImplementerSkillPrompt(before, { taskText: initialTaskText ?? '' });
    if (after === before) return;
    const featuredCatalog = after.match(/<available_skills>([\s\S]*?)<\/available_skills>/)?.[1] ?? '';
    const names = [...featuredCatalog.matchAll(/<name>([^<]+)<\/name>/g)].map(match => match[1]);
    const index = after.match(/<skill_discovery_index>([\s\S]*?)<\/skill_discovery_index>/)?.[1] ?? '';
    const discoverable = index.split('\n').filter(line => line.includes('\t')).length;
    console.log(`PI_MAIN_SKILLS ${JSON.stringify({
      phase: 'catalog_compacted',
      originalBytes: Buffer.byteLength(before, 'utf8'),
      compactBytes: Buffer.byteLength(after, 'utf8'),
      savedBytes: Buffer.byteLength(before, 'utf8') - Buffer.byteLength(after, 'utf8'),
      skillCount: names.length,
      indexedSkillCount: discoverable,
      totalDiscoverableSkills: names.length + discoverable,
      skillNames: names,
    })}`);
    return { systemPrompt: after };
  });
}
