// safe-git-allow: lint runs read-only `git diff --cached` to scope the ratchet to newly-added markers; no mutation, and it must work before TypeScript is compiled.
/**
 * lint-deferral-carrier-resolvable — every deferral marker must name a carrier
 * a reader can CHECK, offline, without API access.
 *
 * WHY THIS EXISTS. The pre-commit hook refuses an ORPHAN deferral (no
 * `<!-- tracked: ... -->` within 200 chars), but that is a REGEX over the
 * marker's SHAPE, so it accepts a nonexistent id (`CMT-999999`), a garbage
 * token (`zzz`), and — the one that keeps happening — a REAL id whose text does
 * not cover this deferral. That defect has recurred NINE times on one spec,
 * survived three prose corrections and three separate "structural fix" claims.
 *
 * WHAT IT CHECKS, AND WHAT IT DELIBERATELY DOES NOT.
 *
 * It checks RESOLVABILITY: each marker's id must have an inlined frozen excerpt
 * of the carrier's immutable text in the same document. That is objective and
 * cheap, and it is what makes coverage checkable by a reviewer who has only the
 * document — the exact gap a round-16 external review identified.
 *
 * It does NOT check that the carrier's text is ABOUT the deferral, and this is
 * a measured decision rather than an omission. Two similarity metrics were
 * built and tested against real markers plus deliberately-planted wrong ones:
 *
 *   - CONTENT-WORD OVERLAP: genuine markers scored 1-2 shared words; a planted
 *     WRONG carrier scored 3-8. Inverted, because a long carrier overlaps
 *     everything — the metric measures carrier LENGTH, not relatedness.
 *   - RARE-WORD MATCHING (words appearing <=8 times in the document): many
 *     CORRECT markers scored 0 hits while wrong ones scored 2-4. A spec
 *     PARAPHRASES its obligation; the commitment states it in its own words, so
 *     the two legitimately share little distinctive vocabulary.
 *
 * Neither separates the classes, so no threshold exists that would block the
 * wrong carrier without blocking genuine ones. Shipping a gate that CLAIMS to
 * verify relatedness on either metric would be a check whose passing condition
 * is narrower than what it certifies — the exact class this project has found
 * eleven times, committed inside the fix for a related class. Semantic coverage
 * therefore stays an explicit REVIEWER responsibility, and this lint says so
 * rather than implying it is handled.
 *
 * Per docs/signal-vs-authority.md: a check holding blocking authority must be
 * predictable rather than clever. Resolvability is; similarity is not.
 *
 * EXIT: 0 clean, 1 with --enforce when a marker has no inlined excerpt.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const enforce = args.includes('--enforce');
const specArgIdx = args.indexOf('--spec');
/**
 * SCOPE — round-18, and the scoping IS the design decision.
 *
 * Run with `--enforce` across every spec, this fails 624 of 655 markers: the
 * inlined-excerpt convention exists on exactly one document. Enforcing it
 * repo-wide would retroactively impose a new convention on every spec written
 * before it and block all work — a gate that stops the line on its first run is
 * not a stronger gate, it is a broken one, and the pressure would be to delete
 * it rather than satisfy it.
 *
 * So: `--staged` enforces on the spec files in THIS commit (the shape
 * `lint-migration-consumer-completeness.js --staged` already uses in the
 * pre-commit hook), while a bare run reports the whole-repo backlog as
 * advisory. New work carries the convention; existing documents are a visible
 * backlog rather than a wall.
 */
/**
 * Specs in scope for the ratchet — round-19.
 *
 * `--staged` alone made this VACUOUS IN CI, which is the one place it matters:
 * after a fresh checkout nothing is staged, so it printed `clean — 0 marker(s)`
 * and exited 0 — byte-identical to a real pass. Verified by reconstructing a CI
 * checkout. The same happened when `git` itself errored. A dead run that
 * renders as a clean run is the exact class this project keeps paying for, and
 * it shipped inside the gate built to stop a related one.
 *
 * VERIFICATION STATUS, stated because this file is about not overclaiming:
 * the FILE-scope fallback is demonstrated (a reconstructed CI checkout finds 3
 * specs where the staged path found 0). The MARKER-scope sharing that basis is
 * reasoned and syntax-checked but NOT proven end-to-end — demonstrating it
 * needs a committed marker, and the branch this shipped on carries the marker
 * work uncommitted, so a CI-shaped run correctly reports 0 added markers.
 * Treat the CI teeth as argued, not measured, until a PR exercises it.
 *
 * So: prefer the staged set (the pre-commit case); fall back to the PR's diff
 * against the merge base (the CI case), which preserves the ratchet's intent —
 * only markers this change introduces — while giving it teeth where local hooks
 * cannot run. `null` means "could not determine scope", which is NOT the same
 * as "nothing in scope" and is reported as such.
 */
