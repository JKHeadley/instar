#!/usr/bin/env node
/**
 * lint-deferral-referent-resolves.mjs — a tracked deferral must point at something.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * *Deferral = Deletion* says a deferral without owned follow-through is a
 * deletion. The existing guard (`instar-dev-precommit.js` step 7.5) enforces
 * that a spec containing deferral language carries a tracking marker — and it
 * has been doing that job correctly since it was written.
 *
 * But it checks that a MARKER EXISTS. It cannot check that the marker refers to
 * anything, because the commitment and evolution-action registries the markers
 * point into are PER-MACHINE RUNTIME STATE (`.instar/`), not tracked in the
 * repository. A build has no way to resolve `ACT-1153`.
 *
 * Measured 2026-08-09 across `docs/specs/`: **217 distinct tracked deferral marker ids,
 * of which 137 (63%) resolve to nothing OUTSIDE THE DOCUMENTATION TREE.**
 * (TWO earlier figures are SUPERSEDED and neither should be quoted: 178/110/62% measured
 * a narrow prose-id population; 194/104/54% measured the marker but through a character
 * class a SPACE terminates AND counted ordinary English words as identifiers. Each was
 * published before it was found wrong — the 194 figure to the operator directly. Do not
 * quote either.) For
 * those, "tracked" is an unfalsifiable claim — the exact shape the standard was
 * written to forbid, wearing a tracking number.
 *
 * This is the difference the operator asked for on 2026-08-08: a guard that
 * verifies FUNCTION rather than existence. Existence = a marker is present.
 * Function = the marker refers to something a reader can follow.
 *
 * ── What this measures, and what it certifies ──────────────────────────────
 * Declared explicitly, per *Verify the State, Not Its Symbol* tooth (D):
 *
 *   MEASURED  — every id inside a `<!-- tracked: <id> -->` MARKER in `docs/specs/`
 *               (the population the commit-time step admits, whatever its id form),
 *               and whether that id appears ANYWHERE in the repository outside
 *               `docs/` (source, tests, fixtures, config).
 *   CERTIFIED — a NEW tracked deferral points at something the repository can
 *               show a reader, rather than at machine-local state no reviewer
 *               and no build can reach.
 *
 * **It does NOT certify that the deferral was KEPT.** An id referenced by a test
 * resolves here whether the underlying work shipped, stalled, or was abandoned.
 * The honest test — did this promise reach a terminal state — requires the
 * commitment/action registries, which are runtime state outside the repo, and is
 * therefore NOT checkable at build time by anything. That residual is real and
 * is named in the standard rather than implied away by this check's existence.
 *
 * What input passes this check while failing the claim? An author who writes a
 * tracked id into a test comment and nothing else. That resolves, and follows
 * through on nothing. Naming it, not hiding it.
 *
 * Boundary worth knowing, learned by getting it wrong while proving this guard:
 * the resolving corpus is `git ls-files`, so an UNTRACKED file cannot resolve a
 * marker. That is correct — an uncommitted file is not something a reviewer can
 * follow — but it means a referent added in the same working tree does not count
 * until it is staged. My first injection test failed for exactly this reason and
 * I briefly mistook a correct refusal for a broken check.
 *
 * ── Why a baseline ─────────────────────────────────────────────────────────
 * 137 pre-existing orphans cannot be fixed by the change that discovers them —
 * each needs its referent found or the deferral honestly closed. The baseline is
 * SHRINK-ONLY: the count may never rise, so the debt can only be paid down. A
 * new orphan fails immediately.
 *
 * Exit codes: 0 — clean; 1 — a new orphan, or a baseline that grew.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkShrinkOnlyAgainstHistory } from './lib/baseline-history.mjs';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');
const JSON_OUT = process.argv.includes('--json');
const UPDATE = process.argv.includes('--update-baseline');
const BASELINE_REL = 'docs/deferral-referent-baseline.json';

/**
 * POPULATION — every id inside a tracking MARKER, which is the thing the commit-time
 * step actually admits: `<!-- tracked: <id> -->` with the SAME character class that
 * step accepts. Widened 2026-08-08 after an external review REJECTED the narrower
 * version: the original matched `CMT-\d+` / `ACT-\d+` anywhere in prose, which (a) let
 * a bare mention of an id count as a tracked deferral and (b) MISSED every marker
 * using any other id form. Measured at the moment of the fix: of 194 distinct marker
 * ids in docs/specs, only 92 were CMT/ACT-numeric — **102 (53%) were invisible to the
 * guard that claimed to police them.** A guard covering 47% of its own subject while
 * claiming the subject is the shape this whole window exists to catch.
 *
 * WIDENED AGAIN 2026-08-08, by an independent re-derivation that did not accept my number.
 * The first widening took the marker but kept the commit-time step's CHARACTER CLASS, which
 * a SPACE terminates — so every marker whose payload carries a space, comma, colon,
 * parenthesis or line break still matched nothing. Measured: 25 real, live markers were
 * invisible (`CMT-1103, CMT-1123`; `PR-495 follow-up`; `CMT-1049 (secret-store hardening,
 * topic 13481)`). So the corrected guard saw 89% of its subject while its own prose said it
 * saw the subject — the SAME over-claim the reviewer rejected at 47%, narrowed fivefold and
 * then restated. The population is now the WHOLE marker payload; resolution looks at the
 * id-shaped tokens inside it, and a payload naming NO followable token is an orphan by
 * construction, because it promises nothing a reader can chase.
 */
