/**
 * Tiny YAML frontmatter parser used by project-scope.
 *
 * Scope is deliberately narrow:
 *   - top-level scalar keys (`key: value`)
 *   - top-level boolean (`true` / `false`) and numeric scalars
 *   - top-level string scalars (with optional double-quoting)
 *   - top-level string arrays via `- item` block sequences OR `[a, b, c]`
 *     flow sequences
 *   - no nested maps, no anchors, no multi-document streams
 *
 * Why not js-yaml: that dep isn't in the current package.json and the spec
 * (Phase 1.6) only asks for safe-load semantics over a constrained schema.
 * Adding a new runtime dep for ~40 lines of work isn't worth the supply-chain
 * surface. If the schema grows beyond block scalars we add js-yaml then.
 *
 * Hardening:
 *   - Tag-like values starting with `!` are rejected (no `!!python/object`).
 *   - Anchor / alias tokens (`&` / `*` at the start of a value) are rejected.
 *   - Aborts after 1000 lines to bound CPU on adversarial input.
 *
 * All callers wrap the output in their own schema validator — this returns
 * `unknown` shaped as `Record<string, unknown>` and never throws on missing
 * keys.
 */

const MAX_LINES = 1000;

export interface FrontmatterResult {
  ok: true;
  data: Record<string, unknown>;
}

export interface FrontmatterError {
  ok: false;
  error: string;
}

/**
 * Extract the YAML frontmatter from a markdown string. Returns the parsed
 * frontmatter and the body (everything after the second `---`). If no
 * frontmatter is present, `data` is `{}` and body is the entire input.
 */
export function extractFrontmatter(
  source: string
): { frontmatter: Record<string, unknown> | null; body: string; error?: string } {
  const trimmedHead = source.startsWith('﻿') ? source.slice(1) : source;
  if (!trimmedHead.startsWith('---')) {
    return { frontmatter: null, body: source };
  }
  const lines = trimmedHead.split(/\r?\n/);
  if (lines.length > MAX_LINES) {
    return { frontmatter: null, body: source, error: 'document exceeds 1000-line cap' };
  }
  // First line should be the opening `---` (possibly with trailing spaces).
  if (lines[0].trim() !== '---') {
    return { frontmatter: null, body: source };
  }
  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---' || lines[i].trim() === '...') {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) {
    return { frontmatter: null, body: source, error: 'unterminated frontmatter block' };
  }
  const yamlBody = lines.slice(1, endIdx).join('\n');
  const body = lines.slice(endIdx + 1).join('\n');
  const parsed = parseSafeYaml(yamlBody);
  if (!parsed.ok) {
    return { frontmatter: null, body, error: parsed.error };
  }
  return { frontmatter: parsed.data, body };
}

export function parseSafeYaml(input: string): FrontmatterResult | FrontmatterError {
  const lines = input.split(/\r?\n/);
  if (lines.length > MAX_LINES) {
    return { ok: false, error: 'yaml exceeds 1000-line cap' };
  }
  const data: Record<string, unknown> = {};
  let i = 0;
  while (i < lines.length) {
    const rawLine = lines[i];
    const line = rawLine.replace(/\s+$/, '');
    if (!line.trim() || line.trim().startsWith('#')) {
      i++;
      continue;
    }
    // Top-level: must start at column 0 with `key:` (no leading whitespace).
    if (/^\s/.test(line)) {
      return { ok: false, error: `unexpected indentation at line ${i + 1}` };
    }
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) {
      return { ok: false, error: `expected "key:" at line ${i + 1}` };
    }
    const key = line.slice(0, colonIdx).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key)) {
      return { ok: false, error: `invalid key "${key}" at line ${i + 1}` };
    }
    const rest = line.slice(colonIdx + 1).trim();
    if (rest === '' || rest === '|' || rest === '>') {
      // Block sequence or block scalar follows on indented lines.
      const childLines: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const next = lines[j];
        if (next.trim() === '' || next.startsWith(' ') || next.startsWith('\t') || next.startsWith('-')) {
          childLines.push(next);
          j++;
        } else {
          break;
        }
      }
      // Detect block sequence by leading `-` (with optional indent).
      const seqLines = childLines.filter((l) => /^\s*-\s+/.test(l));
      if (seqLines.length > 0 && seqLines.length === childLines.filter((l) => l.trim()).length) {
        const arr: string[] = [];
        for (const sl of seqLines) {
          const item = sl.replace(/^\s*-\s+/, '').trim();
          const v = parseScalar(item);
          if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') {
            return { ok: false, error: `unsupported sequence item at "${key}"` };
          }
          arr.push(String(v));
        }
        data[key] = arr;
      } else if (rest === '|' || rest === '>') {
        // Block scalar: dedent shortest common leading whitespace.
        const nonEmpty = childLines.filter((l) => l.trim().length > 0);
        const indents = nonEmpty.map((l) => (l.match(/^\s*/)?.[0].length ?? 0));
        const minIndent = indents.length > 0 ? Math.min(...indents) : 0;
        const joined = nonEmpty.map((l) => l.slice(minIndent)).join(rest === '|' ? '\n' : ' ');
        data[key] = joined;
      } else {
        // No children → empty string / undefined behaviour: treat as empty string.
        data[key] = '';
      }
      i = j;
      continue;
    }
    const valueResult = parseInlineValue(rest);
    if (!valueResult.ok) {
      return { ok: false, error: `${valueResult.error} at line ${i + 1}` };
    }
    data[key] = valueResult.value;
    i++;
  }
  return { ok: true, data };
}

function parseInlineValue(
  raw: string
): { ok: true; value: unknown } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (trimmed.startsWith('!')) {
    return { ok: false, error: 'YAML tags are not permitted' };
  }
  if (trimmed.startsWith('&') || trimmed.startsWith('*')) {
    return { ok: false, error: 'YAML anchors and aliases are not permitted' };
  }
  // Flow sequence [a, b, c]
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const inner = trimmed.slice(1, -1).trim();
    if (inner === '') return { ok: true, value: [] };
    const parts = splitFlowList(inner);
    const arr: unknown[] = [];
    for (const p of parts) {
      const v = parseScalar(p.trim());
      arr.push(v);
    }
    return { ok: true, value: arr };
  }
  // Flow mapping {k: v} is not supported in our schema; reject to fail loud.
  if (trimmed.startsWith('{')) {
    return { ok: false, error: 'inline maps are not permitted' };
  }
  return { ok: true, value: parseScalar(trimmed) };
}

function splitFlowList(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inStr: string | null = null;
  let cur = '';
  for (const ch of s) {
    if (inStr) {
      cur += ch;
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inStr = ch;
      cur += ch;
      continue;
    }
    if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim().length > 0) out.push(cur);
  return out;
}

function parseScalar(raw: string): unknown {
  const s = raw.trim();
  if (s === '') return '';
  if (s === 'null' || s === '~') return null;
  if (s === 'true' || s === 'True' || s === 'TRUE') return true;
  if (s === 'false' || s === 'False' || s === 'FALSE') return false;
  // Quoted strings (return raw, no escape processing — we don't need it for
  // the project-scope schema).
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  // Number?
  if (/^-?\d+$/.test(s)) {
    const n = parseInt(s, 10);
    if (Number.isSafeInteger(n)) return n;
  }
  if (/^-?\d+\.\d+$/.test(s)) {
    const f = parseFloat(s);
    if (Number.isFinite(f)) return f;
  }
  return s;
}
