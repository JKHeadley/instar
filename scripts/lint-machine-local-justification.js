#!/usr/bin/env node
/**
 * lint-machine-local-justification.js — the DETERMINISTIC marker floor for
 * Standard A ("An Instar Agent Is Always a Multi-Machine Entity",
 * docs/STANDARDS-REGISTRY.md), built per docs/specs/three-standards-enforcement.md
 * §178-202 ("The marker's location + parse contract").
 *
 * ── What it is (Signal vs. Authority — the BODY, not the MIND) ─────────────
 * A no-LLM static parser that grades the PRESENCE + well-formedness of the
 * `machine-local-justification: <taxonomy-key>` marker a spec must carry for each
 * machine-local state surface it introduces. It is the cheap deterministic SIGNAL
 * that front-runs the /spec-converge integration reviewer; the reviewer holds the
 * semantic AUTHORITY (is the justification actually TRUE?) that a parser cannot
 * make (§194-202). Neither alone is the enforcement — together they are.
 *
 * ── The contract it checks (bidirectional, §170) ──────────────────────────
 *   A1 — UNDEFENDED machine-local: the spec's `## Multi-machine posture` section
 *        ASSERTS a machine-local posture (contains the token `machine-local`) but
 *        carries NO well-formed `machine-local-justification:` marker. §163: "a
 *        bare 'machine-local BY DESIGN' with no taxonomy-jailed justification is a
 *        MATERIAL FINDING."
 *   A2 — SPURIOUS / MALFORMED marker (the reverse direction, §170): a
 *        `machine-local-justification:` marker whose key is NOT in the closed
 *        taxonomy {physical-credential-locality, hardware-bound-resource,
 *        operator-ratified-exception}; OR an `operator-ratified-exception` marker
 *        that cites no machine-verifiable, existence-checkable ref (a commit SHA,
 *        a dotted registry key, or a URL — §155-162: a bare topic+date fails
 *        DETERMINISTICALLY); OR a well-formed marker that sits OUTSIDE the
 *        `## Multi-machine posture` section (the location contract, §178-181).
 *
 * ── Honest deterministic scope (§194-202, §242-245) ───────────────────────
 * PRESENCE + well-formedness only. It does NOT judge whether a declared posture
 * is the CORRECT one for the surface (that is the reviewer's semantic audit), and
 * it does NOT flag a spec that simply omits a posture section — §168's
 * "absence defaults to unified-required" is a semantic call the reviewer owns, not
 * a deterministic one. A `<placeholder>` marker value (template prose like
 * `machine-local-justification: <taxonomy-key>`) is IGNORED — it is documentation,
 * not a real marker.
 *
 * ── Rollout MODE — REPORT-FIRST (graduated rollout) ───────────────────────
 * Per the spec's honesty / hard-sequencing clause (§197-202, §563-573) and the
 * dark-first Maturation convention: the deterministic marker lint's grade is
 * "inert until the registry ship" — this floor lands as a SIGNAL first, not a new
 * brittle blocking gate. Default run REPORTS findings and exits 0 (never blocks;
 * existing specs predate the marker convention and are swept separately, §242-245).
 * `--strict` makes findings exit non-zero — the FAIL capability the spec describes
 * (§197-199), used by this lint's tests and available for a later CI graduation.
 *
 * Exit codes:
 *   0 — clean, OR findings in report mode (default)
 *   1 — findings in --strict mode, OR a usage error
 *
 * Usage:
 *   node scripts/lint-machine-local-justification.js                 # report, scans docs/specs
 *   node scripts/lint-machine-local-justification.js FILE...         # report specific files
 *   node scripts/lint-machine-local-justification.js --strict FILE   # FAIL on any finding
 *   node scripts/lint-machine-local-justification.js --json FILE     # machine-readable findings
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');

// ── The closed taxonomy (§148-162). Widening it is a constitution-bound
//    operator decision, never an author's convenience (§205-219). ──────────
export const TAXONOMY_KEYS = new Set([
  'physical-credential-locality',
  'hardware-bound-resource',
  'operator-ratified-exception',
]);

const POSTURE_SECTION_RE = /^#{1,6}\s+Multi-machine posture\b.*$/im;

// A standalone marker line: start-of-line (optional bullet / backtick), the
// label, a colon, then `key rest`. Anchored so a mid-sentence backticked prose
// mention (e.g. "declares it with a `machine-local-justification: <key>` marker")
// does NOT match — only a real declaration line does.
const MARKER_LINE_RE =
  /^[ \t]*(?:[-*+][ \t]+)?`?machine-local-justification`?[ \t]*:[ \t]*`?([^\s`]+)`?[ \t]*(.*?)`?[ \t]*$/gim;

// A machine-verifiable, existence-checkable ref for operator-ratified-exception
// (§155-162): a commit SHA (7-40 hex), a URL, or a dotted registry key.
const REF_SHA_RE = /\b[0-9a-f]{7,40}\b/i;
const REF_URL_RE = /https?:\/\/\S+/i;
const REF_REGISTRY_KEY_RE = /\b[a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_]+){1,}\b/;

/**
 * Locate the bounds of the `## Multi-machine posture` section in a spec's text.
 * Returns { start, end } character offsets, or null when the section is absent.
 * The section runs from its heading to the next heading of equal-or-higher level
 * (or EOF).
 */
