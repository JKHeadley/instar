/**
 * WS5.2 R12.i — the REAL cooperative data-plane wipe for AccountFollowMeRevocation.
 *
 * The pure executor (`AccountFollowMeRevocation`) takes a `cooperativeWipe(req) => CooperativeWipeResult`
 * dep — three booleans (loggedOut / slotDeleted / poolRemoved). This factory builds the PRODUCTION
 * implementation for a LOCAL account (the PER-SERVER model, OQ6: the operator revokes the mandate on
 * the TARGET machine's OWN dashboard, so the target runs its OWN local wipe — this is never a
 * cross-machine wipe-instruction).
 *
 * Per the spec (line 193) the wipe is three steps against the local account:
 *   1. logout    — the framework's own logout against that account's CLAUDE_CONFIG_DIR.
 *   2. slot del  — delete the per-account config-home directory + its keychain credential entry.
 *   3. pool rm   — SubscriptionPool.remove(accountId).
 *
 * FAIL-CLOSED CONTRACT (load-bearing): every step is wrapped so a throw becomes `false`, NEVER a
 * silent `true`. The executor treats a partial/all-false result as a durable pending retry — it
 * never claims `removed` it could not confirm. The whole function returns the per-step booleans;
 * it does NOT itself throw (the executor's catch is a backstop, but we resolve each step honestly).
 *
 * The two side-effecting primitives (framework logout, directory/keychain deletion) are injected so
 * this is unit-testable without spawning a real `claude` CLI or touching a real keychain; production
 * wiring passes the real execFileSync-backed logout + SafeFsExecutor-backed deletion.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from './SafeFsExecutor.js';
import { claudeCredentialService, expandHome } from './OAuthRefresher.js';

/**
 * Deletion-safety guard (BLOCKING fix, 2026-06-17 second-pass review): the cooperative wipe does a
 * `recursive,force` rm of an account's configHome. configHome is operator-provided at enroll time and
 * `~/.claude` (the operator's PRIMARY/shared login) is a legitimate value — so an `account-follow-me`
 * revoke targeting the default account would otherwise recursively delete the operator's main login
 * directory. This refuses to delete any catastrophic / shared target: a filesystem root, `$HOME`
 * itself, an ANCESTOR of `$HOME`, or a framework DEFAULT config home (`~/.claude`, `~/.codex`, …).
 * A refused path returns slotDeleted:false → the executor falls to a durable pending, NEVER a false
 * `removed`. A genuine per-account slot (e.g. `~/.claude-adriana`, `~/.instar/accounts/<id>`) is NOT
 * matched and deletes normally.
 */
export function isProtectedConfigHome(rawConfigHome: string): boolean {
  const expanded = expandHome(String(rawConfigHome ?? '')).trim();
  if (!expanded) return true; // empty / whitespace — refuse before path.resolve('') falls back to cwd.
  const resolvedRaw = path.resolve(expanded);
  if (!resolvedRaw) return true; // unresolvable — refuse, fail-closed.
  const homeRaw = path.resolve(os.homedir());
  // Case-fold the comparison: macOS/Windows default volumes are case-INSENSITIVE, so `~/.CLAUDE`
  // is the SAME on-disk dir as `~/.claude` and must be refused too (string-exact would miss it).
  const resolved = resolvedRaw.toLowerCase();
  const home = homeRaw.toLowerCase();
  const sep = path.sep;
  // A filesystem root (e.g. "/" or "C:\").
  if (resolvedRaw === path.parse(resolvedRaw).root) return true;
  // $HOME itself, or an ancestor of $HOME (e.g. "/Users", "/").
  if (resolved === home || home.startsWith(resolved + sep)) return true;
  // Framework default / shared config homes — the operator's primary logins, never a follow-me slot.
  const PROTECTED_DEFAULT_HOMES = ['.claude', '.codex', '.gemini', '.pi', '.config'];
  for (const name of PROTECTED_DEFAULT_HOMES) {
    if (resolved === path.join(home, name).toLowerCase()) return true;
  }
  return false;
}
import type { CooperativeWipeResult, RevocationRequest } from './AccountFollowMeRevocation.js';
import type { SubscriptionPool } from './SubscriptionPool.js';

/** Per-framework logout command (mirrors the enroll login-command table; args, not a shell string). */
const FRAMEWORK_LOGOUT: Record<string, { cmd: string; args: string[] }> = {
  'claude-code': { cmd: 'claude', args: ['auth', 'logout'] },
  'codex-cli': { cmd: 'codex', args: ['logout'] },
  // gemini/pi have no headless logout verb today — slot deletion + pool.remove still apply, and the
  // missing logout surfaces as loggedOut:false ⇒ the executor keeps a durable pending (honest).
};

const LOGOUT_TIMEOUT_MS = 15_000;

