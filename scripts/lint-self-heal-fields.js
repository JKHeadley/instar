#!/usr/bin/env node
/**
 * lint-self-heal-fields.js — the DETERMINISTIC field-schema floor for Standard B
 * ("Self-Heal Before Notify", docs/STANDARDS-REGISTRY.md), built per
 * docs/specs/three-standards-enforcement.md §256-289, §343-361.
 *
 * ── What it is (Signal vs. Authority — the BODY, not the MIND) ─────────────
 * A no-LLM static parser over a spec's self-heal DECLARATION. When a spec adds a
 * watcher/monitor that can escalate to the operator, it must declare a bounded
 * self-heal step with the P19 brake fields (§265-283). `remediation-actions` is
 * the deterministic anti-no-op SIGNAL (§270): listing the concrete operations the
 * heal invokes makes "did this heal actually DO something?" machine-inspectable,
 * so the /spec-converge reviewer's substance judgment becomes a semantic AUDIT
 * over a deterministic floor rather than the sole guard. This lint IS that floor;
 * the reviewer holds the authority (is the heal SUBSTANTIVE? is the severity class
 * CORRECT?) a parser cannot judge.
 *
 * ── The contract it checks ────────────────────────────────────────────────
 *   B0 — IN SCOPE: a spec declares a self-heal block iff it carries a
 *        `remediation-actions:` labeled line (the anchor field, §270). No anchor →
 *        not in scope (a spec with no watcher pays no self-heal cost, §353-355).
 *   B1 — REQUIRED FIELDS present (§265-283, §592): max-attempts, max-wall-clock,
 *        backoff, dedupe-key, breaker, max-notification-latency, audit-location,
 *        remediation-actions, class. A missing field is a MATERIAL FINDING.
 *   B2 — NO-OP heal: remediation-actions must be non-empty (inline value OR ≥1
 *        following bullet). An empty list is the no-op that merely flips a flag to
 *        unlock the escalation path (§286-291) — a MATERIAL FINDING.
 *   B3 — LATENCY UNITS: max-notification-latency must be a duration WITH units
 *        (e.g. `120s`, `5m`) — never a bare number or an adjective (§318-323).
 *   B4 — SEVERITY CLASS value: class must be a recognized class
 *        {recoverable, critical, irreversible, data-loss, security}. (The lint
 *        grades the value's WELL-FORMEDNESS; the reviewer CONTESTS its
 *        correctness, §306-310.)
 *
 * ── Honest deterministic scope (§357-361, §194-202) ───────────────────────
 * PRESENCE + well-formedness of the declared fields only. It does NOT judge
 * whether a heal is genuinely SUBSTANTIVE, whether a `recoverable` label is honest,
 * or whether exhaustion is truly reachable — those are the reviewer's semantic
 * audit and (for the runtime gate) the downstream SelfHealGate fixture (§374-389).
 *
 * ── Rollout MODE — REPORT-FIRST (graduated rollout) ───────────────────────
 * Per the spec's honesty / hard-sequencing clause (§357-361, §563-573) and the
 * dark-first Maturation convention: this floor lands as a SIGNAL first, not a new
 * brittle blocking gate. Default run REPORTS findings and exits 0 (never blocks).
 * `--strict` makes findings exit non-zero — the FAIL capability, used by this
 * lint's tests and available for a later CI graduation.
 *
 * Exit codes:
 *   0 — clean, OR findings in report mode (default)
 *   1 — findings in --strict mode, OR a usage error
 *
 * Usage:
 *   node scripts/lint-self-heal-fields.js                 # report, scans docs/specs
 *   node scripts/lint-self-heal-fields.js FILE...         # report specific files
 *   node scripts/lint-self-heal-fields.js --strict FILE   # FAIL on any finding
 *   node scripts/lint-self-heal-fields.js --json FILE     # machine-readable findings
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');

// The full P19-brake + declaration field set a self-heal watcher must declare
// (§265-283, §592). `remediation-actions` is the in-scope anchor (§270).
export const REQUIRED_FIELDS = [
  'max-attempts',
  'max-wall-clock',
  'backoff',
  'dedupe-key',
  'breaker',
  'max-notification-latency',
  'audit-location',
  'remediation-actions',
  'class',
];

const ANCHOR_FIELD = 'remediation-actions';

// The severity classes an author may declare (§306). The reviewer CONTESTS
// correctness; the lint only grades that the declared value is well-formed.
export const SEVERITY_CLASSES = new Set([
  'recoverable',
  'critical',
  'irreversible',
  'data-loss',
  'security',
]);

// A duration WITH units: an integer/decimal followed by ms | s | m | h (§318-323).
const DURATION_WITH_UNITS_RE = /^\d+(?:\.\d+)?\s*(?:ms|s|m|h)$/i;

function fieldLineRe(name) {
  const escaped = name.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
  // start-of-line, optional bullet, optional backticks, label, colon, value.
  return new RegExp(`^[ \\t]*(?:[-*+][ \\t]+)?\`?${escaped}\`?[ \\t]*:[ \\t]*(.*)$`, 'im');
}

/** Return the inline value string for a labeled field, or null if absent. */
export function findField(text, name) {
  const m = fieldLineRe(name).exec(text);
  if (!m) return null;
  // Strip a trailing backtick and surrounding whitespace/backticks from the value.
  return m[1].replace(/`/g, '').trim();
}

/**
 * True if the field's list value is non-empty: either an inline value after the
 * colon, OR at least one bullet line following the field's declaration line.
 */
export function listFieldIsNonEmpty(text, name) {
  const re = fieldLineRe(name);
  const m = re.exec(text);
  if (!m) return false;
  const inline = m[1].replace(/[`[\]]/g, '').trim();
  if (inline.length > 0) return true;
  // Scan the lines immediately after the field line for bullets, stopping at a
  // blank line or the next labeled field / heading. Strip the single newline
  // that terminates the field line itself so it doesn't read as an empty line.
  const after = text.slice(m.index + m[0].length).replace(/^\r?\n/, '');
  const lines = after.split('\n');
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    if (/^\s*$/.test(line)) break; // blank line ends the block
    if (/^#{1,6}\s/.test(line)) break; // next heading
    if (/^[ \t]*[-*+][ \t]+\S/.test(line)) return true; // a real bullet with content
    if (/^[ \t]*\S+[ \t]*:/.test(line)) break; // next labeled field
  }
  return false;
}

