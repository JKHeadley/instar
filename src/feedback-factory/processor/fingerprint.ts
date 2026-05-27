/**
 * fingerprint.ts — TypeScript port of the feedback-factory dedup fingerprinter.
 *
 * Scar (b) of docs/specs/feedback-factory-migration.md. Byte-exact port of
 * `compute_fingerprint` + its `extract_component` dependency from the reference
 * `the-portal/.claude/scripts/feedback-processor.py` (verified against Dawn's
 * line refs 2026-05-26: compute_fingerprint :227, extract_component :191,
 * SEVERITY sets :182/:186). This decides whether two reports are the SAME bug —
 * the single most correctness-critical port in the migration.
 *
 * Equivalence to the Python is proven EMPIRICALLY by the parity harness
 * (scripts/feedback-factory/fingerprint-parity.mjs), not by reasoning alone:
 * Python and JS differ on regex character classes (`\d`/`\w`/`\b` are Unicode
 * in Python without re.ASCII, ASCII in JS), `.lower()` vs `.toLowerCase()`, and
 * whitespace stripping. The port below mirrors Python's Unicode semantics where
 * JS can (`u` flag + Unicode property escapes); the harness's adversarial corpus
 * (non-ASCII digits, em-dash, NBSP, NFC/NFD, Turkish-İ/ß) is the gate that
 * catches any residual divergence. Do NOT "simplify" a regex without re-running
 * the harness — that is exactly how the silent history-fork ships.
 */

import { createHash } from 'node:crypto';

// Python: SEVERITY_PREFIXES (:182) / SEVERITY_PHRASES (:186) — byte-for-byte.
const SEVERITY_PREFIXES: ReadonlySet<string> = new Set([
  'DEGRADATION', 'ALERT', 'VERIFIED', 'CRITICAL', 'RECURRING',
  'PATTERN', 'WARNING', 'BUG', 'FEATURE', 'WONTFIX',
]);
const SEVERITY_PHRASES: ReadonlySet<string> = new Set([
  'VERIFIED FIX', 'WONTFIX', 'BUG REPORT',
]);

/**
 * Port of Python `extract_component(title)` (:191). Strips a leading [TAG] and a
 * whitelisted severity prefix, then returns the first dotted identifier
 * (e.g. "gitsync.pull") or the first word, lowercased; "" if none.
 *
 * Python `\w` is Unicode (no re.ASCII); JS `\w` is ASCII. We use `\p{L}\p{N}_`
 * under the `u` flag to mirror Python's Unicode word-char semantics. `re.match`
 * is start-anchored — the `^` anchors below make `.match()` equivalent.
 */
export function extractComponent(title: string): string {
  if (!title) return '';
  let t = title;

  // Python :208 — strip [TAG] prefix: re.sub(r'^\[([A-Z_]+)\]\s*', '', t)
  t = t.replace(/^\[([A-Z_]+)\]\s*/u, '');

  // Python :211 — strip a whitelisted severity prefix only (never arbitrary
  // uppercase-colon): re.match(r'^([A-Z][A-Z\s]*?):\s*', t)
  const sev = t.match(/^([A-Z][A-Z\s]*?):\s*/u);
  if (sev) {
    const candidate = sev[1].trim();
    if (SEVERITY_PHRASES.has(candidate) || SEVERITY_PREFIXES.has(candidate)) {
      t = t.slice(sev[0].length);
    }
  }

  // Python :218 — dotted identifier first: ^([A-Za-z][\w]*(?:\.[A-Za-z][\w]*)+)
  const dotted = t.match(/^([A-Za-z][\p{L}\p{N}_]*(?:\.[A-Za-z][\p{L}\p{N}_]*)+)/u);
  if (dotted) return dotted[1].toLowerCase();

  // Python :223 — fallback to first word: ^([A-Za-z][\w]+)
  const word = t.match(/^([A-Za-z][\p{L}\p{N}_]+)/u);
  return word ? word[1].toLowerCase() : '';
}

/**
 * Port of Python `compute_fingerprint(type, title, component="")` (:227).
 * Normalizes the title (lowercase; collapse versions / hashes / bare ints /
 * whitespace) and returns the first 32 hex chars of SHA-256 over
 * `type|component|normalized_title`. `v1.1.0` and `v1.1.1` collapse to the same
 * fingerprint → same bug.
 *
 * Python `re.sub` is global → JS needs the `g` flag. Python `\d`/`\w`/`\b` are
 * Unicode (no re.ASCII): `\d`→`\p{Nd}`, `\w`→`[\p{L}\p{N}_]` under `u`. JS has no
 * native Unicode `\b`; the hash/int strips below keep ASCII-hex/`\p{Nd}` content
 * with `\b` — the parity harness verifies the boundary behavior against the
 * Python on the adversarial corpus.
 */
export function computeFingerprint(type: string, title: string, component = ''): string {
  if (!component) {
    component = extractComponent(title);
  }

  let normalized = title.toLowerCase();
  // :237 — re.sub(r'v?\d+\.\d+\.\d+(-[\w.]+)?', 'vN', s). Python `\d`/`\w` are
  // Unicode → `\p{Nd}` / `[\p{L}\p{N}_.]`. No `\b` here, so no boundary concern.
  normalized = normalized.replace(/v?\p{Nd}+\.\p{Nd}+\.\p{Nd}+(-[\p{L}\p{N}_.]+)?/gu, 'vN');
  // :238 — re.sub(r'\b[0-9a-f]{8,}\b', 'HASH', s). Python `\b` is a UNICODE word
  // boundary; JS `\b` is ASCII-only. Emulate with lookarounds over the Unicode
  // word-char set `[\p{L}\p{N}_]` (≈ Python `\w`) so adjacency to a non-ASCII
  // letter/digit behaves like the reference.
  normalized = normalized.replace(/(?<![\p{L}\p{N}_])[0-9a-f]{8,}(?![\p{L}\p{N}_])/gu, 'HASH');
  // :239 — re.sub(r'\b\d+\b', 'N', s). Same Unicode-boundary emulation; `\d` →
  // `\p{Nd}` (Python Unicode digits, e.g. arabic-indic ٥, which ASCII `\b` misses).
  normalized = normalized.replace(/(?<![\p{L}\p{N}_])\p{Nd}+(?![\p{L}\p{N}_])/gu, 'N');
  // :240 — re.sub(r'\s+', ' ', s).strip()
  normalized = normalized.replace(/\s+/gu, ' ').trim();

  // :242-243 — sha256 over UTF-8 bytes of "type|component|normalized", 32 hex chars
  const raw = `${type.toLowerCase()}|${component.toLowerCase()}|${normalized}`;
  return createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 32);
}