export function findPostureSection(text) {
  const m = POSTURE_SECTION_RE.exec(text);
  if (!m) return null;
  const headingLevel = (m[0].match(/^#+/) || ['#'])[0].length;
  const start = m.index;
  const afterHeading = start + m[0].length;
  // Find the next heading at <= headingLevel after the section starts.
  const rest = text.slice(afterHeading);
  const nextHeadingRe = new RegExp(`^#{1,${headingLevel}}\\s+\\S`, 'im');
  const nm = nextHeadingRe.exec(rest);
  const end = nm ? afterHeading + nm.index : text.length;
  return { start, end };
}

/**
 * Parse every standalone `machine-local-justification:` marker line in the text.
 * `<placeholder>` values (template prose) are skipped. Returns
 * [{ key, rest, index }].
 */
export function parseMarkers(text) {
  const out = [];
  MARKER_LINE_RE.lastIndex = 0;
  let m;
  while ((m = MARKER_LINE_RE.exec(text)) !== null) {
    const key = m[1];
    const rest = (m[2] || '').trim();
    // Skip template placeholders like `<taxonomy-key>` / `<key>` — documentation,
    // not a real declaration.
    if (/^<.*>$/.test(key)) continue;
    out.push({ key, rest, index: m.index });
  }
  return out;
}

/** True if `rest` carries a machine-verifiable, existence-checkable ref. */
export function hasResolvableRef(rest) {
  if (!rest) return false;
  return REF_SHA_RE.test(rest) || REF_URL_RE.test(rest) || REF_REGISTRY_KEY_RE.test(rest);
}

/**
 * Grade one spec's text against Standard A's marker contract. Pure — no I/O.
 * Returns { findings: [{ rule, message }] }.
 */
export function gradeMachineLocalMarkers(text) {
  const findings = [];
  const markers = parseMarkers(text);
  const posture = findPostureSection(text);

  // ── A2 — spurious / malformed markers (both directions, §170) ──
  for (const marker of markers) {
    if (!TAXONOMY_KEYS.has(marker.key)) {
      findings.push({
        rule: 'A2-invalid-taxonomy-key',
        message:
          `machine-local-justification key "${marker.key}" is not in the closed taxonomy ` +
          `{${[...TAXONOMY_KEYS].join(', ')}}. A key outside the set is a MATERIAL FINDING ` +
          `(a fourth reason is an operator-ratified constitutional decision, §205-219).`,
      });
      continue;
    }
    if (marker.key === 'operator-ratified-exception' && !hasResolvableRef(marker.rest)) {
      findings.push({
        rule: 'A2-unresolvable-ratification-ref',
        message:
          `operator-ratified-exception must cite a machine-verifiable, existence-checkable ref ` +
          `(a commit SHA, a URL, or a dotted registry key) — a bare topic+date fails ` +
          `deterministically (§155-162). Marker value: "${marker.rest || '(empty)'}".`,
      });
    }
    // Location contract (§178-181): a real marker belongs inside `## Multi-machine posture`.
    if (posture && (marker.index < posture.start || marker.index >= posture.end)) {
      findings.push({
        rule: 'A2-marker-outside-posture-section',
        message:
          `machine-local-justification marker ("${marker.key}") sits OUTSIDE the ` +
          `## Multi-machine posture section — the marker's fixed location is what makes ` +
          `PRESENCE machine-checkable (§178-181).`,
      });
    }
  }

  // ── A1 — undefended machine-local assertion (§163) ──
  // Scope the trigger to the posture section so a mere prose mention of
  // "machine-local" elsewhere in the spec is not a false positive.
  if (posture) {
    const sectionText = text.slice(posture.start, posture.end);
    const assertsMachineLocal = /machine-local/i.test(sectionText);
    const hasValidMarker = markers.some(
      (mk) =>
        TAXONOMY_KEYS.has(mk.key) &&
        mk.index >= posture.start &&
        mk.index < posture.end &&
        (mk.key !== 'operator-ratified-exception' || hasResolvableRef(mk.rest)),
    );
    if (assertsMachineLocal && !hasValidMarker) {
      findings.push({
        rule: 'A1-undefended-machine-local',
        message:
          `the ## Multi-machine posture section asserts a machine-local posture but carries no ` +
          `well-formed machine-local-justification: <taxonomy-key> marker. A bare ` +
          `"machine-local BY DESIGN" with no taxonomy-jailed justification is a MATERIAL FINDING ` +
          `(§163). Default posture is unified (§148).`,
      });
    }
  }

  return { findings };
}

// ── CLI ────────────────────────────────────────────────────────────────────

function listSpecFiles() {
  const dir = path.join(ROOT, 'docs', 'specs');
  const out = [];
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith('.md')) out.push(p);
    }
  };
  walk(dir);
  return out;
}

