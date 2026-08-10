/**
 * baseline-history.mjs — a ratchet must compare against a PINNED accepted base, not a branch name.
 *
 * ── Why this file was rewritten rather than patched ────────────────────────
 * The first version ran `git show origin/main:<path>` from inside the lint. Review pass 6:
 *
 *   "The 'accepted base' is not reliably the accepted change boundary. It defaults to mutable
 *    `origin/main`, while the lint CI job neither fetches full history nor supplies the event's
 *    protected base SHA... On a main-branch checkout, `origin/main` can instead denote the commit
 *    under test, recreating self-comparison. The repository already demonstrates the correct
 *    pattern elsewhere in ci.yml, where protected base SHAs are supplied explicitly."
 *
 * Right on both counts, and the second is the one that mattered: **the pattern already existed and
 * I invented a weaker one instead of reading it.** Three consecutive waves of invented fixes each
 * opened a new hole in the fix machinery. This file now COPIES the proven shape used by
 * `standards-coverage.mjs` together with the `area-audit-base` step in `.github/workflows/ci.yml`:
 *
 *   1. CI resolves a PINNED base SHA from the event
 *      (`pull_request.base.sha || github.event.before || <sha>^`) — never a branch name.
 *   2. CI extracts the base copy of each baseline file to `$RUNNER_TEMP` and exports
 *      `<PREFIX>_BASE_FILE` plus `<PREFIX>_BASE_REQUIRED` (1 when the file existed at that SHA).
 *   3. This module reads the FILE. It never invokes git, so no ambient ref can fool it and it needs
 *      no destructive-tool allowlist entry.
 *   4. `REQUIRED=0` is CI ASSERTING the file genuinely did not exist at the base — an ESTABLISHING
 *      baseline. An absent env var is "nobody bound a base", a different thing, and fails closed.
 *
 * ── The append-only log is now HASH-CHAINED, also copied ───────────────────
 * Pass 6 found the previous rebaseline log was not append-only in any enforceable sense: it
 * returned before checking for deleted rows whenever the list had not grown, and when it had, any
 * row with a truthy date and a 40-character reason authorised every addition.
 *
 * `src/threadline/ThreadLog.ts` already solves this in production with a hash chain —
 * `hash = sha256(prevHash + canonical(entry-without-hash))`, verified from an anchor, reporting the
 * first broken index. That shape is copied here, and it is strictly stronger than the base
 * comparison it replaces: deleting, reordering or editing ANY earlier row breaks the chain inside
 * the file itself, with no base ref needed.
 *
 * ── Evidence and dates validated the way this repo already validates them ──
 * Copied from `standards-coverage.mjs`'s protected-base ledger reader: dates checked by round-trip
 * (`new Date(v).toISOString()` must reproduce the input) with a future clamp, and a referent
 * expressed as a JAILED, normalised repo-relative path plus the sha256 of the bytes it points at —
 * not a free string. `evidence: true` and `9999-99-99` both fail by construction rather than by a
 * bespoke check I would have had to think of.
 *
 * ── What this measures, and what it certifies ──────────────────────────────
 *   MEASURED  — the baseline's entries at HEAD against the same file at the CI-pinned base SHA;
 *               the internal hash-chain integrity of its rebaselines log; and each row's date,
 *               counts and evidence shape.
 *   CERTIFIED — an entry cannot be added to a shrink-only list, and a row cannot be removed from or
 *               edited into the rebaseline history, without breaking a check.
 *
 * **It does NOT certify that a reason is honest**, or that the counts a row states are the counts
 * that actually occurred. A hash chain protects the record's integrity, not its truthfulness.
 * Named here because the previous version of this file claimed more than it delivered, twice.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const canonicalText = (v) => v.replace(/\r\n?/g, '\n');
const sha256 = (v) => crypto.createHash('sha256').update(canonicalText(v)).digest('hex');

/**
 * Is this a real calendar date? Copied from standards-coverage.mjs: a date that round-trips is real.
 *
 * SPLIT INTO TWO POLICIES over ONE definition of "real", after review pass 15 found that the single
 * combined function was being used for a field it cannot serve. The round-trip test below is the
 * shared definition; the two exported wrappers apply the opposite time policies, and neither
 * re-implements the parsing — which is the failure mode this repository has now paid for twice.
 */
function roundTripsAsDate(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) return false;
  return date;
}

