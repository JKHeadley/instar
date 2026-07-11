#!/usr/bin/env node
/**
 * write-audit-convergence.mjs — stamp an audit report's frontmatter with the
 * `converged:` claim, but ONLY when the ledger earns it (audit-convergence-enforcement
 * spec §1). Mirrors skills/spec-converge/scripts/write-convergence-tag.mjs; pure
 * functions are exported for tests; `main()` is guarded.
 *
 * A converged audit report lives at docs/audits/<slug>.md with per-round ledgers.
 * This validator refuses to stamp `converged:` unless ALL hold:
 *   1. ≥2 `## Round N` sections recorded.
 *   2. The final round's `New findings this round: 0` line AND its ledger has 0 rows
 *      (the count is DERIVED from parsed rows and cross-checked against the line).
 *   3. Every ledger row across all rounds carries a valid closed disposition
 *      (`fixed:<ref>` | `accepted:<reason>` | `deferred:<ref>`, each non-empty).
 *   4. Each round records its search-angles + surface-delta.
 *   5. `standing-guard` (jailed + git-tracked) XOR `exemption` (closed enum + rationale).
 *
 * Parsing is line-oriented, single-pass, dependency-free, and FAIL-CLOSED: an
 * unparseable `## Round` section, ledger-like-but-unparseable content, zero
 * parseable rounds, or a duplicate managed frontmatter key REFUSES with a named,
 * shape-teaching reason. Only the FIRST frontmatter block counts.
 *
 * Repo ROOT is resolved from the AUDITED tree (cwd / `git rev-parse --show-toplevel`),
 * NOT this script's package root, so a vendored copy validates the right tree.
 *
 * Modes:
 *   (stamp)     node write-audit-convergence.mjs --audit docs/audits/<slug>.md
 *   --check     validate without stamping (the precommit / CI entry point)
 *   --content-from <path|->  validate content from a file or stdin (the STAGED blob:
 *               `git show :docs/audits/<slug>.md | … --check --content-from -`)
 *
 * Exit codes: 0 pass · 1 validation-failed · 2 internal-error (fail-closed).
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scanForSecrets } from './audit-secret-patterns.mjs';

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const EXEMPTION_KEYS = ['non-ci-expressible', 'external-system', 'one-time-human-review'];
const EXEMPTION_RATIONALE_FLOOR = 12; // chars of real rationale beyond the key
const MANAGED_FRONTMATTER_KEYS = ['audit', 'converged', 'rounds', 'standing-guard', 'exemption'];

// ─── frontmatter ──────────────────────────────────────────────────────────

/**
 * Parse the FIRST YAML-ish frontmatter block only (a second `---` block in the
 * body is body content, not frontmatter). Returns { fields, raw, bodyStart } or
 * throws on a duplicate MANAGED key (a hard refusal — duplicate `converged:` is
 * the classic "first empty, second stamped" dodge).
 */
export function parseFrontmatter(text) {
  const lines = text.split('\n');
  if (lines[0] !== '---') {
    const e = new Error('no frontmatter block (file must open with `---`)');
    e.code = 'no-frontmatter';
    throw e;
  }
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') { end = i; break; }
  }
  if (end === -1) {
    const e = new Error('unterminated frontmatter block');
    e.code = 'bad-frontmatter';
    throw e;
  }
  const fields = {};
  const seen = new Set();
  for (let i = 1; i < end; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const m = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    if (MANAGED_FRONTMATTER_KEYS.includes(key) && seen.has(key)) {
      const e = new Error(`duplicate managed frontmatter key: ${key}`);
      e.code = 'duplicate-key';
      throw e;
    }
    seen.add(key);
    // strip surrounding quotes + trailing comment
    let val = m[2].trim();
    val = val.replace(/\s+#.*$/, '');
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    fields[key] = val;
  }
  return { fields, frontmatterEnd: end, lines };
}

// ─── round + ledger parsing (fail-closed) ───────────────────────────────────