function main() {
  const argv = process.argv.slice(2);
  const strict = argv.includes('--strict');
  const json = argv.includes('--json');
  const files = argv.filter((a) => !a.startsWith('--'));
  const targets = files.length ? files : listSpecFiles();

  const allFindings = [];
  for (const file of targets) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const { findings } = gradeMachineLocalMarkers(text);
    for (const f of findings) allFindings.push({ file: path.relative(ROOT, path.resolve(file)), ...f });
  }

  if (json) {
    process.stdout.write(JSON.stringify({ findings: allFindings, strict }, null, 2) + '\n');
  } else if (allFindings.length === 0) {
    console.log('lint-machine-local-justification: clean — no undefended or malformed markers.');
  } else {
    const header = strict
      ? 'lint-machine-local-justification: FINDINGS (strict — blocking):'
      : 'lint-machine-local-justification: findings (report-first — non-blocking signal):';
    console.error(header);
    for (const f of allFindings) {
      console.error(`  • [${f.rule}] ${f.file}`);
      console.error(`      ${f.message}`);
    }
    console.error(
      `\n  ${allFindings.length} finding(s). Standard A: docs/STANDARDS-REGISTRY.md ` +
        `("An Instar Agent Is Always a Multi-Machine Entity").`,
    );
  }

  if (strict && allFindings.length > 0) process.exit(1);
  process.exit(0);
}

// Only run the CLI when invoked directly (not when imported by a test).
const invokedDirectly =
  process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(__filename);
if (invokedDirectly) main();