function specsInScope() {
  const pick = (out) =>
    out.split('\n').filter((f) => f.startsWith('docs/specs/') && f.endsWith('.md') && fs.existsSync(f));
  try {
    const staged = pick(
      execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACM'], { encoding: 'utf8' }),
    );
    if (staged.length > 0) return { specs: staged, basis: 'staged' };
  } catch {
    return { specs: null, basis: 'git-unavailable' };
  }
  // CI: nothing staged. Compare against the merge base so the PR's own added
  // markers are still checked.
  for (const base of ['origin/main', 'main']) {
    try {
      const mb = execFileSync('git', ['merge-base', base, 'HEAD'], { encoding: 'utf8' }).trim();
      if (!mb) continue;
      return { specs: pick(execFileSync('git', ['diff', '--name-only', `${mb}...HEAD`], { encoding: 'utf8' })), basis: `merge-base:${base}` };
    } catch {
      // try the next base name
    }
  }
  return { specs: null, basis: 'no-merge-base' };
}

/**
 * The markers ADDED by this commit, per file — a shrink-only ratchet.
 *
 * Scoping to touched FILES was still too broad: editing one table in a spec
 * written before this convention demanded retrofitting that file's other 13
 * markers, which punishes an unrelated edit and makes the gate something to
 * route around. Only NEW markers are held to the convention; existing ones are
 * the visible backlog the advisory whole-repo run reports.
 */
function addedMarkerIdsFor(file, basis) {
  try {
    // ROUND-19, second half: the FILE scoping was given a merge-base fallback
    // for CI and this MARKER scoping was left on `--cached`, so in CI it found
    // the right files and then skipped every marker in them — reporting
    // `0 marker(s)` as clean. Fixing one half of a scoping bug and leaving the
    // sibling is the partial-fix shape this project keeps hitting; both halves
    // must share a basis or the pair is incoherent.
    const range = basis && basis.startsWith('merge-base:')
      ? [`${execFileSync('git', ['merge-base', basis.slice('merge-base:'.length), 'HEAD'], { encoding: 'utf8' }).trim()}...HEAD`]
      : ['--cached'];
    const diff = execFileSync('git', ['diff', ...range, '-U0', '--', file], { encoding: 'utf8' });
    const ids = new Set();
    for (const line of diff.split('\n')) {
      if (!line.startsWith('+') || line.startsWith('+++')) continue;
      for (const m of line.matchAll(/<!--\s*tracked:\s*([A-Za-z0-9._/-]+)\s*-->/g)) ids.add(m[1]);
    }
    return ids;
  } catch {
    return null; // unknown ⇒ check everything (fail toward MORE checking)
  }
}

const scoped = args.includes('--staged') ? specsInScope() : null;
const specs = specArgIdx >= 0 && args[specArgIdx + 1]
  ? [args[specArgIdx + 1]]
  : scoped
    ? (scoped.specs ?? [])
    : fs.existsSync('docs/specs')
      ? fs.readdirSync('docs/specs').filter((f) => f.endsWith('.md')).map((f) => path.join('docs/specs', f))
      : [];

const MARKER = /<!--\s*tracked:\s*([A-Za-z0-9._/-]+)\s*-->/g;
/** Frozen excerpts inlined in the doc: `**CMT-1317** — "..."` inside a blockquote. */
function collectInlinedExcerpts(content) {
  const map = new Map();
  const re = /\*\*(CMT-\d+)\*\*\s*[—-]\s*([\s\S]{0,2000}?)(?=\n>\s*\n>\s*\*\*CMT-|\n\n)/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    const existing = map.get(m[1]) ?? '';
    map.set(m[1], existing + ' ' + m[2]);
  }
  return map;
}