/**
 * A ledger row is `location | behavior | bucket | disposition` (a markdown table
 * row or a `-`/`*` bullet with the same 4 pipe-separated fields). Returns a
 * parsed row {location, behavior, bucket, disposition} or throws `ledger-unparseable`
 * for a line that LOOKS like a ledger row (contains `|` or opens `- `/`* `) but
 * does not parse into 4 non-empty fields — never silently skipped (adversarial-R2
 * new-1: a variant-formatted real finding must REFUSE, not count as zero).
 */
function looksLikeLedgerRow(line) {
  const t = line.trim();
  if (t.startsWith('|') || (t.includes('|') && t.split('|').length >= 4)) return true;
  if (/^[-*]\s+/.test(t) && t.includes('|')) return true;
  return false;
}

export function parseLedgerRow(line) {
  let t = line.trim();
  t = t.replace(/^[-*]\s+/, ''); // strip bullet marker
  // table row: leading/trailing pipes
  const cells = t.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  // skip a table separator (all cells empty or dashes)
  if (cells.every((c) => c === '' || /^:?-+:?$/.test(c))) return null;
  // skip the canonical table HEADER row (the column labels, not a finding)
  const HEADER_CELLS = ['location', 'behavior', 'bucket', 'disposition'];
  if (cells.length >= 4 && cells.slice(0, 4).every((c, i) => c.toLowerCase() === HEADER_CELLS[i])) return null;
  if (cells.length < 4 || cells.slice(0, 4).some((c) => c.length === 0)) {
    const e = new Error(`ledger-like line does not parse into 4 non-empty fields: "${line.trim().slice(0, 60)}"`);
    e.code = 'ledger-unparseable';
    throw e;
  }
  const [location, behavior, bucket, disposition] = cells;
  return { location, behavior, bucket, disposition };
}

const DISPOSITION_RE = /^(fixed|accepted|deferred):\s*(.+)$/;
export function validateDisposition(disposition) {
  const m = disposition.match(DISPOSITION_RE);
  if (!m) return { ok: false, reason: `disposition must be fixed:<ref> | accepted:<reason> | deferred:<ref> — got "${disposition.slice(0, 40)}"` };
  const [, kind, rest] = m;
  if (!rest.trim()) return { ok: false, reason: `${kind}: requires a non-empty ${kind === 'accepted' ? 'reason' : 'ref'}` };
  return { ok: true, kind };
}

/**
 * Parse every `## Round N` section. Returns [{ n, newFindingsLine, rows,
 * hasSearchAngles, hasSurfaceDelta }]. Throws `round-unparseable` on a malformed
 * round (missing/duplicate N, non-integer N) and propagates `ledger-unparseable`.
 */
export function parseRounds(body) {
  const headingRe = /^##\s+Round\s+(\d+)\b.*$/gim;
  const marks = [];
  let m;
  while ((m = headingRe.exec(body)) !== null) {
    marks.push({ n: parseInt(m[1], 10), start: m.index, headEnd: m.index + m[0].length });
  }
  if (marks.length === 0) {
    const e = new Error('no `## Round N` sections found');
    e.code = 'no-rounds';
    throw e;
  }
  const rounds = [];
  const seenN = new Set();
  for (let i = 0; i < marks.length; i++) {
    const { n, headEnd } = marks[i];
    if (seenN.has(n)) {
      const e = new Error(`duplicate "## Round ${n}" section`);
      e.code = 'round-unparseable';
      throw e;
    }
    seenN.add(n);
    const end = i + 1 < marks.length ? marks[i + 1].start : body.length;
    const section = body.slice(headEnd, end);
    const secLines = section.split('\n');

    // New findings count line
    const nfLine = secLines.find((l) => /New findings this round\s*:/i.test(l));
    let newFindingsLine = null;
    if (nfLine) {
      const nm = nfLine.match(/New findings this round\s*:\s*(\d+)/i);
      if (!nm) {
        const e = new Error(`Round ${n}: "New findings this round:" line is not a non-negative integer`);
        e.code = 'round-unparseable';
        throw e;
      }
      newFindingsLine = parseInt(nm[1], 10);
    }

    // ledger rows (fail-closed on ledger-like-but-unparseable)
    const rows = [];
    for (const l of secLines) {
      if (!looksLikeLedgerRow(l)) continue;
      const row = parseLedgerRow(l); // throws ledger-unparseable
      if (row) rows.push(row);
    }

    const hasSearchAngles = /search angles?\b/i.test(section) || /commands? run\b/i.test(section);
    const hasSurfaceDelta = /surface delta\b/i.test(section) || /surface (grew|growth)\b/i.test(section);

    rounds.push({ n, newFindingsLine, rows, hasSearchAngles, hasSurfaceDelta });
  }
  // contiguity: rounds must be 1..N in order
  rounds.sort((a, b) => a.n - b.n);
  for (let i = 0; i < rounds.length; i++) {
    if (rounds[i].n !== i + 1) {
      const e = new Error(`rounds must be contiguous 1..N; found gap at Round ${i + 1}`);
      e.code = 'round-unparseable';
      throw e;
    }
  }
  return rounds;
}

