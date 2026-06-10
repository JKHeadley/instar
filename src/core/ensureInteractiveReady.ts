/**
 * ensureInteractiveReady — onboarding-safe config homes for the subscription
 * pool (2026-06-09 incident, topic 20905).
 *
 * Pool-account config homes are created via `claude auth login`, which stores
 * OAuth tokens but is HEADLESS-ONLY: it never sets the interactive first-launch
 * onboarding flags. Relaunching an INTERACTIVE Claude Code session into such a
 * home (session pinning, proactive/reactive account swap) re-runs first-launch
 * onboarding — the OAuth-authorize URL + the "Bypass Permissions mode" accept
 * screen — and the session wedges. The tokens were present; the onboarding
 * FLAGS were the missing piece (~8 live sessions wedged, browser-tab spam,
 * a manual operator login to recover).
 *
 * This util makes pin/swap onboarding-safe by construction: idempotently seed
 * the three local trust-acknowledgement flags in `<configHome>/.claude.json`,
 * preserving every other key byte-for-byte.
 *
 * Structural invariants:
 *   - NEVER touches `oauthAccount` or any token/credential field — only the
 *     three onboarding flags are ever written, onto the parsed existing object.
 *   - NEVER rewrites a file it cannot parse — an unparseable `.claude.json`
 *     may still hold the account's credentials in a salvageable form, so we
 *     refuse and report rather than clobber.
 *   - Fail-safe: never throws into the caller. A launch must not crash on
 *     this; the worst case is the pre-fix behavior (onboarding wedge), not a
 *     dead spawn path. All failures return `{ patched: false, reason }`.
 *   - Idempotent + cheap (one stat/read; a write only when a flag is missing),
 *     so calling it defensively on every pinned/swapped launch is fine.
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * The interactive first-launch flags `claude auth login` (headless) never
 * sets. All three are LOCAL trust acknowledgements — seeding them to `true`
 * asserts nothing about credentials, only that first-launch onboarding and
 * the bypass-permissions/trust dialogs are accepted for this home.
 */
export const INTERACTIVE_ONBOARDING_FLAGS = [
  'hasCompletedOnboarding',
  'bypassPermissionsModeAccepted',
  'hasTrustDialogAccepted',
] as const;

export interface EnsureInteractiveReadyResult {
  /** True when this call wrote one or more missing flags. */
  patched: boolean;
  /** Why nothing was written (or which flags were seeded when patched). */
  reason: string;
}

export interface EnsureInteractiveReadyOptions {
  /**
   * When true, a config home whose directory does not exist is left alone
   * (`patched: false`) instead of being created. Used by the one-time
   * migration sweep so a stale pool entry never litters $HOME with empty
   * credential-less homes; launch paths keep the default (create/merge —
   * the account was just selected, so its home is expected to exist).
   */
  requireExistingHome?: boolean;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Idempotently mark `<configHome>/.claude.json` interactive-ready. Returns
 * `{ patched: true }` only when a missing flag was actually written.
 */
export function ensureInteractiveReady(
  configHome: string,
  opts?: EnsureInteractiveReadyOptions,
): EnsureInteractiveReadyResult {
  try {
    const trimmed = (configHome ?? '').trim();
    if (!trimmed) return { patched: false, reason: 'empty configHome' };

    // Expand a `~` prefix the same way the swap-continuity path does — pool
    // entries are operator-entered and may be tilde-relative.
    const home = trimmed.startsWith('~')
      ? path.join(process.env.HOME ?? '', trimmed.slice(1))
      : trimmed;
    const filePath = path.join(home, '.claude.json');

    if (opts?.requireExistingHome && !fs.existsSync(home)) {
      return { patched: false, reason: `config home ${home} does not exist` };
    }

    let existing: Record<string, unknown> = {};
    if (fs.existsSync(filePath)) {
      let raw: string;
      try {
        raw = fs.readFileSync(filePath, 'utf-8');
      } catch (err) {
        return { patched: false, reason: `unreadable ${filePath}: ${errMsg(err)}` };
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        // Refuse to rewrite what we can't parse — the file may still hold the
        // account's oauthAccount/credentials in a recoverable form.
        return {
          patched: false,
          reason: `unparseable ${filePath} — refusing to rewrite: ${errMsg(err)}`,
        };
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return {
          patched: false,
          reason: `${filePath} is not a JSON object — refusing to rewrite`,
        };
      }
      existing = parsed as Record<string, unknown>;
    }

    const missing = INTERACTIVE_ONBOARDING_FLAGS.filter((f) => existing[f] !== true);
    if (missing.length === 0) {
      return { patched: false, reason: 'already interactive-ready' };
    }
    for (const f of missing) existing[f] = true;

    // Atomic tmp+rename write (the repo's durable-registry idiom) so a crash
    // mid-write can never leave a half-written `.claude.json` — that file
    // also carries the account's oauthAccount, which we must never corrupt.
    fs.mkdirSync(home, { recursive: true });
    const tmpPath = `${filePath}.${process.pid}.interactive-ready.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(existing, null, 2) + '\n');
    fs.renameSync(tmpPath, filePath);
    return { patched: true, reason: `seeded ${missing.join(', ')}` };
  } catch (err) {
    // @silent-fallback-ok: fail-safe by contract — a launch path must never
    // crash on readiness seeding; the caller logs the reason.
    return { patched: false, reason: `ensureInteractiveReady failed: ${errMsg(err)}` };
  }
}
