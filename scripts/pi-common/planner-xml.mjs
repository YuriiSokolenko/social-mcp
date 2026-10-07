const ROOT_ATTRIBUTES = new Set(['complexity', 'large_mutation']);
const ROOT_SECTIONS = new Set(['steps', 'facts', 'warnings', 'required_mutation_anchors', 'reason']);

function fail(message) {
  throw new Error(`Planner XML: ${message}`);
}

function validXmlCodePoint(codePoint) {
  return codePoint === 0x9 || codePoint === 0xA || codePoint === 0xD
    || (codePoint >= 0x20 && codePoint <= 0xD7FF)
    || (codePoint >= 0xE000 && codePoint <= 0xFFFD)
    || (codePoint >= 0x10000 && codePoint <= 0x10FFFF);
}

function decodeXmlText(value) {
  const source = String(value);
  if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9A-Fa-f]+);)/.test(source)) {
    fail('unescaped or unsupported XML entity');
  }
  if (source.includes(']]>')) fail('forbidden CDATA terminator in text');
  return source.replace(/&([^;]+);/g, (_match, entity) => {
    switch (entity) {
      case 'amp': return '&';
      case 'lt': return '<';
      case 'gt': return '>';
      case 'quot': return '"';
      case 'apos': return "'";
      default: {
        if (!entity.startsWith('#')) fail(`unsupported XML entity &${entity};`);
        const hex = entity[1]?.toLowerCase() === 'x';
        const digits = entity.slice(hex ? 2 : 1);
        const codePoint = Number.parseInt(digits, hex ? 16 : 10);
        if (!Number.isSafeInteger(codePoint) || !validXmlCodePoint(codePoint)) {
          fail(`invalid numeric XML entity &${entity};`);
        }
        return String.fromCodePoint(codePoint);
      }
    }
  });
}

function normalizedXmlEnvelope(input) {
  let xml = String(input ?? '').replace(/^\uFEFF/, '').trim();
  const fence = xml.match(/^```(?:xml)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i);
  if (fence) xml = fence[1].trim();
  return xml;
}

function parseAttributes(source) {
  const attributes = {};
  const matcher = /([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(["'])(.*?)\2/g;
  let cursor = 0;
  for (let match = matcher.exec(source); match; match = matcher.exec(source)) {
    if (source.slice(cursor, match.index).trim()) fail('malformed plan attributes');
    const [, name, , rawValue] = match;
    if (!ROOT_ATTRIBUTES.has(name)) fail(`unknown plan attribute ${name}`);
    if (Object.hasOwn(attributes, name)) fail(`duplicate plan attribute ${name}`);
    attributes[name] = decodeXmlText(rawValue);
    cursor = matcher.lastIndex;
  }
  if (source.slice(cursor).trim()) fail('malformed plan attributes');
  for (const required of ROOT_ATTRIBUTES) {
    if (!Object.hasOwn(attributes, required)) fail(`missing plan attribute ${required}`);
  }
  if (!['trivial', 'nontrivial'].includes(attributes.complexity)) {
    fail(`invalid complexity ${attributes.complexity}`);
  }
  if (!['true', 'false'].includes(attributes.large_mutation)) {
    fail(`invalid large_mutation ${attributes.large_mutation}`);
  }
  return {
    complexity: attributes.complexity,
    large_mutation: attributes.large_mutation === 'true',
  };
}

function splitTopLevelSections(body) {
  const sections = new Map();
  let cursor = 0;
  while (cursor < body.length) {
    const leading = body.slice(cursor).match(/^\s*/)?.[0] ?? '';
    cursor += leading.length;
    if (cursor >= body.length) break;

    const open = body.slice(cursor).match(/^<([A-Za-z_][A-Za-z0-9_.-]*)\s*(\/?)>/);
    if (!open) fail('malformed or nested top-level XML');
    const name = open[1];
    const selfClosing = open[2] === '/';
    if (!ROOT_SECTIONS.has(name)) fail(`unknown plan element <${name}>`);
    if (sections.has(name)) fail(`duplicate plan element <${name}>`);
    const contentStart = cursor + open[0].length;
    if (selfClosing) {
      sections.set(name, '');
      cursor = contentStart;
      continue;
    }
    const closeTag = `</${name}>`;
    const closeIndex = body.indexOf(closeTag, contentStart);
    if (closeIndex < 0) fail(`unclosed plan element <${name}>`);
    sections.set(name, body.slice(contentStart, closeIndex));
    cursor = closeIndex + closeTag.length;
  }
  return sections;
}

function repeatedSectionName(itemName) {
  if (itemName === 'step') return 'steps';
  if (itemName === 'fact') return 'facts';
  if (itemName === 'warning') return 'warnings';
  return 'required_mutation_anchors';
}

function parseRepeatedText(section, itemName, { required = false } = {}) {
  const sectionName = repeatedSectionName(itemName);
  if (section == null) {
    if (required) fail(`missing <${sectionName}>`);
    return [];
  }
  const values = [];
  let cursor = 0;
  const openTag = `<${itemName}>`;
  const closeTag = `</${itemName}>`;
  while (cursor < section.length) {
    const leading = section.slice(cursor).match(/^\s*/)?.[0] ?? '';
    cursor += leading.length;
    if (cursor >= section.length) break;
    if (!section.startsWith(openTag, cursor)) fail(`unexpected markup inside <${sectionName}>`);
    const contentStart = cursor + openTag.length;
    const closeIndex = section.indexOf(closeTag, contentStart);
    if (closeIndex < 0) fail(`unclosed <${itemName}>`);
    const raw = section.slice(contentStart, closeIndex);
    if (raw.includes('<') || /<\/?[A-Za-z_][^>]*>/.test(raw)) fail(`nested or unescaped markup is not allowed inside <${itemName}>`);
    const decoded = decodeXmlText(raw).trim();
    if (!decoded) fail(`empty <${itemName}> is not allowed`);
    values.push(decoded);
    cursor = closeIndex + closeTag.length;
  }
  if (required && values.length === 0) fail(`at least one <${itemName}> is required`);
  return values;
}

function parseReason(section) {
  if (section == null) fail('missing <reason>');
  if (section.includes('<') || /<\/?[A-Za-z_][^>]*>/.test(section)) fail('nested or unescaped markup is not allowed inside <reason>');
  const reason = decodeXmlText(section).trim();
  if (!reason) fail('empty <reason> is not allowed');
  return reason;
}

export function parsePlannerXml(input) {
  const xml = normalizedXmlEnvelope(input);
  if (!xml) fail('empty assistant content');
  if (/<!DOCTYPE|<!ENTITY|<\?|<!\[CDATA\[/i.test(xml)) fail('DTD, entities, processing instructions, and CDATA are not allowed');

  const root = xml.match(/^<plan\b([^>]*)>([\s\S]*)<\/plan>$/);
  if (!root) fail('expected exactly one <plan> root document');
  const attributes = parseAttributes(root[1]);
  const sections = splitTopLevelSections(root[2]);

  if (!sections.has('steps')) fail('missing <steps>');
  if (!sections.has('reason')) fail('missing <reason>');

  return {
    steps: parseRepeatedText(sections.get('steps'), 'step', { required: true }),
    facts: parseRepeatedText(sections.get('facts'), 'fact'),
    warnings: parseRepeatedText(sections.get('warnings'), 'warning'),
    complexity: attributes.complexity,
    required_mutation_anchors: parseRepeatedText(sections.get('required_mutation_anchors'), 'anchor'),
    large_mutation: attributes.large_mutation,
    reason: parseReason(sections.get('reason')),
  };
}