// ─── standing-guard jail ────────────────────────────────────────────────────

/**
 * Validate the standing-guard path: resolved + realpath'd + CONTAINED under ROOT,
 * refuse absolute/`..`-escape/symlink, AND git-tracked-or-staged (Security M3).
 * `stagedSet` (a Set of staged repo-relative paths) lets a NEW ratchet added in
 * the same commit satisfy the check.
 */
export function validateStandingGuard(guardPath, root, stagedSet) {
  if (!guardPath) return { ok: false, reason: 'standing-guard is empty' };
  if (path.isAbsolute(guardPath)) return { ok: false, reason: 'standing-guard must be repo-relative, not absolute' };
  if (guardPath.split('/').includes('..')) return { ok: false, reason: 'standing-guard must not contain `..`' };
  const resolved = path.resolve(root, guardPath);
  const rootReal = fs.realpathSync(root);
  if (!fs.existsSync(resolved)) {
    // may be a staged-but-not-yet-on-disk new file
    if (stagedSet && stagedSet.has(guardPath)) return { ok: true };
    return { ok: false, reason: `standing-guard path does not exist: ${guardPath}` };
  }
  // refuse a symlink (Security M3 — a symlinked escape)
  const lst = fs.lstatSync(resolved);
  if (lst.isSymbolicLink()) return { ok: false, reason: 'standing-guard must not be a symlink' };
  const real = fs.realpathSync(resolved);
  if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
    return { ok: false, reason: 'standing-guard resolves outside the repo root' };
  }
  // git-tracked OR staged
  const rel = path.relative(rootReal, real);
  if (stagedSet && stagedSet.has(rel)) return { ok: true };
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', rel], { cwd: rootReal, stdio: 'ignore' });
    return { ok: true };
  } catch {
    return { ok: false, reason: `standing-guard is present but not git-tracked or staged: ${rel}` };
  }
}

export function validateExemption(exemption) {
  if (!exemption) return { ok: false, reason: 'exemption is empty' };
  // form: "<key> — <rationale>" or "<key>: <rationale>"
  const m = exemption.match(/^([a-z-]+)\s*[—:-]\s*(.+)$/i) || exemption.match(/^([a-z-]+)\s+(.+)$/i);
  const key = m ? m[1].toLowerCase() : exemption.toLowerCase().trim();
  const rationale = m ? m[2].trim() : '';
  if (!EXEMPTION_KEYS.includes(key)) {
    return { ok: false, reason: `exemption key must be one of ${EXEMPTION_KEYS.join(' | ')} — got "${key}"` };
  }
  if (rationale.length < EXEMPTION_RATIONALE_FLOOR) {
    return { ok: false, reason: `exemption "${key}" needs a rationale of at least ${EXEMPTION_RATIONALE_FLOOR} chars` };
  }
  return { ok: true, key, rationale };
}

// ─── the core validation ────────────────────────────────────────────────────

