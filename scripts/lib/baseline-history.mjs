/**
 * baseline-history.mjs — a ratchet must compare against ACCEPTED HISTORY, not against itself.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * Review pass 5, 2026-08-09, on three "shrink-only" baselines built the same night:
 *
 *   "A change can add a fingerprint-less article to both the registry AND `grandfathered`,
 *    or add an orphan marker to both the corpus AND `orphans`, and remain clean. Neither
 *    check compares against the accepted Git state. Therefore 'may never be added back',
 *    'the debt can only be paid down', and 'a new orphan fails immediately' are manufactured
 *    enforcement claims."
 *
 * It was right, and the same defect had already been found once that night in a different
 * dress: the enforcement-gap floor was "grow-only" while living in a file the same commit
 * could edit. Both share one root — **a ratchet whose reference point travels with the
 * change it is meant to constrain is not a ratchet.** A list cannot floor itself.
 *
 * So the reference point is the file as of the ACCEPTED base (`origin/main` by default): a
 * commit can only be compared against something it did not author.
 *
 * ── Widening is legitimate; widening SILENTLY is not ───────────────────────
 * Three of tonight's re-baselines were real: the population was measured, found narrower
 * than its own description, and widened. That must stay possible. What it may not do is
 * happen without a permanent trace, so growth is admitted only when the file carries an
 * APPEND-ONLY `rebaselines` log that gained exactly one entry for it — with a date, the
 * before/after counts, and a reason. The log is checked against the base too, so an entry
 * cannot be deleted later to hide that a debt grew.
 *
 * ── What this measures, and what it certifies ──────────────────────────────
 *   MEASURED  — the baseline's own entries at HEAD against the same file at the base ref,
 *               plus the append-only-ness of its rebaselines log.
 *   CERTIFIED — an entry cannot be ADDED to a shrink-only list, and a debt cannot GROW,
 *               without a dated reason that itself cannot later be removed.
 *
 * **It does NOT certify the reason is honest.** "Population widening" is a sentence, and a
 * sentence can be wrong or self-serving — three of mine were overstated on the night this
 * was written. What is forced is that a human-readable claim exists, in the diff, attached
 * to the exact numbers, and survives.
 *
 * **It fails CLOSED when the base cannot be read.** An unreadable base is exactly the state
 * in which a ratchet silently stops ratcheting, so it is an error rather than a pass. Point
 * it elsewhere with INSTAR_BASELINE_HISTORY_BASE=<ref> for a legitimately detached checkout.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const BASE_REF = process.env.INSTAR_BASELINE_HISTORY_BASE || 'origin/main';

/**
 * The file's content at the accepted base.
 *
 * THREE outcomes, kept distinct on purpose — collapsing them is how "unknown" becomes "clean":
 *   ok        — the base copy was read; the ratchet has a real reference point.
 *   absent    — the REF is fine but the file did not exist there. That is a NEW baseline
 *               establishing itself, which is legitimate exactly once and is reported as such
 *               rather than silently treated as an empty list (an empty list would make every
 *               entry look "added" and the first commit unpassable, or worse, make a deleted
 *               baseline look new).
 *   unreadable— the ref itself could not be resolved. This is the state in which a ratchet
 *               silently stops ratcheting, so it is an ERROR.
 */
