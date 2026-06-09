/**
 * InUseAccountResolver — answers "which subscription-pool account is the agent
 * actually running on right now?" for the Subscriptions dashboard.
 *
 * ── Why this exists ──
 * The pool's per-account `status: active` means "healthy / usable", NOT "in use".
 * Normal agent sessions launch on the DEFAULT Claude config (whatever
 * `CLAUDE_CONFIG_DIR` resolves to when unset) — the pool only swaps accounts
 * reactively on a rate-limit. So nothing on the dashboard marked which account
 * the agent was live on. This resolver supplies that signal: it asks Claude's
 * own auth surface which account the default config is authenticated as, then
 * matches that email to a pool account.
 *
 * ── Authoritative, not a guess ──
 * The default config can carry STALE/conflicting oauthAccount records across its
 * config files (observed live: `~/.claude/.claude.json` lagging on a different
 * account than the active one). So we do NOT read a config file — we run
 * `claude auth status`, the same surface the client uses, which returns the
 * REAL active account email. Cached with a short TTL so the dashboard poll
 * doesn't spawn a probe every tick.
 *
 * Read-only: it never selects, pins, or mutates anything. It only reports.
 * The probe + clock are injected so the resolver is hermetically testable.
 */

import { execFile } from 'node:child_process';

import type { SubscriptionAccount } from './SubscriptionPool.js';

/** Probe the DEFAULT claude config's authenticated account email (or null). */
export type AuthStatusProbe = () => Promise<string | null>;

export interface InUseAccountResolverConfig {
  /** Injected for tests; defaults to spawning `claude auth status`. */
  probe?: AuthStatusProbe;
  /** Cache TTL for the probe result. Default 60s — the active account rarely flips. */
  ttlMs?: number;
  /** Injected for tests. */
  now?: () => number;
}

export interface InUseResult {
  /** The pool account id the agent is currently running on, or null if none matches. */
  activeAccountId: string | null;
  /** The email the default config is authenticated as (even if no pool account matches). */
  activeEmail: string | null;
}

/**
 * Default probe: run `claude auth status` under the DEFAULT config (no
 * CLAUDE_CONFIG_DIR override) and parse the `email` field of its JSON output.
 * Returns null on any failure — the resolver degrades to "unknown", never throws.
 *
 * RULE 3.1 rationale (state-detector registry: core/InUseAccountResolver.ts):
 *  - Criticality: LOW. The parsed email only drives a dashboard "in use" badge;
 *    nothing acts on it, so a wrong/absent parse degrades the display, never
 *    corrupts state.
 *  - Frequency: per-poll (dashboard /in-use), cached 60s — low volume.
 *  - Stability: semi-stable — `claude auth status` is a documented status command
 *    emitting JSON, less drift-prone than TUI scraping.
 *  - Fallback: NOT load-bearing — any failure yields activeAccountId:null (no
 *    badge). Never throws, never blocks the dashboard.
 *  - → Verdict: deterministic + degrades-safely; no canary warranted.
 */
export function defaultAuthStatusProbe(): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(
        'claude',
        ['auth', 'status'],
        { timeout: 15_000, maxBuffer: 1024 * 1024 },
        (err, stdout) => {
          if (err || !stdout) {
            resolve(null);
            return;
          }
          try {
            const data = JSON.parse(stdout) as { loggedIn?: boolean; email?: unknown };
            const email = typeof data.email === 'string' && data.email.includes('@') ? data.email : null;
            resolve(data.loggedIn === false ? null : email);
          } catch {
            resolve(null); // @silent-fallback-ok: unparseable status → unknown
          }
        },
      );
    } catch {
      resolve(null); // @silent-fallback-ok: spawn failed → unknown
    }
  });
}

/**
 * Pure: match the active account email to a pool account (case-insensitive).
 * Only anthropic/claude-code accounts are considered — the active Claude login
 * cannot be a codex/gemini account. Returns the account id or null.
 */
export function matchAccountByEmail(
  accounts: SubscriptionAccount[],
  email: string | null,
): string | null {
  if (!email) return null;
  const target = email.trim().toLowerCase();
  if (!target) return null;
  const hit = accounts.find(
    (a) =>
      a.provider === 'anthropic' &&
      a.framework === 'claude-code' &&
      typeof a.email === 'string' &&
      a.email.trim().toLowerCase() === target,
  );
  return hit ? hit.id : null;
}

export class InUseAccountResolver {
  private readonly probe: AuthStatusProbe;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private cached: { email: string | null; at: number } | null = null;
  private inFlight: Promise<string | null> | null = null;

  constructor(config: InUseAccountResolverConfig = {}) {
    this.probe = config.probe ?? defaultAuthStatusProbe;
    this.ttlMs = config.ttlMs ?? 60_000;
    this.now = config.now ?? (() => Date.now());
  }

  /** The active default-config email, cached for ttlMs. Coalesces concurrent probes. */
  async activeEmail(): Promise<string | null> {
    if (this.cached && this.now() - this.cached.at < this.ttlMs) {
      return this.cached.email;
    }
    if (this.inFlight) return this.inFlight;
    this.inFlight = (async () => {
      let email: string | null = null;
      try {
        email = await this.probe();
      } catch {
        email = null; // @silent-fallback-ok: probe failure → unknown
      }
      this.cached = { email, at: this.now() };
      this.inFlight = null;
      return email;
    })();
    return this.inFlight;
  }

  /** Resolve which pool account the agent is currently running on. */
  async resolve(accounts: SubscriptionAccount[]): Promise<InUseResult> {
    const activeEmail = await this.activeEmail();
    return {
      activeEmail,
      activeAccountId: matchAccountByEmail(accounts, activeEmail),
    };
  }
}