/**
 * Validate an audit report's content. Returns { ok: true, rounds } or
 * { ok: false, reason }. Pure — no I/O except the standing-guard git check via
 * the injected root/stagedSet. `opts.basenameSlug` is the file basename (minus
 * .md) for the basename==slug check.
 */
export function validateAuditReport(text, opts = {}) {
  const { root = process.cwd(), stagedSet = null, basenameSlug = null } = opts;
  let fm;
  try {
    fm = parseFrontmatter(text);
  } catch (e) {
    return { ok: false, reason: e.message, code: e.code };
  }
  const f = fm.fields;

  // slug charset + basename match
  const slug = f.audit || '';
  if (!SLUG_RE.test(slug)) return { ok: false, reason: `audit slug must match ${SLUG_RE} — got "${slug}"` };
  if (basenameSlug && basenameSlug !== slug) {
    return { ok: false, reason: `file basename "${basenameSlug}" must equal frontmatter audit slug "${slug}"` };
  }

  // rounds
  let rounds;
  try {
    rounds = parseRounds(text);
  } catch (e) {
    return { ok: false, reason: e.message, code: e.code || 'round-unparseable' };
  }
  if (rounds.length < 2) {
    return { ok: false, reason: `converged needs ≥2 rounds (a finding round + a confirming zero round); found ${rounds.length}` };
  }

  // per-round: search-angles + surface-delta + disposition + count cross-check
  for (const r of rounds) {
    if (!r.hasSearchAngles) return { ok: false, reason: `Round ${r.n}: missing the search-angles/commands-run record` };
    if (!r.hasSurfaceDelta) return { ok: false, reason: `Round ${r.n}: missing the surface-delta record` };
    for (const row of r.rows) {
      const d = validateDisposition(row.disposition);
      if (!d.ok) return { ok: false, reason: `Round ${r.n}: ${d.reason}` };
    }
    if (r.newFindingsLine === null) {
      return { ok: false, reason: `Round ${r.n}: missing the "New findings this round: <count>" line` };
    }
    if (r.newFindingsLine !== r.rows.length) {
      return { ok: false, reason: `Round ${r.n}: "New findings this round: ${r.newFindingsLine}" contradicts ${r.rows.length} parsed ledger row(s)` };
    }
  }

  // final round MUST be zero (line AND rows)
  const finalR = rounds[rounds.length - 1];
  if (finalR.newFindingsLine !== 0 || finalR.rows.length !== 0) {
    return { ok: false, reason: `final round (Round ${finalR.n}) must have 0 new findings; found ${finalR.rows.length} row(s) / line=${finalR.newFindingsLine}` };
  }

  // standing-guard XOR exemption
  const hasGuard = !!(f['standing-guard'] && f['standing-guard'].trim());
  const hasExemption = !!(f.exemption && f.exemption.trim());
  if (hasGuard === hasExemption) {
    return { ok: false, reason: 'exactly ONE of standing-guard / exemption must be set (XOR)' };
  }
  if (hasGuard) {
    const g = validateStandingGuard(f['standing-guard'].trim(), root, stagedSet);
    if (!g.ok) return { ok: false, reason: g.reason };
  } else {
    const x = validateExemption(f.exemption.trim());
    if (!x.ok) return { ok: false, reason: x.reason };
  }

  return { ok: true, rounds };
}

// ─── stamping (byte-idempotent) ─────────────────────────────────────────────

/**
 * Given validated report text, return the stamped text (converged:<ISO>,
 * rounds:<N>). If a VALID converged timestamp already exists and the report
 * still validates, the existing timestamp is PRESERVED (byte-idempotent re-run).
 * `nowIso` is injected so tests are deterministic and the module has no clock dep.
 */
