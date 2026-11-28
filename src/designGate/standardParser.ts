/** Lossless structural input to the design gate; this parser does not judge rule wording. */
export const DESIGN_SURFACES = ['iPhone', 'Mac', 'Android', 'Windows', 'Linux', 'Web'] as const;
export type DesignSurface = typeof DESIGN_SURFACES[number];
export interface DesignRule {
  id: string;
  title: string;
  line: number;
  rule: string;
  why: string;
  bad: string;
  good: string;
  /** All expands to the full surface domain. Original conditional text is retained. */
  surfaces: DesignSurface[];
  surfaceText: string;
  check: string;
  checkKind: 'machine' | 'review' | null;
  source: string;
  earnedFrom: string[];
  /** Full at-a-glance text, including tolerances; compared separately from Check. */
  measurement: string | null;
}
export interface StandardParseError { code: string; line: number; ruleId?: string; field?: string; detail: string }
export interface ParsedDesignStandard { rules: DesignRule[]; errors: StandardParseError[] }
const ID = 'DS-[A-Z][A-Z0-9]*-\\d+';
const heading = new RegExp(`^### (${ID})\\s*[·:]\\s*(.+)$`);
const fieldPattern = /\*\*(Rule|Why|Bad|Good|Surfaces|Check|Source|Earned from)\*\*:\s*/g;

export function parseDesignStandard(markdown: string): ParsedDesignStandard {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const errors: StandardParseError[] = [];
  const rules: DesignRule[] = [];
  const index = new Map<string, { text: string; line: number }>();
  let inIndex = false;
  for (const [offset, text] of lines.entries()) {
    if (/^## /.test(text)) inIndex = text.trim() === '## Machine-checkable rules at a glance';
    if (!inIndex) continue;
    // Linear: match the cells once and trim afterwards. Overlapping whitespace
    // groups made the old single pattern cubic on a long malformed row.
    const cells = /^\|(.*)\|$/.exec(text);
    if (!cells) continue;
    const bar = cells[1].indexOf('|');
    if (bar < 0) continue;
    const idCell = cells[1].slice(0, bar).trim().replace(/^\u0060|\u0060$/g, '');
    const idMatch = new RegExp(`^(${ID})$`).exec(idCell);
    if (!idMatch) continue;
    const row = [text, idMatch[1], cells[1].slice(bar + 1).trim()];
    if (index.has(row[1])) errors.push({ code: 'duplicate-machine-index', line: offset + 1, ruleId: row[1], detail: 'A machine rule is indexed more than once.' });
    else index.set(row[1], { text: row[2], line: offset + 1 });
  }
  const seen = new Set<string>();
  for (let offset = 0; offset < lines.length; offset++) {
    if (!/^### DS-/.test(lines[offset])) continue;
    const match = lines[offset].match(heading);
    if (!match) { errors.push({ code: 'invalid-rule-heading', line: offset + 1, detail: 'A rule heading needs a permanent identifier and title.' }); continue; }
    const [, id, title] = match;
    const line = offset + 1;
    const error = (code: string, detail: string, field?: string) => errors.push({ code, line, ruleId: id, field, detail });
    if (seen.has(id)) error('duplicate-rule', 'Rule identifiers must be unique.');
    seen.add(id);
    let end = offset + 1;
    while (end < lines.length && !/^#{1,3} /.test(lines[end]) && !/^---\s*$/.test(lines[end])) end++;
    const body = lines.slice(offset + 1, end).join('\n');
    const fields = new Map<string, string>();
    const matches = [...body.matchAll(fieldPattern)];
    for (let i = 0; i < matches.length; i++) {
      const entry = matches[i];
      const value = body.slice(entry.index! + entry[0].length, matches[i + 1]?.index ?? body.length).replace(/\n\s*-\s*$/, '').trim();
      if (fields.has(entry[1])) error('duplicate-field', 'A rule field appears more than once.', entry[1]);
      else fields.set(entry[1], value);
    }
    for (const field of ['Rule', 'Why', 'Bad', 'Good', 'Surfaces', 'Check']) {
      if (!fields.get(field)) error('missing-field', 'A required rule field is empty or missing.', field);
    }
    const surfaceText = fields.get('Surfaces') ?? '';
    let surfaces: DesignSurface[] = [];
    // The approved baseline uses "All surfaces that offer both modes." once.
    // Preserve that condition verbatim; do not turn arbitrary unknown values into All.
    if (/^All(?:\.| surfaces that offer both modes\.)?$/.test(surfaceText)) surfaces = [...DESIGN_SURFACES];
    else {
      const values = surfaceText.replace(/\.$/, '').split(',').map(s => s.trim());
      if (values.some(s => !DESIGN_SURFACES.includes(s as DesignSurface)) || new Set(values).size !== values.length) error('invalid-surfaces', 'Use All or a unique list of canonical surfaces.', 'Surfaces');
      else surfaces = values as DesignSurface[];
    }
    const check = fields.get('Check') ?? '';
    const checkKind = check.match(/^(machine|review)(?:[.,;\s]|$)/)?.[1];
    if (!checkKind) error('invalid-check', 'A check must declare machine or review.', 'Check');
    const earnedText = fields.get('Earned from') ?? '';
    const earnedFrom = [...new Set(earnedText.match(/\bDF-\d{4}\b/g) ?? [])];
    const source = fields.get('Source') ?? '';
    if (!source && !earnedFrom.length) error('missing-provenance', 'A rule needs its source or earned feedback entry.');
    const declaredReferences = earnedText.match(/\bDF-[A-Za-z0-9_]*/gi) ?? [];
    if (earnedText && (!earnedFrom.length || declaredReferences.some(ref => !/^DF-\d{4}$/.test(ref)))) error('invalid-earned-reference', 'Earned references must identify feedback entries.', 'Earned from');
    const measurement = index.get(id)?.text ?? null;
    if (checkKind === 'machine' && !measurement) error('machine-index-missing', 'Every machine rule needs its measurement in the index.');
    if (checkKind === 'review' && measurement !== null) error('machine-index-extra', 'A review rule cannot be indexed as a machine check.');
    rules.push({ id, title, line, rule: fields.get('Rule') ?? '', why: fields.get('Why') ?? '', bad: fields.get('Bad') ?? '', good: fields.get('Good') ?? '', surfaces, surfaceText, check, checkKind: checkKind === 'machine' ? 'machine' : checkKind === 'review' ? 'review' : null, source, earnedFrom, measurement });
    offset = end - 1;
  }
  for (const [id, entry] of index) if (!seen.has(id)) errors.push({ code: 'machine-index-orphan', line: entry.line, ruleId: id, detail: 'The indexed machine rule has no rule definition.' });
  if (!rules.length) errors.push({ code: 'empty-standard', line: 1, detail: 'No design rules were found.' });
  return { rules, errors };
}
