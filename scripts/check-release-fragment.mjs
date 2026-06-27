#!/usr/bin/env node
/**
 * release-fragment-gate (Layer 1) — the server-side PR-time check that a
 * release-affecting PR carries a release-note fragment.
 *
 * ── Why ───────────────────────────────────────────────────────────────
 * A HARD pre-push gate already requires the fragment, but it runs in husky
 * LOCALLY — the server-side squash/bot/auto-merge path that lands most merges
 * never runs husky, so a fragment-less change reaches main and the publish
 * SILENTLY skips the release (2026-06-27: PRs #1295-#1297 stranded ~7h). This
 * gate moves the SAME requirement to the merge boundary, where it cannot be
 * routed around.
 *
 * ── Signal vs Authority ───────────────────────────────────────────────
 * This is an AUTHORITY (it can block a merge), but its veto rests on an
 * OBJECTIVE BINARY — "a release-note fragment file is present, yes/no" — exactly
 * the shape the existing eli16-pr-gate already establishes. The release-relevant
 * path predicate is a FALLIBLE SIGNAL: a false positive is always escapable by
 * adding a one-line `internal-only` fragment. The block is carried by the
 * presence condition, never the predicate's correctness.
 *
 * ── Security ──────────────────────────────────────────────────────────
 * Runs under `on: pull_request` (NOT pull_request_target), read-only token, no
 * PR-head checkout. Untrusted PR title/body arrive via env (process.env), never
 * shell-interpolated. The bot exemption keys on the AUTHENTICATED actor identity
 * (login + type), never a spoofable title string. FAIL-CLOSED: any internal
 * error reports the check FAILED, never green.
 *
 * Pure `checkReleaseFragment(...)` is exported for unit testing; the CLI wrapper
 * reads env set by the workflow and exits 0 (pass/exempt) or 1 (fail).
 */

import { isReleaseRelevant } from './release-relevant-paths.mjs';

/** A changed file that is a release-note fragment (the opt-out lane is itself such a file). */
function isFragmentFile(p) {
  if (typeof p !== 'string') return false;
  const norm = p.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  return /^upgrades\/next\/.+\.md$/.test(norm) || norm === 'upgrades/NEXT.md';
}

/**
 * @param {{
 *   files?: Array<{ path: string, status?: string }> | string[],
 *   authorLogin?: string|null,
 *   authorType?: string|null,
 *   title?: string|null,
 *   releaseBotLogin?: string|null,   // the known release-cut bot login (default github-actions[bot])
 * }} pr
 * @returns {{ ok: boolean, exempt?: string, reason?: string, relevant?: string[] }}
 */
export function checkReleaseFragment(pr) {
  const releaseBotLogin = (pr?.releaseBotLogin ?? 'github-actions[bot]');

  // ── Exemption: ONLY the authenticated release-cut bot identity ──────
  // Keyed on login + type, NEVER a title/commit-message string. A human-authored
  // PR titled "chore: release …" is still gated (the spoof fails by construction).
  const login = String(pr?.authorLogin ?? '');
  const type = String(pr?.authorType ?? '');
  if (type === 'Bot' && login && login === releaseBotLogin) {
    return { ok: true, exempt: 'release-cut-bot' };
  }

  // Normalize the changed-file list (accept the files API shape OR a bare path list).
  const rawFiles = Array.isArray(pr?.files) ? pr.files : [];
  const paths = rawFiles.map((f) => (typeof f === 'string' ? f : f?.path)).filter((p) => typeof p === 'string');

  // (a) Any release-relevant changed path?
  const relevant = paths.filter((p) => isReleaseRelevant(p));
  if (relevant.length === 0) {
    return { ok: true, exempt: 'no-release-relevant-paths' };
  }

  // (b) A release-note fragment added/modified? (Presence, not content — Layer 1
  //     has only the file list. The internal-only opt-out IS such a file, so its
  //     presence satisfies this; its legitimacy is verified downstream at
  //     assemble-next-md + pre-push-gate §3c.)
  const hasFragment = paths.some(isFragmentFile);
  if (hasFragment) {
    return { ok: true };
  }

  return { ok: false, reason: 'release-relevant-no-fragment', relevant };
}

// ── CLI (used by .github/workflows/release-fragment-gate.yml) ─────────
const invokedDirectly =
  process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (invokedDirectly) {
  // FAIL-CLOSED: any throw below exits non-zero (never a silent green).
  try {
    // The workflow provides the changed-file list as JSON in PR_FILES_JSON
    // (array of { path/filename, status }), and PR_AUTHOR_LOGIN / PR_AUTHOR_TYPE
    // / PR_TITLE from the event. WARN_ONLY=1 reports the verdict without failing
    // (soak phase — spec D2/D3).
    let files = [];
    try {
      const parsed = JSON.parse(process.env.PR_FILES_JSON || '[]');
      if (Array.isArray(parsed)) {
        files = parsed.map((f) => ({ path: f.path ?? f.filename, status: f.status }));
      }
    } catch (e) {
      console.error(`release-fragment-gate: could NOT parse PR_FILES_JSON — failing closed. ${e?.message ?? e}`);
      process.exit(1);
    }

    const res = checkReleaseFragment({
      files,
      authorLogin: process.env.PR_AUTHOR_LOGIN,
      authorType: process.env.PR_AUTHOR_TYPE,
      title: process.env.PR_TITLE,
      releaseBotLogin: process.env.RELEASE_BOT_LOGIN || undefined,
    });

    const warnOnly = process.env.WARN_ONLY === '1';

    if (res.ok) {
      console.log(
        res.exempt
          ? `release-fragment-gate: exempt (${res.exempt}).`
          : 'release-fragment-gate: OK — a release-note fragment is present.',
      );
      // Emit a machine-readable verdict line for the rollout log (spec D3).
      console.log(`::notice::release-fragment-gate verdict=PASS exempt=${res.exempt ?? 'none'}`);
      process.exit(0);
    }

    const msg =
      `release-fragment-gate: this PR changes release-relevant files but adds NO release-note ` +
      `fragment (upgrades/next/<slug>.md). Without one, the publish pipeline SILENTLY SKIPS the ` +
      `release — your change would merge but never ship (the 2026-06-27 incident).\n` +
      `  Release-relevant files:\n` +
      res.relevant.slice(0, 8).map((f) => `    • ${f}`).join('\n') +
      (res.relevant.length > 8 ? `\n    • …and ${res.relevant.length - 8} more` : '') +
      `\n  Fix: add upgrades/next/<slug>.md describing the change (via /instar-dev). For a genuinely ` +
      `no-user-impact change, add a fragment carrying the standalone <!-- internal-only --> marker.`;

    if (warnOnly) {
      console.log(`::warning::${msg.replace(/\n/g, ' ')}`);
      console.log(`::notice::release-fragment-gate verdict=FAIL warn-only=1 (not blocking during soak)`);
      process.exit(0); // soak phase: report, do not block
    }
    console.error(msg);
    console.log(`::notice::release-fragment-gate verdict=FAIL blocking=1`);
    process.exit(1);
  } catch (e) {
    // FAIL-CLOSED — an internal error must turn the check RED, never green.
    console.error(`release-fragment-gate: internal error — failing closed. ${e?.stack ?? e}`);
    process.exit(1);
  }
}