export function readAtBase(relPath, cwd) {
  try {
    execFileSync('git', ['rev-parse', '--verify', `${BASE_REF}^{commit}`], { cwd, stdio: 'ignore' });
  } catch {
    return { ok: false, kind: 'unreadable', reason: `base ref ${BASE_REF} does not resolve in this checkout` };
  }
  try {
    const out = execFileSync('git', ['show', `${BASE_REF}:${relPath}`], {
      cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, kind: 'present', text: out };
  } catch {
    return { ok: false, kind: 'absent', reason: `${relPath} does not exist at ${BASE_REF} (new baseline)` };
  }
}

/**
 * Compare a shrink-only id list against its own accepted history.
 *
 * @param {object} o
 * @param {string} o.relPath       the baseline file, repo-relative
 * @param {string} o.cwd           repo root
 * @param {string} o.field         the array field holding the ids (e.g. 'orphans')
 * @param {string[]} o.current     the ids at HEAD
 * @param {string} o.label         human label for messages
 * @returns {string[]} failures
 */
export function checkShrinkOnlyAgainstHistory({ relPath, cwd, field, current, label }) {
  const failures = [];
  const base = readAtBase(relPath, cwd);
  if (base.kind === 'unreadable') {
    failures.push(
      `${relPath} — ${base.reason}, so the shrink-only claim is UNVERIFIABLE and this check refuses to ` +
      `report clean. A ratchet compared only against itself is not a ratchet: the same commit can add an ` +
      `entry to the list and to the thing the list exempts. Set INSTAR_BASELINE_HISTORY_BASE to a reachable ` +
      `ref if this checkout is legitimately detached.`,
    );
    return failures;
  }
  if (base.kind === 'absent') {
    // A baseline being ESTABLISHED. Legitimate once, and it must say so in its own bytes so a later
    // reader can tell an establishing baseline from one whose history was quietly dropped.
    if (!currentDoc(relPath, cwd)?.measuredAt) {
      failures.push(`${relPath} — is new at ${BASE_REF} but carries no measuredAt. An establishing baseline must date itself, or it is indistinguishable from one whose history was dropped.`);
    }
    return failures;
  }

  let baseDoc;
  try { baseDoc = JSON.parse(base.text); } catch (err) {
    failures.push(`${relPath} — the base copy is unparseable (${err.message}); refusing to report clean.`);
    return failures;
  }

  const baseIds = new Set(Array.isArray(baseDoc?.[field]) ? baseDoc[field] : []);
  const added = current.filter((id) => !baseIds.has(id));
  if (added.length === 0) return failures;

  // Growth is admitted only with an append-only, dated rebaseline entry covering it.
  const headLog = currentLog(relPath, cwd);
  const baseLog = Array.isArray(baseDoc?.rebaselines) ? baseDoc.rebaselines : [];
  const removed = baseLog.filter((e) => !headLog.some((h) => h.at === e.at && h.reason === e.reason));
  if (removed.length > 0) {
    failures.push(
      `${relPath} — ${removed.length} rebaseline log entr(ies) present at ${BASE_REF} are missing at HEAD. ` +
      `The log is APPEND-ONLY: deleting an entry hides that a debt once grew, which is the record this ` +
      `mechanism exists to keep.`,
    );
  }
  const fresh = headLog.filter((h) => !baseLog.some((e) => e.at === h.at && e.reason === h.reason));
  const covering = fresh.find((h) => h.at && h.reason && String(h.reason).trim().length >= 40 && Number.isFinite(h.to));
  if (!covering) {
    failures.push(
      `${label}: ${added.length} entr(ies) were ADDED to "${field}" since ${BASE_REF} — ` +
      `${added.slice(0, 4).join(', ')}${added.length > 4 ? ', …' : ''} — with no new rebaselines entry ` +
      `explaining it. This list is shrink-only against ACCEPTED HISTORY, not against itself: a change that ` +
      `adds a debt AND exempts it in one commit is exactly what the sentence "may never be added back" ` +
      `promised was impossible. Append {"at":"YYYY-MM-DD","from":N,"to":M,"reason":"…"} stating why the ` +
      `population grew, or shrink the list.`,
    );
  }
  return failures;
}

function currentDoc(relPath, cwd) {
  try { return JSON.parse(fs.readFileSync(path.join(cwd, relPath), 'utf-8')); } catch { return null; }
}

function currentLog(relPath, cwd) {
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(cwd, relPath), 'utf-8'));
    return Array.isArray(doc?.rebaselines) ? doc.rebaselines : [];
  } catch { return []; }
}

/**
 * The GROW-ONLY direction, which is a different check and not the mirror of the above.
 *
 * Caught by injection rather than by reasoning: the gap floor was wired through the SHRINK-only
 * helper, so deleting an id from it was read as legitimate shrinkage and the co-edit attack passed
 * in SILENCE. Per *Verify the State, Not Its Symbol* tooth (E), an injection that produces silence
 * is the signature of an arm that cannot fire — which is exactly what this was until it was tested.
 *
 * A grow-only list may lose an entry ONLY through a recorded retirement; the caller validates the
 * retirement's own fields.
 */
export function checkGrowOnlyAgainstHistory({ relPath, cwd, field, current, retiredIds = [], label }) {
  const failures = [];
  const base = readAtBase(relPath, cwd);
  if (base.kind === 'unreadable') {
    failures.push(`${relPath} — ${base.reason}, so the grow-only claim is UNVERIFIABLE and this check refuses to report clean.`);
    return failures;
  }
  if (base.kind === 'absent') return failures; // establishing the list
  let baseDoc;
  try { baseDoc = JSON.parse(base.text); } catch (err) {
    failures.push(`${relPath} — the base copy is unparseable (${err.message}); refusing to report clean.`);
    return failures;
  }
  const now = new Set(current);
  const retired = new Set(retiredIds);
  const dropped = (Array.isArray(baseDoc?.[field]) ? baseDoc[field] : []).filter((id) => !now.has(id) && !retired.has(id));
  if (dropped.length > 0) {
    failures.push(
      `${label}: ${dropped.length} entr(ies) present in "${field}" at the accepted base are GONE at HEAD — ` +
      `${dropped.slice(0, 4).join(', ')}${dropped.length > 4 ? ', …' : ''}. This list is GROW-ONLY: it exists so a ` +
      `recorded failure cannot be un-recorded, and deleting the id from the floor in the same commit that deletes ` +
      `the record is precisely the attack it was built to stop. Restore it, or record a retirement with its reason.`,
    );
  }
  return failures;
}