const MARKER_RE = /<!--\s*tracked:\s*([^>]*?)\s*-->/g;
/**
 * Id-shaped tokens INSIDE a marker payload. A payload naming none is an orphan by construction.
 *
 * MUST CONTAIN A DIGIT — corrected 2026-08-09 after review pass 5 found the previous version accepted
 * every three-character alphanumeric word, so a marker whose payload is PROSE ("a future 'swap-target
 * output sanity' hardening…") resolved through the ordinary English word `future` appearing somewhere
 * in the repository. That did not merely inflate the resolved count; it meant the guard was reporting
 * prose as a followable referent, which is the exact claim it exists to test. The reported 114-resolved
 * figure was published to the operator before this was caught.
 *
 * The digit requirement is the discriminator that separates an identifier from a word: CMT-1103,
 * PR-495, 29723 and topic-29836/close-the-loop-registrations all qualify; `future`, `swap-target` and
 * `hardening` do not. **What it misses, named rather than discovered later:** a purely alphabetic id
 * (`dedupKey=session-context-injectors-lack-compaction-parity`) is not recognised, so its marker counts
 * as an orphan. That is the safe direction — an unrecognised id is reported as debt rather than as
 * satisfied — and such an id is in any case not mechanically distinguishable from prose, which is why
 * the rule is what it is.
 */
const TOKEN_RE = /[A-Za-z0-9][A-Za-z0-9._/-]{2,}/g;
const isIdShaped = (t) => /\d/.test(t);
/** Resolving mentions may appear as bare ids anywhere outside docs/. */
const idPattern = (id) => new RegExp(`(?:^|[^A-Za-z0-9._/-])${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9._/-])`);

/** Files that may RESOLVE a marker — anything a reader can follow that is not the prose asserting it. */
function repoFiles() {
  const out = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return out.split('\n').filter(Boolean);
}

const files = repoFiles();
if (files.length === 0) {
  console.error('[deferral-referent] git ls-files returned nothing — refusing to report clean.');
  process.exit(1);
}

const specFiles = files.filter((f) => f.startsWith('docs/specs/') && f.endsWith('.md'));
// A marker is RESOLVED by a mention outside the spec prose. Docs are excluded from the
// resolving set on purpose: one document citing another's promise is not follow-through,
// it is the same claim repeated.
// PROSE AND COMMENTARY DO NOT RESOLVE A REFERENT — review pass 6, defect (d):
//   "A concrete circular pass exists now: `PR-495 follow-up` resolves only because `PR-495` is
//    repeated in this lint's own explanatory comments and the window's side-effects narrative."
// The repo's proven answer to "does this reference point at something real" is `auditRef` +
// `auditSha256` in standards-coverage.mjs: a jailed path PLUS a hash of the bytes it names. That
// shape cannot be retrofitted to 217 marker sites here, so this adopts its PRINCIPLE instead:
// a referent must occur somewhere EXECUTABLE OR STRUCTURED — code, tests, fixtures, config — and
// never in prose or in a comment, because prose that merely discusses an id is the same claim
// repeated. Concretely: every `.md` is excluded (not just `docs/`), and comment bodies are
// stripped from source files before scanning. **Named limit:** this is weaker than path+hash. A
// marker still resolves on a bare mention in code rather than on a proven link to its
// follow-through, so the stronger form remains the real fix and is dated on the article.
const PROSE_EXT = /\.(md|mdx|txt)$/i;
const resolvingFiles = files.filter((f) => !f.startsWith('docs/') && !f.includes('node_modules/') && !PROSE_EXT.test(f));

