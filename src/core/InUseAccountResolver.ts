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

import type { CredentialLocationGate } from './CredentialLocationGate.js';
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
  /**
   * Census #8 (the E4a liar). When present AND enabled, the default-tenant badge resolves from
   * `ledger.tenantOf('~/.claude')` instead of re-probing `claude auth status` — `auth status`
   * reads `.claude.json` `oauthAccount`, which is STALE during the keychain-first/config-second
   * window after a swap, so re-probing would re-cache the WRONG tenant for the full TTL. The
   * swap-commit cache-bust (`bustCache`) keeps the badge honest across a `~/.claude` swap.
   * Absent (or flag-off / ledger-unknown) → byte-for-byte today's re-probe behavior.
   */
  locationGate?: CredentialLocationGate;
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

/** Structural minimum an account must expose to be matched by email. */
export interface EmailMatchableAccount {
  id: string;
  email?: string;
  framework?: string;
}

/**
 * Pure: normalized email equality (trimmed, case-insensitive).
 *
 * An identity oracle returns whatever casing the provider stored; a pool row holds
 * whatever casing the operator typed at enrollment. Comparing them with raw `===`
 * makes the answer depend on that accident, and the failure is silent and total —
 * a non-match is reported as "identity unavailable", which downstream reads as a
 * missing login. Every email comparison against an oracle answer goes through here.
 */
export function emailEquals(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const left = a.trim().toLowerCase();
  const right = b.trim().toLowerCase();
  return left.length > 0 && left === right;
}

/**
 * Pure: EVERY pool account an Anthropic-issued email can legitimately denote.
 *
 * The Anthropic identity oracle probes Anthropic's OAuth profile endpoint, so the
 * email it returns is an assertion about a CLAUDE login and says nothing about any
 * other provider. Scoping the candidate set to claude-code accounts is therefore part
 * of reading the oracle correctly, not an optimization: an operator who backs a Claude
 * subscription AND a Codex subscription with the same Google account has two pool rows
 * carrying one email, and an unscoped lookup sees a 2-way collision that does not exist
 * at the provider.
 *
 * The scope is `framework === 'claude-code'` and DELIBERATELY NOT `provider === 'anthropic'`
 * as well. `SubscriptionPool` validates `provider` and `framework` independently, with no
 * cross-check, so `{ provider: 'openai', framework: 'claude-code' }` is an admissible row —
 * and `buildCredentialRepairPlan` selects the accounts it plans over on `framework` ALONE.
 * A candidate predicate NARROWER than the account-selection predicate one layer up would
 * put such a row in the plan while making it unmatchable, manufacturing exactly the false
 * `missing-local-login` this function exists to delete. The candidate set must equal the
 * selection set; that invariant, not tidiness, fixes the scope.
 *
 * This is the shared definition because the rule previously lived only inside
 * `matchAccountByEmail`, and the credential identity resolver in `commands/server.ts`
 * re-implemented the lookup without it — so a dual-subscription account resolved as
 * `ambiguous/unknown email (2 pool matches)` -> `unavailable` -> `missing-local-login`,
 * telling the operator to re-authenticate a login that was present and valid. Callers with
 * different collision policies share this candidate set rather than each restating the scope.
 *
 * NOT yet converged: `CredentialLocationLedger` keeps its own scope predicate, which also
 * admits a framework-LESS legacy row. Widening this one to match would make such a row a
 * candidate without putting it in the repair plan's account set — reintroducing the
 * collision in a new shape. The two now share `emailEquals`; their scopes still differ, and
 * that is stated rather than papered over.
 */
export function claudeAccountsMatchingEmail<T extends EmailMatchableAccount>(
  accounts: readonly T[],
  email: string | null | undefined,
): T[] {
  if (!email) return [];
  return accounts.filter((a) => a.framework === 'claude-code' && emailEquals(a.email, email));
}

/** What an identity oracle can say about a slot, before the pool is consulted. */
export type SlotOracleAnswer = { email?: string; unavailable?: boolean; reason?: string };
/** What the credential identity resolver answers. */
export type SlotIdentityResolution = { accountId: string } | { unavailable: true; reason: string };