/**
 * Carrier ledgers — round-19.
 *
 * A reviewer defeated the excerpt requirement by TYPING one: a staged spec
 * containing an invented `**CMT-999999** — "I hereby carry this obligation"`
 * blockquote passed with exit 0 and printed "clean — 32 markers, each resolving
 * to an inlined carrier excerpt", while the API returns "not found" for that
 * id. The remedy this gate teaches — inline an excerpt — was hand-authored
 * prose nothing validated, and the clean message then reads to a human as
 * verification.
 *
 * So marker ids are now checked against a GENERATED ledger under
 * docs/specs/carriers/*.json, refreshed from the live registry and checked in.
 * A fabricated id fails because it is absent from the ledger, and the ledger
 * cannot be satisfied by typing into the spec. Semantic coverage is still NOT
 * checked — see the header — this closes existence only, which is the half a
 * machine can actually decide.
 */
function loadCarrierLedger() {
  const dir = 'docs/specs/carriers';
  const known = new Set();
  // ROUND-20: an ABSENT ledger no longer silently disarms the existence check.
  //
  // Round-19 shipped this returning `present:false` when the directory was
  // missing — and the directory was UNTRACKED, so in any fresh checkout the
  // check skipped and the exact fabricated-marker bypass it was built to stop
  // passed with `clean … exit 0`. The header claimed the ledger was "checked
  // in"; it was not. A claim whose carrier does not exist, inside the gate
  // written to catch claims whose carriers do not exist.
  //
  // `absent` is now distinct from `present:false`: a repo that has never
  // adopted a ledger is a legitimate no-op, but a repo whose specs USE
  // CMT-markers and has no ledger is a disarmed gate, and the caller refuses
  // rather than reporting clean.
  if (!fs.existsSync(dir)) return { known, present: false, absent: true };
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      for (const id of Object.keys(j.carriers ?? {})) known.add(id);
    } catch {
      // A corrupt ledger must not silently disarm the check.
      return { known, present: false, corrupt: f };
    }
  }
  return { known, present: known.size > 0 };
}

/**
 * Table ↔ marker symmetry — round-19.
 *
 * A spec may carry a "marker table" mapping deferred items to carriers. It has
 * now drifted in BOTH directions two rounds running (markers with no row,
 * including a launch blocker; a row whose marker was retired), and both times a
 * human sweep missed what a set-difference finds instantly.
 *
 * Building this immediately rather than filing it, because the pattern that
 * kept this defect class alive for ten instances is exactly "correct the
 * instance, leave the mechanical check unbuilt". A row with no marker is
 * ALLOWED (an obligation can be genuinely row-only) but must be declared with
 * `row-only:` prose naming the id, so the asymmetry is a decision rather than
 * drift. A marker with no row is always a defect: the table claims to be the
 * checkable index and silently is not.
 */
function tableSymmetry(content, markerIds) {
  const rows = new Set([...content.matchAll(/\|\s*(CMT-\d+)\s*\|/g)].map((m) => m[1]));
  if (rows.size === 0) return { skipped: true };
  const missingRow = [...markerIds].filter((id) => !rows.has(id));
  const missingMarker = [...rows].filter(
    (id) => !markerIds.has(id) && !new RegExp(`row-only[^\n]{0,200}${id}|${id}[^\n]{0,200}row-only`).test(content),
  );
  return { missingRow, missingMarker, skipped: false };
}

const ledger = loadCarrierLedger();
let checked = 0;
let unresolved = 0;
let unknownId = 0;
const asymmetry = [];