/** Strip comment bodies so a guard's own explanation cannot resolve what it measures. */
function withoutComments(text, rel) {
  if (/\.(m?[jt]sx?|c[jt]s)$/i.test(rel)) {
    return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
  }
  if (/\.(ya?ml|sh|bash|zsh|toml|conf)$/i.test(rel) || !rel.includes('.')) {
    return text.replace(/(^|\s)#[^\n]*/g, '$1 ');
  }
  return text;
}

const declared = new Map(); // id -> Set(spec paths)
for (const rel of specFiles) {
  let text;
  try { text = fs.readFileSync(path.join(ROOT, rel), 'utf-8'); } catch { continue; }
  // Strip fenced blocks first. A marker QUOTED inside a fence is being displayed — in an archived
  // review verdict, a syntax example, a transcript — not declared as this repository's own deferral.
  // Discovered immediately: archiving the reviewers' verbatim answers made one of THEIR example
  // markers a live orphan of mine, which is a document acquiring a promise by quoting one.
  const scanned = text.replace(/^(?:```|~~~)[\s\S]*?^(?:```|~~~)\s*$/gm, '');
  MARKER_RE.lastIndex = 0;
  let m;
  while ((m = MARKER_RE.exec(scanned)) !== null) {
    const id = m[1].replace(/\s+/g, ' ').trim();
    if (!id) continue;
    if (!declared.has(id)) declared.set(id, new Set());
    declared.get(id).add(rel);
  }
}

if (declared.size === 0) {
  console.error('[deferral-referent] parsed ZERO tracked deferral ids — the matcher is broken; refusing to report clean.');
  process.exit(1);
}

// One pass over the resolving corpus rather than one grep per id.
const resolved = new Set();
// A marker resolves when ANY id-shaped token in its payload resolves. A payload with no such
// token can never resolve — it names nothing followable, which is the condition, not a parser gap.
const wanted = [...declared.keys()]
  .map((id) => ({ id, tokens: (id.match(TOKEN_RE) ?? []).filter(isIdShaped).map((t) => idPattern(t)) }))
  .filter((w) => w.tokens.length > 0);
for (const rel of resolvingFiles) {
  let text;
  try { text = withoutComments(fs.readFileSync(path.join(ROOT, rel), 'utf-8'), rel); } catch { continue; }
  for (const w of wanted) {
    if (resolved.has(w.id)) continue;
    if (w.tokens.some((re) => re.test(text))) resolved.add(w.id);
  }
}

const orphans = [...declared.keys()].filter((id) => !resolved.has(id)).sort();

const abs = path.join(ROOT, BASELINE_REL);
let baseline = null;
if (fs.existsSync(abs)) {
  try { baseline = JSON.parse(fs.readFileSync(abs, 'utf-8')); } catch { baseline = null; }
}

if (UPDATE) {
  fs.writeFileSync(abs, `${JSON.stringify({
    schemaVersion: 1,
    note: 'Tracked deferral ids that resolve to nothing outside the prose declaring them. SHRINK-ONLY: this list may lose entries as referents are found or deferrals honestly closed, and may never gain one. See scripts/lint-deferral-referent-resolves.mjs.',
    measuredAt: new Date().toISOString().slice(0, 10),
    orphans,
  }, null, 2)}\n`);
  console.log(`[deferral-referent] baseline written: ${orphans.length} orphan(s) of ${declared.size} tracked id(s).`);
  process.exit(0);
}

const failures = [];
const baselineSet = new Set(Array.isArray(baseline?.orphans) ? baseline.orphans : []);

if (!baseline) {
  failures.push(`${BASELINE_REL} is missing or unparseable — run with --update-baseline to establish it. Refusing to report clean without a baseline to ratchet against.`);
} else {
  const added = orphans.filter((id) => !baselineSet.has(id));
  for (const id of added) {
    const where = [...(declared.get(id) ?? [])].join(', ');
    failures.push(
      `${id} is tracked as a deferral in ${where} but resolves to NOTHING outside the documentation tree (docs/ is deliberately excluded: one document citing another's promise is the same claim repeated, not follow-through). ` +
      `A tracking marker that refers to machine-local state no build and no reviewer can reach is an ` +
      `unfalsifiable promise — the deletion this standard forbids, wearing a tracking number. Point it at ` +
      `something OUTSIDE docs/ that a reader can follow — a test, the code that implements it, a fixture, a config ` +
      `entry. A mention in another document does NOT resolve it: one document citing another's promise is the same ` +
      `claim repeated, not follow-through. Otherwise, close the deferral honestly.`,
    );
  }
  if (orphans.length > baselineSet.size) {
    failures.push(`orphan count rose from ${baselineSet.size} to ${orphans.length} — the baseline is shrink-only.`);
  }
  // The ratchet's reference point must be ACCEPTED HISTORY, not the same commit's own baseline file.
  failures.push(...checkShrinkOnlyAgainstHistory({
    relPath: BASELINE_REL, cwd: ROOT, field: 'orphans', current: [...baselineSet],
    label: 'deferral orphan baseline', envPrefix: 'DEFERRAL_REFERENT',
  }));
}

const report = {
  trackedIds: declared.size,
  resolved: declared.size - orphans.length,
  orphans: orphans.length,
  baseline: baselineSet.size,
  failures,
};

if (JSON_OUT) {
  console.log(JSON.stringify(report, null, 2));
} else if (failures.length === 0) {
  console.log(
    `lint-deferral-referent-resolves: clean — ${declared.size} tracked deferral id(s), ` +
    `${report.resolved} resolve, ${orphans.length} orphaned (baseline ${baselineSet.size}, shrink-only).`,
  );
}

if (failures.length > 0) {
  console.error('\n❌ lint-deferral-referent-resolves failed:');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