export interface CooperativeWipeDeps {
  pool: SubscriptionPool;
  /**
   * Run the framework's logout against the account's config home. MUST return true ONLY on a
   * confirmed logout; false (or throw) otherwise. Injected for tests; production uses execFileSync.
   */
  frameworkLogout?: (args: { framework: string; configHome: string }) => boolean;
  /**
   * Delete the per-account config-home directory + its keychain credential entry. MUST return true
   * ONLY when the slot is gone; false (or throw) otherwise. Injected for tests; production uses
   * SafeFsExecutor + `security`.
   */
  deleteSlot?: (args: { configHome: string; framework: string }) => boolean;
  log?: (msg: string) => void;
}

/** Production framework-logout: env-scope the logout CLI to the account's config home. */
function defaultFrameworkLogout(args: { framework: string; configHome: string }): boolean {
  const spec = FRAMEWORK_LOGOUT[args.framework];
  if (!spec) return false; // no headless logout verb for this framework — honestly not-done.
  try {
    execFileSync(spec.cmd, spec.args, {
      timeout: LOGOUT_TIMEOUT_MS,
      stdio: 'ignore',
      env: { ...process.env, CLAUDE_CONFIG_DIR: expandHome(args.configHome) },
    });
    return true;
  } catch {
    // @silent-fallback-ok: fail-closed — a non-zero exit / missing CLI / timeout is NOT a confirmed
    // logout; the false return surfaces to the executor (→ pending, never a false `removed`).
    return false;
  }
}

/** Production slot deletion: remove the config-home dir (SafeFsExecutor) + the keychain entry. */
function defaultDeleteSlot(args: { configHome: string; framework: string }): boolean {
  const home = expandHome(args.configHome);
  // DELETION-SAFETY GUARD: never recursively delete a shared/default/root path (see
  // isProtectedConfigHome). Refusing returns false → durable pending, never a false `removed`.
  if (isProtectedConfigHome(args.configHome)) {
    return false;
  }
  let dirGone = false;
  try {
    // Recursive force delete of the per-account config home. force:true makes an already-absent
    // dir a success (idempotent — a retried wipe is safe).
    SafeFsExecutor.safeRmSync(home, {
      recursive: true,
      force: true,
      operation: 'accountFollowMeCooperativeWipe.deleteSlot',
    });
    dirGone = !fs.existsSync(home);
  } catch {
    // @silent-fallback-ok: fail-closed — a delete error surfaces as slotDeleted:false → pending.
    dirGone = false;
  }
  // Best-effort keychain credential delete for claude-code slots (the login token lives here too).
  if (args.framework === 'claude-code') {
    try {
      const service = claudeCredentialService(args.configHome);
      execFileSync('security', ['delete-generic-password', '-s', service], {
        timeout: 5_000,
        stdio: 'ignore',
      });
    } catch {
      // @silent-fallback-ok: a missing keychain entry (or non-darwin) is a no-op; the directory
      // delete is the authoritative slot-gone signal, so this never flips the result false on its own.
    }
  }
  return dirGone;
}

/**
 * Build the production `cooperativeWipe` function for the injected SubscriptionPool. The returned
 * function reads the LOCAL account's config home + framework from the pool (the operator-revoked
 * account on THIS machine) and runs the three steps. If the account is not found locally, every
 * step is false (nothing to wipe here — the executor falls to pending, honest).
 */
export function buildCooperativeWipe(deps: CooperativeWipeDeps): (req: RevocationRequest) => CooperativeWipeResult {
  const frameworkLogout = deps.frameworkLogout ?? defaultFrameworkLogout;
  const deleteSlot = deps.deleteSlot ?? defaultDeleteSlot;
  return (req: RevocationRequest): CooperativeWipeResult => {
    const acct = deps.pool.get(req.accountId);
    if (!acct) {
      deps.log?.(
        `[account-follow-me] cooperativeWipe ${req.accountId}: no local account — nothing to wipe here`,
      );
      return { loggedOut: false, slotDeleted: false, poolRemoved: false };
    }
    const configHome = acct.configHome;
    const framework = acct.framework;

    let loggedOut = false;
    try {
      loggedOut = frameworkLogout({ framework, configHome });
    } catch {
      // @silent-fallback-ok: fail-closed — surfaces as loggedOut:false → executor keeps pending.
      loggedOut = false;
    }

    let slotDeleted = false;
    try {
      slotDeleted = deleteSlot({ configHome, framework });
    } catch {
      // @silent-fallback-ok: fail-closed — surfaces as slotDeleted:false → executor keeps pending.
      slotDeleted = false;
    }

    let poolRemoved = false;
    try {
      poolRemoved = deps.pool.remove(req.accountId);
    } catch {
      // @silent-fallback-ok: fail-closed — surfaces as poolRemoved:false → executor keeps pending.
      poolRemoved = false;
    }

    deps.log?.(
      `[account-follow-me] cooperativeWipe ${req.accountId}: logout=${loggedOut} slot=${slotDeleted} pool=${poolRemoved}`,
    );
    return { loggedOut, slotDeleted, poolRemoved };
  };
}