const ratchet = args.includes('--staged');
for (const specPath of specs) {
  const content = fs.readFileSync(specPath, 'utf8');
  if (!/<!--\s*tracked:/.test(content)) continue;
  const onlyNew = ratchet ? addedMarkerIdsFor(specPath, scoped?.basis) : null;
  const excerpts = collectInlinedExcerpts(content);
  const seenIds = new Set();
  const allIds = new Set();
  MARKER.lastIndex = 0;
  let m;
  while ((m = MARKER.exec(content)) !== null) {
    const id = m[1];
    // ROUND-20: record EVERY marker for the symmetry check before the ratchet
    // filter, because the two checks answer different questions.
    //
    // The ratchet asks "is this marker NEW in this change?" (correctly scoped
    // to added lines). Symmetry asks "does the table match the body?" — a
    // whole-document property. Round-19 populated `seenIds` AFTER the ratchet
    // filter, so symmetry compared the FULL table against a filtered subset and
    // reported committed markers as missing from the body. Measured: adding one
    // correct new marker to a spec with two committed ones produced two false
    // "table row has NO in-body marker" errors, against markers provably
    // present. Two checks I added in the same round, disagreeing about what
    // `seenIds` means.
    allIds.add(id);
    if (onlyNew && !onlyNew.has(id)) continue;
    checked++;
    // The deferral's own sentence: text preceding the marker, back to the
    // previous blank line (bounded), which is where the obligation is stated.
    const before = content.slice(Math.max(0, m.index - 900), m.index);
    const sentence = before.split(/\n\s*\n/).pop() ?? before;

    // Existence against the generated ledger — the half a fabricated excerpt
    // cannot satisfy. Skipped when no ledger is present, so this cannot break
    // specs in repos that have not adopted one.
    if (ledger.absent && id.startsWith('CMT-')) {
      unknownId++;
      console.log(
        `  ${specPath}: marker '${id}' cannot be checked — no carrier ledger exists under `
          + `docs/specs/carriers/. Generate one with scripts/refresh-carrier-ledger.mjs and COMMIT it; `
          + `an uncommitted ledger disarms this check in every fresh checkout.`,
      );
      continue;
    }
    if (ledger.present && id.startsWith('CMT-') && !ledger.known.has(id)) {
      unknownId++;
      console.log(
        `  ${specPath}: marker '${id}' is NOT in any carrier ledger under docs/specs/carriers/ — `
          + `an inlined excerpt alone cannot establish that a commitment exists.`,
      );
      continue;
    }
    seenIds.add(id);
    const carrierText = excerpts.get(id);
    if (!carrierText) {
      unresolved++;
      console.log(
        `  ${specPath}: marker '${id}' has NO inlined frozen excerpt in this document — `
          + `a reader cannot check the carrier covers this deferral without API access.`,
      );
      continue;
    }
  }
  const sym = tableSymmetry(content, allIds);
  if (!sym.skipped) {
    for (const id of sym.missingRow) {
      asymmetry.push(`${specPath}: marker '${id}' has NO row in the marker table — the table claims to be the checkable index and silently is not.`);
    }
    for (const id of sym.missingMarker) {
      asymmetry.push(`${specPath}: table row '${id}' has NO in-body marker and is not declared row-only — its obligations are invisible to any mechanical sweep.`);
    }
  }
}

const label = 'lint-deferral-carrier-resolvable';
// Round-19: an INSPECTED-NOTHING run must never render as a clean run.
if (asymmetry.length > 0) {
  for (const line of asymmetry) console.log(`  ${line}`);
  console.log(`${label}: ${asymmetry.length} marker-table asymmetr${asymmetry.length === 1 ? 'y' : 'ies'}.`);
  if (enforce) process.exit(1);
}
if (unknownId > 0) {
  console.log(`${label}: ${unknownId} marker(s) name an id absent from the carrier ledger.`);
  if (enforce) process.exit(1);
}
if (ledger.corrupt) {
  console.log(`${label}: carrier ledger ${ledger.corrupt} is unparseable — NOT clean, existence unchecked.`);
  if (enforce) process.exit(1);
}
if (scoped && scoped.specs === null) {
  // ROUND-20: return here rather than falling through, so a run that inspected
  // NOTHING cannot also print the clean summary below. Without --enforce the
  // round-19 version printed both, which is the "dead run renders as a clean
  // run" shape one line apart from the message denying it.
  console.log(`${label}: could not determine scope (${scoped.basis}) — NOT clean, nothing was inspected.`);
  process.exit(enforce ? 1 : 0);
}
if (scoped && Array.isArray(scoped.specs) && scoped.specs.length === 0) {
  console.log(`${label}: no specs in scope (${scoped.basis}) — nothing to check.`);
}
if (unresolved > 0) {
  console.log(
    `${label}: ${unresolved} marker(s) of ${checked} have NO inlined frozen excerpt — `
      + `a reviewer cannot check the carrier covers the deferral without API access.`,
  );
  if (enforce) process.exit(1);
  console.log('  (advisory — pass --enforce to block)');
} else {
  console.log(
    `${label}: clean — ${checked} marker(s), each resolving to an inlined carrier excerpt. `
      + `NOTE: this verifies the carrier is CHECKABLE, not that it COVERS the deferral — `
      + `semantic coverage is the reviewer's job (see the header for why no similarity `
      + `metric was shippable).`,
  );
}
