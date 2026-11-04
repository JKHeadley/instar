/**
 * Pure WARN-stage structural detector for `## Maturation plan`.
 * Semantic adequacy belongs to spec-converge's lessons-aware reviewer.
 */

const REQUIRED_FIELDS = [
  'test-agent-live',
  'dev-agent-live',
  'fleet',
  'graduation criterion',
  'dark-window',
];

function reviewableMarkdown(input) {
  let body = String(input).replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
  body = body.replace(/<!--[^]*?-->/g, '');
  const lines = body.split(/\r?\n/);
  let fence = null;
  return lines.map((line) => {
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (marker) {
      const token = marker[1][0];
      if (fence === null) fence = token;
      else if (fence === token) fence = null;
      return '';
    }
    if (fence !== null || /^\s*>/.test(line)) return '';
    return line;
  }).join('\n');
}

/**
 * `requireLadder` is set only in the instar source tree. Agents' own projects
 * have no instar registry, so the line means nothing there. The gate checks the
 * line is present and well-formed; the coverage test checks, at merge, that it
 * names a real entry, so a spec can converge before its entry exists.
 */
export function findMaturationPlanGaps(specBody, { requireLadder = false } = {}) {
  const body = reviewableMarkdown(specBody);
  const headings = [...body.matchAll(/^##[ \t]+Maturation plan[ \t]*$/gim)];
  if (headings.length === 0) return { ok: false, reason: 'missing-section' };
  if (headings.length > 1) return { ok: false, reason: 'duplicate-section' };

  const start = headings[0].index + headings[0][0].length;
  const rest = body.slice(start);
  const nextH2 = rest.search(/^##[ \t]+/m);
  const section = nextH2 === -1 ? rest : rest.slice(0, nextH2);
  const found = new Map();
  for (const line of section.split('\n')) {
    const match = line.match(/^\s*[-*+]\s+\*\*([^*]+):\*\*\s+(.+?)\s*$/);
    if (!match) continue;
    const label = match[1].trim().toLowerCase();
    if (!REQUIRED_FIELDS.includes(label)) continue;
    found.set(label, [...(found.get(label) ?? []), match[2].trim()]);
  }
  const missing = REQUIRED_FIELDS.filter((field) => !found.has(field));
  const duplicates = REQUIRED_FIELDS.filter((field) => (found.get(field)?.length ?? 0) > 1);
  if (missing.length || duplicates.length) {
    return { ok: false, reason: 'invalid-fields', missing, duplicates };
  }
  if (requireLadder) {
    const ladderLines = section.split('\n')
      .map((line) => line.match(/^\s*[-*+]\s+\*\*ladder:\*\*\s+(.+?)\s*$/i))
      .filter(Boolean);
    if (ladderLines.length !== 1 || !/^[A-Za-z0-9._:+\-/ (),~]{1,160}$/.test(ladderLines[0][1])) {
      return { ok: false, reason: 'invalid-fields', missing: ladderLines.length ? [] : ['ladder'], duplicates: ladderLines.length > 1 ? ['ladder'] : [] };
    }
  }
  return { ok: true };
}

export { REQUIRED_FIELDS };