export function stampConverged(text, roundsCount, nowIso) {
  const lines = text.split('\n');
  // operate within the first frontmatter block
  let fmEnd = -1;
  for (let i = 1; i < lines.length; i++) { if (lines[i] === '---') { fmEnd = i; break; } }
  const setField = (key, value) => {
    for (let i = 1; i < fmEnd; i++) {
      if (new RegExp(`^${key}\\s*:`).test(lines[i])) { lines[i] = `${key}: "${value}"`; return; }
    }
    lines.splice(fmEnd, 0, `${key}: "${value}"`);
    fmEnd++;
  };
  // preserve an existing non-empty converged timestamp
  let existing = null;
  for (let i = 1; i < fmEnd; i++) {
    const m = lines[i].match(/^converged\s*:\s*["']?([^"'#]*)/);
    if (m && m[1].trim()) { existing = m[1].trim(); break; }
  }
  setField('converged', existing || nowIso);
  setField('rounds', String(roundsCount));
  return lines.join('\n');
}

// ─── main ───────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { audit: null, check: false, contentFrom: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--audit') out.audit = argv[++i];
    else if (a === '--check') out.check = true;
    else if (a === '--content-from') out.contentFrom = argv[++i];
  }
  return out;
}

function resolveRoot() {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  } catch {
    return process.cwd();
  }
}

function stagedSet(root) {
  try {
    const out = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR'], { cwd: root, encoding: 'utf8' });
    return new Set(out.split('\n').map((s) => s.trim()).filter(Boolean));
  } catch {
    return new Set();
  }
}

const IS_MAIN = (() => {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch { return false; }
})();

function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = resolveRoot();

  let text, basenameSlug, auditPath;
  try {
    if (args.contentFrom) {
      text = args.contentFrom === '-'
        ? fs.readFileSync(0, 'utf8')
        : fs.readFileSync(args.contentFrom, 'utf8');
      // basename slug comes from --audit when validating a staged blob
      basenameSlug = args.audit ? path.basename(args.audit, '.md') : null;
    } else {
      if (!args.audit) { console.error('usage: --audit docs/audits/<slug>.md [--check] [--content-from <path|->]'); process.exit(2); }
      auditPath = args.audit;
      text = fs.readFileSync(auditPath, 'utf8');
      basenameSlug = path.basename(auditPath, '.md');
    }
  } catch (e) {
    console.error(`[audit-convergence] cannot read input: ${e.message}`);
    process.exit(2); // fail-closed
  }

  let result, secrets;
  try {
    secrets = scanForSecrets(text);
    result = validateAuditReport(text, { root, stagedSet: stagedSet(root), basenameSlug });
  } catch (e) {
    // any unexpected throw is fail-CLOSED with the honest escape named
    console.error(`[audit-convergence] internal error: ${e.message}`);
    console.error('  → fail-closed. Honest escape: remove the `converged:` line and commit the audit as honestly-incomplete.');
    process.exit(2);
  }

  if (secrets.length) {
    console.error('[audit-convergence] REFUSED — audit report appears to contain credential material:');
    for (const s of secrets) console.error(`  line ${s.line}: matches ${s.name} — reference path+line, NEVER quote the secret`);
    process.exit(1);
  }

  if (!result.ok) {
    console.error(`[audit-convergence] NOT converged: ${result.reason}`);
    console.error('  → an honestly-incomplete audit is fine to commit; it just cannot carry a `converged:` stamp.');
    process.exit(1);
  }

  if (args.check) {
    console.log(`[audit-convergence] OK — ${result.rounds.length} rounds, final round clean, dispositions closed.`);
    // surface the exemption banner if present (adversarial visibility)
    const fm = parseFrontmatter(text).fields;
    if (fm.exemption && fm.exemption.trim()) console.log(`[audit-convergence] EXEMPTION path: ${fm.exemption.trim()}`);
    process.exit(0);
  }

  // stamp mode: write the earned converged timestamp
  const nowIso = new Date().toISOString();
  const stamped = stampConverged(text, result.rounds.length, nowIso);
  fs.writeFileSync(auditPath, stamped);
  console.log(`[audit-convergence] stamped ${auditPath}: converged (${result.rounds.length} rounds)`);
  process.exit(0);
}

if (IS_MAIN) main();