/** A date that HAS ALREADY HAPPENED. For recording history — when something was measured or swept. */
export function canonicalDate(value) {
  const date = roundTripsAsDate(value);
  if (!date) return false;
  return date.getTime() <= Date.now() + 24 * 60 * 60 * 1000; // no future-dated history
}

/**
 * A real date with NO past-or-future policy. For a FORWARD-LOOKING field — a deadline, a countdown.
 *
 * Review pass 15 found `canonicalDate` guarding `gap.countdown`, which is a deadline. Because that
 * function refuses anything beyond now+24h, an unswept gap could only ever be dated TODAY, so leg (4)
 * of the sweep guard's contract — "an unswept gap is legal, provided it is visibly unswept and dated"
 * — described a state that could not persist for more than a day. Worse, the refusal it produced said
 * the countdown was "not a YYYY-MM-DD date" for `2026-09-07`, which is exactly a YYYY-MM-DD date and
 * is the very value every other countdown in this repository uses; the author was sent to fix a format
 * that was already correct. A history validator reused for a deadline, with a diagnostic that named
 * the wrong reason — the arm was unreachable AND it misdirected on the way.
 *
 * The expiry decision stays with the CALLER, which is where the sibling `lint-documented-only-countdown`
 * already puts it: validate the shape here, compare against today there. Same division, one date rule.
 */
export function canonicalFutureDate(value) {
  return roundTripsAsDate(value) !== false;
}

/**
 * A referent is a JAILED repo-relative path plus the sha256 of its bytes — the shape
 * `standards-coverage.mjs` already requires of `auditRef`/`auditSha256`. A free string cannot be
 * evidence: `evidence: true` is not a thing that can be checked, and the previous version took it.
 */
export function validateEvidenceRef(ev, cwd) {
  if (!ev || typeof ev !== 'object') return 'evidence must be an object {ref, sha256}';
  const { ref, sha256: want } = ev;
  if (typeof ref !== 'string' || ref.length === 0) return 'evidence.ref must be a repo-relative path';
  if (ref.includes('\\') || ref.startsWith('/') || path.posix.normalize(ref) !== ref || ref.split('/').includes('..')) {
    return `evidence.ref "${ref}" is not a normalised, jailed repo-relative path`;
  }
  if (typeof want !== 'string' || !SHA256_RE.test(want)) return 'evidence.sha256 must be a 64-hex digest';
  let bytes;
  try { bytes = fs.readFileSync(path.join(cwd, ref), 'utf-8'); } catch { return `evidence.ref "${ref}" does not exist`; }
  const got = sha256(bytes);
  if (got !== want) return `evidence.ref "${ref}" hashes to ${got.slice(0, 12)}…, not the recorded ${want.slice(0, 12)}…`;
  return null;
}

/** The canonical bytes a rebaseline row hashes over — everything except the hash itself. */
function canonicalRow(row) {
  return JSON.stringify({ at: row?.at, from: row?.from, to: row?.to, reason: row?.reason, evidence: row?.evidence ?? null });
}

/** Copied from ThreadLog: hash = sha256(prevHash + canonical(entry-without-hash)). */
export function chainHash(prevHash, row) {
  return sha256(String(prevHash) + canonicalRow(row));
}

export const CHAIN_ROOT = '0'.repeat(64);

/**
 * Verify the rebaselines log is a well-formed hash chain. Deleting, reordering or editing ANY
 * earlier row breaks it — no base ref required, which is why this is stronger than the base
 * comparison it replaces.
 */
export function verifyRebaselineChain(rows, cwd) {
  const failures = [];
  let prev = CHAIN_ROOT;
  rows.forEach((row, i) => {
    if (!canonicalDate(row?.at)) {
      failures.push(`rebaselines[${i}].at is ${JSON.stringify(row?.at)} — not a real, non-future YYYY-MM-DD date.`);
    }
    if (!Number.isInteger(row?.from) || !Number.isInteger(row?.to)) {
      failures.push(`rebaselines[${i}] must record integer from/to counts; got ${JSON.stringify(row?.from)} → ${JSON.stringify(row?.to)}.`);
    }
    if (typeof row?.reason !== 'string' || row.reason.trim().length < 40) {
      failures.push(`rebaselines[${i}].reason must be a string of at least 40 characters — a one-word reason is not a reason.`);
    }
    if (row?.evidence !== undefined && row?.evidence !== null) {
      const err = validateEvidenceRef(row.evidence, cwd);
      if (err) failures.push(`rebaselines[${i}].evidence — ${err}`);
    }
    const want = chainHash(prev, row ?? {});
    if (row?.hash !== want) {
      failures.push(
        `rebaselines[${i}] breaks the hash chain: recorded ${String(row?.hash).slice(0, 12)}…, computed ` +
        `${want.slice(0, 12)}…. The log is append-only and chained (the shape src/threadline/ThreadLog.ts uses in ` +
        `production): deleting, reordering or editing any earlier row breaks it here.`,
      );
      prev = typeof row?.hash === 'string' ? row.hash : want; // keep walking; report the FIRST break
    } else {
      prev = want;
    }
  });
  return failures;
}