/**
 * Pure: the POOL-MAPPING half of `credResolveIdentity` (`src/commands/server.ts`).
 *
 * Extracted so the mapping can be tested against the real code path rather than against a
 * copy of it. A prior version of this fix was tested only through a hand-copied closure in
 * the test file, and a reviewer demonstrated that reverting the production callsite left
 * every test green — the suite pinned the helper and not the defect. This function is that
 * callsite.
 *
 * Collision policy: STRICT. This answer authorizes credential MOVES between config homes
 * (`CredentialSwapExecutor`), so anything other than exactly one candidate fails closed. A
 * genuine collision between two claude-code accounts sharing an email is still refused.
 */
export function resolveClaudeSlotAccountId<T extends EmailMatchableAccount>(
  accounts: readonly T[],
  oracle: SlotOracleAnswer,
): SlotIdentityResolution {
  if (oracle.unavailable || !oracle.email) {
    return { unavailable: true, reason: oracle.reason ?? 'oracle unavailable' };
  }
  const matches = claudeAccountsMatchingEmail(accounts, oracle.email);
  if (matches.length !== 1) {
    return { unavailable: true, reason: `ambiguous/unknown email (${matches.length} claude-code pool matches)` };
  }
  return { accountId: matches[0].id };
}

/**
 * Pure: match the active account email to a pool account (case-insensitive).
 * Only claude-code accounts are considered — the active Claude login cannot be a
 * codex/gemini account. Returns the account id or null.
 *
 * Collision policy: first match wins. This resolver only LABELS which account a live
 * session is using, so a wrong label self-corrects at the next probe; it authorizes no
 * write. Callers that gate a credential MUTATION must use `resolveClaudeSlotAccountId`,
 * which fails closed on a collision.
 */
export function matchAccountByEmail(
  accounts: SubscriptionAccount[],
  email: string | null,
): string | null {
  return claudeAccountsMatchingEmail(accounts, email)[0]?.id ?? null;
}

export class InUseAccountResolver {
  private readonly probe: AuthStatusProbe;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly locationGate?: CredentialLocationGate;
  private cached: { email: string | null; at: number } | null = null;
  private inFlight: Promise<string | null> | null = null;

  constructor(config: InUseAccountResolverConfig = {}) {
    this.probe = config.probe ?? defaultAuthStatusProbe;
    this.ttlMs = config.ttlMs ?? 60_000;
    this.now = config.now ?? (() => Date.now());
    this.locationGate = config.locationGate;
  }

  /**
   * Census #8: invalidate the cached probe result so the next badge read re-resolves. The swap
   * executor calls this immediately on a commit touching `~/.claude` (the keychain-first/
   * config-second window is exactly when a re-probe would re-cache the wrong tenant). Cheap +
   * idempotent — a no-op when nothing is cached.
   */
  bustCache(): void {
    this.cached = null;
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

  /**
   * Resolve which pool account the agent is currently running on.
   *
   * Census #8 (the E4a liar stays dead): when the location gate is enabled AND the ledger knows
   * the `~/.claude` tenant, the badge is resolved DIRECTLY from `ledger.tenantOf('~/.claude')` —
   * the `claude auth status` re-probe is NOT run at all. That probe reads `.claude.json`
   * `oauthAccount`, which lags during the metadata-repair window after a swap, so trusting it
   * would re-cache the wrong tenant for the full TTL. With the gate off / absent / ledger-unknown
   * the resolver falls through to its original probe-and-match path (byte-for-byte today).
   */
  async resolve(accounts: SubscriptionAccount[]): Promise<InUseResult> {
    if (this.locationGate?.isEnabled()) {
      const tenantAccountId = this.locationGate.tenantForSlot('~/.claude');
      if (tenantAccountId) {
        // Ledger is authoritative for the slot — report its tenant WITHOUT re-probing auth status.
        const acct = accounts.find((a) => a.id === tenantAccountId);
        return {
          activeAccountId: tenantAccountId,
          activeEmail: acct?.email ?? null,
        };
      }
      // Gate enabled but the ledger has no `~/.claude` record (never-seeded / UNKNOWN) → fall
      // through to today's re-probe behavior (back-compat — never break the badge).
    }
    const activeEmail = await this.activeEmail();
    return {
      activeEmail,
      activeAccountId: matchAccountByEmail(accounts, activeEmail),
    };
  }
}