/**
 * Grade one spec's text against Standard B's self-heal field schema. Pure — no
 * I/O. Returns { inScope, findings: [{ rule, message }] }.
 */
export function gradeSelfHealFields(text) {
  const findings = [];
  const inScope = findField(text, ANCHOR_FIELD) !== null;
  if (!inScope) return { inScope: false, findings };

  // B1 — required fields present.
  for (const field of REQUIRED_FIELDS) {
    if (findField(text, field) === null) {
      findings.push({
        rule: 'B1-missing-field',
        message:
          `self-heal declaration is missing required field "${field}". A watcher's bounded ` +
          `self-heal must declare its full P19 brake set (§265-283) — an unbounded or ` +
          `undeclared brake is the compounding-loop failure the standard forbids.`,
      });
    }
  }

  // B2 — remediation-actions must not be a no-op (non-empty).
  if (!listFieldIsNonEmpty(text, ANCHOR_FIELD)) {
    findings.push({
      rule: 'B2-noop-remediation',
      message:
        `remediation-actions is empty. A heal that names no concrete operation is a no-op that ` +
        `merely unlocks the escalation path (§286-291) — the anti-no-op floor requires ≥1 ` +
        `substantive action (e.g. re-register-flag, restart-tracker, re-deliver-report).`,
    });
  }

  // B3 — max-notification-latency must carry units.
  const latency = findField(text, 'max-notification-latency');
  if (latency !== null && latency.length > 0 && !DURATION_WITH_UNITS_RE.test(latency)) {
    findings.push({
      rule: 'B3-latency-unitless',
      message:
        `max-notification-latency "${latency}" must be an explicit duration WITH units ` +
        `(e.g. 120s, 5m) — never a bare number or an adjective (§318-323).`,
    });
  }

  // B4 — severity class value well-formed.
  const cls = findField(text, 'class');
  if (cls !== null && cls.length > 0 && !SEVERITY_CLASSES.has(cls.toLowerCase())) {
    findings.push({
      rule: 'B4-unknown-severity-class',
      message:
        `severity class "${cls}" is not a recognized class ` +
        `{${[...SEVERITY_CLASSES].join(', ')}}. (The reviewer CONTESTS whether the class is ` +
        `CORRECT for the degradation, §306-310; the lint checks it is well-formed.)`,
    });
  }

  return { inScope: true, findings };
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
    const { findings } = gradeSelfHealFields(text);
    for (const f of findings) allFindings.push({ file: path.relative(ROOT, path.resolve(file)), ...f });
  }

  if (json) {
    process.stdout.write(JSON.stringify({ findings: allFindings, strict }, null, 2) + '\n');
  } else if (allFindings.length === 0) {
    console.log('lint-self-heal-fields: clean — every self-heal declaration carries its field set.');
  } else {
    const header = strict
      ? 'lint-self-heal-fields: FINDINGS (strict — blocking):'
      : 'lint-self-heal-fields: findings (report-first — non-blocking signal):';
    console.error(header);
    for (const f of allFindings) {
      console.error(`  • [${f.rule}] ${f.file}`);
      console.error(`      ${f.message}`);
    }
    console.error(
      `\n  ${allFindings.length} finding(s). Standard B: docs/STANDARDS-REGISTRY.md ` +
        `("Self-Heal Before Notify").`,
    );
  }

  if (strict && allFindings.length > 0) process.exit(1);
  process.exit(0);
}

const invokedDirectly =
  process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(__filename);
if (invokedDirectly) main();