/**
 * Read a baseline's PINNED base copy from the file CI extracted.
 *
 * Four outcomes, kept distinct because collapsing them is how "unknown" becomes "clean":
 *   present            — the base copy exists and was read.
 *   establishing       — CI asserted (REQUIRED=0) the file did not exist at the base SHA.
 *   local-unbound      — no base env at all: a LOCAL run. Permissive, exactly as the proven
 *                        pattern is, because the ratchet is a CI-TIME guarantee. Stated plainly:
 *                        **a clean local run does not verify the shrink-only claim.**
 */
export function readPinnedBase(envPrefix) {
  const file = process.env[`${envPrefix}_BASE_FILE`];
  if (process.env[`${envPrefix}_BASE_REQUIRED`] === '0') return { kind: 'establishing' };
  if (!file) {
    // COPIED FAITHFULLY from standards-coverage.mjs's readBaseAreaAuditLedger: with no base env at
    // all this is a LOCAL run, and the check is permissive. The ratchet is a CI-TIME guarantee — CI
    // always sets both vars, so absence there is impossible. My first instinct was to fail closed
    // locally, which would have broken every local commit and ended with the opt-out set
    // permanently — a stricter-looking rule that decays into a weaker one. The proven pattern is
    // the right trade and it is copied rather than improved.
    return { kind: 'local-unbound' };
  }
  try { return { kind: 'present', text: fs.readFileSync(file, 'utf-8') }; } catch (err) {
    return { kind: 'unreadable', reason: String(err.message).split('\n')[0] };
  }
}

function readCurrentDoc(relPath, cwd) {
  try { return JSON.parse(fs.readFileSync(path.join(cwd, relPath), 'utf-8')); } catch { return null; }
}


