/**
 * skillCanonicalFrontmatter — make a SKILL.md safe to be CANONICAL.
 *
 * The parity rule (src/providers/parity/rules/skillParityRule.ts) reads the
 * canonical `.instar/skills/<name>/SKILL.md` with js-yaml's FAILSAFE schema and
 * fails loud on a parse error. Many hand-written and built-in skills carry an
 * UNQUOTED plain-scalar `description:` that contains `: ` (e.g. "Trigger words:
 * audit, sweep") — Claude Code's lenient frontmatter reader accepts it, YAML
 * does not. A verbatim copy of such a file into canonical would make every
 * later canonical read a `canonical-read-error`.
 *
 * `normalizeSkillFrontmatter(raw)`:
 *   - parses the frontmatter with the SAME schema the parity rule uses; a file
 *     that already parses is returned byte-identical (content unchanged);
 *   - otherwise re-serialises the frontmatter line by line: every `key: value`
 *     scalar (top-level and nested, `name` / `description` / `metadata.*` / any
 *     other) becomes a properly double-quoted scalar with the SAME content,
 *     key order preserved; non-scalar values (flow lists, block starts), comments
 *     and blank lines are kept verbatim; indented continuation lines of a plain
 *     scalar are folded into it (YAML plain-scalar semantics);
 *   - the BODY is never touched, so the body hash (the `x-instar-stamp`) is the
 *     same before and after;
 *   - returns null when the result still does not parse — the caller must then
 *     NOT write canonical for that skill.
 */

import yaml from 'js-yaml';

/** Mirrors skillParityRule.parseFrontmatter's grammar. */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
const KEY_LINE_RE = /^(\s*)([A-Za-z][\w-]*):(?:\s+(.*))?$/;

export interface NormalizedSkillFrontmatter {
  /** The full SKILL.md text to write as canonical. */
  text: string;
  /** false ⇒ byte-identical to the input (it already parsed). */
  changed: boolean;
}

function parsesAsMapping(frontmatter: string): boolean {
  if (/^<{7} |^={7}$|^>{7} /m.test(frontmatter)) return false;
  try {
    const fm = yaml.load(frontmatter, { schema: yaml.FAILSAFE_SCHEMA, json: false });
    return fm !== null && typeof fm === 'object' && !Array.isArray(fm);
  } catch { // @silent-fallback-ok — a frontmatter that will not parse is re-quoted on the next pass; the caller logs canonical-backfill-unparseable and skips (nothing is written on a guess)
    return false;
  }
}

/**
 * The string content a `key: value` text carries, or null when the value is a
 * flow collection (`[...]` / `{...}`) that must stay verbatim. A plain scalar's
 * text IS its content — it is never loaded standalone, because `Audit: loop`
 * would then read as a mapping and `foo # bar` would lose its `#` tail; that
 * content is exactly what the re-quoting preserves. A quoted scalar yields its
 * decoded content.
 */
function scalarContent(value: string): string | null {
  const first = value[0];
  if (first === '[' || first === '{') {
    try {
      yaml.load(value, { schema: yaml.FAILSAFE_SCHEMA, json: false });
      return null; // a well-formed flow collection — keep the line as written
    } catch { // @silent-fallback-ok — same: unparseable after re-quoting ⇒ no canonical, logged by the caller
      return value; // an unterminated bracket is plain text to a human; quote it
    }
  }
  if (first === '"' || first === "'") {
    try {
      const v = yaml.load(value, { schema: yaml.FAILSAFE_SCHEMA, json: false });
      return typeof v === 'string' ? v : value;
    } catch { // @silent-fallback-ok — same: the final parse attempt failing means "no canonical" — the safe direction
      return value;
    }
  }
  return value;
}

function reserialize(frontmatter: string): string {
  const out: string[] = [];
  // The entry currently open for continuation folding, if any.
  let open: { index: number; indent: string; key: string; content: string } | null = null;
  const flush = (): void => {
    if (!open) return;
    out[open.index] = `${open.indent}${open.key}: ${JSON.stringify(open.content)}`;
    open = null;
  };
  for (const line of frontmatter.split(/\r?\n/)) {
    const m = line.match(KEY_LINE_RE);
    if (m) {
      flush();
      const [, indent, key, rawValue] = m;
      const value = (rawValue ?? '').trim();
      if (value === '' || value.startsWith('#')) {
        out.push(line); // block start (`metadata:`) or key with a comment only — verbatim
        continue;
      }
      if (value.startsWith('|') || value.startsWith('>')) {
        out.push(line); // block scalar indicator — its indented lines follow verbatim
        continue;
      }
      const content = scalarContent(value);
      if (content === null) {
        out.push(line); // flow list / mapping — verbatim
        continue;
      }
      out.push(''); // placeholder, written on flush
      open = { index: out.length - 1, indent, key, content };
      continue;
    }
    // Not a key line: a continuation of an open plain scalar folds into it.
    if (open && line.trim() !== '' && /^\s+/.test(line) && !line.trim().startsWith('#')) {
      open.content = `${open.content} ${line.trim()}`;
      continue;
    }
    flush();
    out.push(line);
  }
  flush();
  return out.join('\n');
}

export function normalizeSkillFrontmatter(raw: string): NormalizedSkillFrontmatter | null {
  const m = raw.match(FRONTMATTER_RE);
  if (!m) return null; // no frontmatter block — never canonical
  const [, frontmatter] = m;
  if (parsesAsMapping(frontmatter)) return { text: raw, changed: false };
  const fixed = reserialize(frontmatter);
  if (!parsesAsMapping(fixed)) return null;
  // Rebuild with the ORIGINAL delimiters and body bytes (only the frontmatter text changes).
  const start = raw.indexOf(frontmatter);
  const text = raw.slice(0, start) + fixed + raw.slice(start + frontmatter.length);
  return { text, changed: true };
}
