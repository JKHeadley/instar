/**
 * CredentialIdentityOracle — Step 3 of live credential re-pointing (spec §2.3 verify, §2.11).
 *
 * The ONLY oracle that reads credential REALITY: given a config-home slot, it reads the slot's
 * current credential blob, takes its OAuth access token, and asks the Anthropic OAuth profile
 * endpoint (`GET /api/oauth/profile`) which account that token belongs to. `claude auth status`
 * is disqualified (E4a — it reads a metadata file, not the live credential, and lies during the
 * keychain-first/config-second swap window); the config `oauthAccount` record is metadata, not
 * truth. The profile endpoint is the truth-oracle the convergence experiments (E4b) adopted.
 *
 * It implements the `IdentityOracle` interface the `CredentialLocationLedger` (Step 2) seeds and
 * recovers from. Separation of concerns: this oracle returns the RAW probed email (or an
 * `unavailable` result); the LEDGER maps email → accountId through the pool and decides what to
 * do on an ambiguous/unknown match. That keeps the pool-mapping policy in one place (§2.2).
 *
 * §2.11 classification CONTRACT — `email` set IFF the profile returned a non-empty string email;
 * EVERY other outcome (no token / fetch error / non-2xx (incl. 401/403/429/5xx) / unparseable /
 * missing-or-empty-or-nonstring email) → `unavailable` with a reason. NEVER a "mismatch": an
 * unverifiable slot is quarantine-never-repair upstream, never a guess.
 *
 * Reuses `readClaudeOauth` (OAuthRefresher) for the per-slot blob read — no hand-rolled keychain
 * access. The profile fetch lives here behind a bounded timeout; this file is allowlisted in
 * `scripts/lint-no-direct-llm-http.js` for the SAME reason QuotaCollector is — an OAuth profile
 * call is identity bookkeeping, not an LLM message call.
 *
 * NOTE (tracked to Step 4/5): when the slot's access token is EXPIRED, the spec's optimization is
 * one refresh exchange (through the credential write funnel) before the profile call to avoid a
 * spurious `unavailable`. That refresh WRITES a rotated token, so it must go through the Step-4
 * write funnel — until that lands, an expired token classifies as `unavailable` (the safe
 * direction: the slot is quarantined and re-probed, never guessed). The profile call here writes
 * nothing.
 */

import { readClaudeOauth, type CredentialStore } from './OAuthRefresher.js';
import type { IdentityOracle, IdentityOracleResult } from './CredentialLocationLedger.js';

const OAUTH_PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile';
const DEFAULT_TIMEOUT_MS = 10_000;

/** Minimal fetch shape (matches the global fetch Response subset the oracle uses). */
export type OracleFetch = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export interface CredentialIdentityOracleDeps {
  /** Credential store to read each slot's blob from (defaults to the real keychain/file store). */
  store?: CredentialStore;
  /** Injectable fetch for tests; defaults to the global fetch. */
  fetchImpl?: OracleFetch;
  /** Per-call profile-fetch timeout (ms). */
  timeoutMs?: number;
}

export class CredentialIdentityOracle implements IdentityOracle {
  private readonly store?: CredentialStore;
  private readonly fetchImpl: OracleFetch;
  private readonly timeoutMs: number;

  constructor(deps: CredentialIdentityOracleDeps = {}) {
    this.store = deps.store;
    this.fetchImpl =
      deps.fetchImpl ??
      ((url, init) => fetch(url, init as RequestInit) as unknown as ReturnType<OracleFetch>);
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async resolveSlotTenant(slot: string): Promise<IdentityOracleResult> {
    // 1. Read the slot's current credential blob → access token. (No write; reuses OAuthRefresher.)
    const oauth = this.store ? readClaudeOauth(slot, this.store) : readClaudeOauth(slot);
    const token = oauth?.accessToken;
    if (!token || typeof token !== 'string') {
      return { unavailable: true, reason: 'no access token in slot credential store' };
    }

    // 2. Probe the profile endpoint with the slot's token. Bounded; any failure → unavailable.
    let resp: { ok: boolean; status: number; json: () => Promise<unknown> };
    try {
      resp = await this.fetchImpl(OAUTH_PROFILE_URL, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'anthropic-beta': 'oauth-2025-04-20',
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      return { unavailable: true, reason: `profile fetch error: ${(err as Error)?.message ?? 'unknown'}` };
    }

    if (!resp.ok) {
      // 401/403/429/5xx all land here — never a mismatch, always unavailable (§2.11).
      return { unavailable: true, reason: `profile endpoint returned ${resp.status}` };
    }

    // 3. Parse + extract the owning email.
    let data: unknown;
    try {
      data = await resp.json();
    } catch {
      return { unavailable: true, reason: 'unparseable profile response' };
    }
    const email = (data as { account?: { email?: unknown } })?.account?.email;
    if (typeof email !== 'string' || email.length === 0) {
      return { unavailable: true, reason: 'profile response carried no usable email' };
    }
    return { email };
  }
}