/** Compare a shrink-only id list against its PINNED accepted base. */
export function checkShrinkOnlyAgainstHistory({ relPath, cwd, field, current, label, envPrefix }) {
  const failures = [];
  const doc = readCurrentDoc(relPath, cwd);
  failures.push(...verifyRebaselineChain(Array.isArray(doc?.rebaselines) ? doc.rebaselines : [], cwd));

  const base = readPinnedBase(envPrefix);
  if (base.kind === 'local-unbound') return failures; // local run: CI owns this guarantee
  if (base.kind === 'unreadable') {
    failures.push(`${relPath} — the pinned base copy could not be read (${base.reason}); refusing to report clean.`);
    return failures;
  }
  if (base.kind === 'establishing') {
    if (!doc?.measuredAt) {
      failures.push(`${relPath} — CI reports this file did not exist at the base, but it carries no measuredAt. An establishing baseline must date itself.`);
    }
    return failures;
  }

  let baseDoc;
  try { baseDoc = JSON.parse(base.text); } catch (err) {
    failures.push(`${relPath} — the pinned base copy is unparseable (${err.message}); refusing to report clean.`);
    return failures;
  }

  const baseRows = Array.isArray(baseDoc?.rebaselines) ? baseDoc.rebaselines : [];
  const headRows = Array.isArray(doc?.rebaselines) ? doc.rebaselines : [];
  if (headRows.length < baseRows.length) {
    failures.push(`${relPath} — the rebaselines log SHRANK (${baseRows.length} rows at the pinned base, ${headRows.length} now). It is append-only.`);
  } else {
    for (let i = 0; i < baseRows.length; i += 1) {
      // CHAIN GENESIS, bounded: a base row carrying NO hash predates the chain, so stamping one is
      // genesis rather than tampering. Everything else about the row must be unchanged. Found by
      // running the real CI binding end-to-end: introducing a chain necessarily rewrites the
      // pre-chain rows once, and a check that cannot tell genesis from tampering would have made
      // the migration impossible or the rule permanently red.
      if (typeof baseRows[i]?.hash !== 'string') {
        const { hash: _h, ...headRest } = headRows[i] ?? {};
        const { hash: _b, ...baseRest } = baseRows[i] ?? {};
        if (JSON.stringify(headRest) !== JSON.stringify(baseRest)) {
          failures.push(`${relPath} — rebaselines[${i}] predates the hash chain, but its CONTENT changed while being stamped. Genesis may add a hash and nothing else.`);
          break;
        }
        continue;
      }
      if (headRows[i]?.hash !== baseRows[i]?.hash) {
        failures.push(`${relPath} — rebaselines[${i}] was REWRITTEN since the pinned base (hash changed). Earlier history is immutable.`);
        break;
      }
    }
  }

  const baseIds = new Set(Array.isArray(baseDoc?.[field]) ? baseDoc[field] : []);
  const added = current.filter((id) => !baseIds.has(id));
  if (added.length === 0) return failures;

  // EXACT admission (review pass 8): the old rule accepted MULTIPLE new rows, an arbitrary
  // integer `from`, and optional evidence — so a growth could be waved through by any row that
  // happened to carry the right `to`. One growth, one row, and its `from` must be the count it
  // actually grew FROM.
  const fresh = headRows.slice(baseRows.length);
  const baseCount = baseIds.size;
  if (fresh.length > 1) {
    failures.push(
      `${relPath} — ${fresh.length} new rebaselines rows since the pinned base. One growth is one row: ` +
      `several rows let an unexplained addition ride along behind an explained one.`,
    );
  }
  const covering = fresh.find((r) => canonicalDate(r?.at) && r?.to === current.length && r?.from === baseCount);
  if (!covering) {
    failures.push(
      `${label}: ${added.length} entr(ies) were ADDED to "${field}" since the pinned base — ` +
      `${added.slice(0, 4).join(', ')}${added.length > 4 ? ', …' : ''} — with no new rebaselines row whose \`to\` ` +
      `equals the resulting count (${current.length}) AND whose \`from\` equals the base count (${baseIds.size}). ` +
      `This list is shrink-only against the ACCEPTED BASE, not against itself.`,
    );
  }
  return failures;
}

/** The GROW-ONLY direction — a different check, not the mirror. */
export function checkGrowOnlyAgainstHistory({ relPath, cwd, field, current, retiredIds = [], label, envPrefix }) {
  const failures = [];
  const base = readPinnedBase(envPrefix);
  if (base.kind === 'local-unbound') return failures; // local run: CI owns this guarantee
  if (base.kind === 'unreadable') {
    failures.push(`${relPath} — the pinned base copy could not be read (${base.reason}); refusing to report clean.`);
    return failures;
  }
  if (base.kind !== 'present') return failures;
  let baseDoc;
  try { baseDoc = JSON.parse(base.text); } catch (err) {
    failures.push(`${relPath} — the pinned base copy is unparseable (${err.message}); refusing to report clean.`);
    return failures;
  }
  const now = new Set(current);
  const retired = new Set(retiredIds);
  const dropped = (Array.isArray(baseDoc?.[field]) ? baseDoc[field] : []).filter((id) => !now.has(id) && !retired.has(id));
  if (dropped.length > 0) {
    failures.push(
      `${label}: ${dropped.length} entr(ies) present in "${field}" at the pinned base are GONE at HEAD — ` +
      `${dropped.slice(0, 4).join(', ')}${dropped.length > 4 ? ', …' : ''}. This list is GROW-ONLY: it exists so a ` +
      `recorded failure cannot be un-recorded, and deleting the id from the floor in the same commit that deletes ` +
      `the record is precisely the attack it was built to stop.`,
    );
  }
  // A retirement tombstone must ALSO be append-only, or the exemption evaporates once it is the base.
  for (const r of Array.isArray(baseDoc?.retired) ? baseDoc.retired : []) {
    if (r?.id && !retiredIds.includes(r.id)) {
      failures.push(
        `${relPath} — the retirement tombstone for "${r.id}" present at the pinned base is GONE at HEAD. A ` +
        `retirement record is permanent; removing it lets that id be deleted again later with nothing left to ` +
        `explain why it was ever allowed.`,
      );
    }
  }
  return failures;
}
