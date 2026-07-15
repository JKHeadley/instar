/**
 * SubscriptionPool — multi-account subscription registry (P1.1).
 *
 * Part of the Subscription & Auth Standard
 * (docs/specs/_drafts/subscription-auth-standard-master-spec.md).
 *
 * The source of truth for "which subscriptions does this operator have, per
 * provider." Each account is a first-class registry entry keyed to its login
 * LOCATION — its per-account config home (e.g. CLAUDE_CONFIG_DIR) — NOT its
 * tokens. This is the load-bearing invariant behind decision 1A
 * ("re-enroll per machine"): because the registry only ever stores the
 * config-home path, a leaked registry file never leaks a credential.
 *
 * Cross-machine account follow-me (WS5.2, docs/specs/ws52-account-follow-me-security.md):
 * the DEFAULT is RE-MINT PER MACHINE (Mechanism B) — each machine drives its OWN
 * operator-approved login and holds its own grant; an OAuth config-home NEVER crosses
 * machines. Only a NON-credential, redacted metadata projection replicates (the
 * `subscription-account-meta` JournalKind — id/nickname/email/provider/framework/status/
 * quota; configHome STRIPPED). Shipping each account's credential blob over E2E secret-sync
 * is Mechanism A — a SEPARATE, per-provider-allowlist, default-OFF path that is REFUSED for
 * Anthropic (its ToS prohibits relocating Claude OAuth tokens). NOT the default; do not
 * conflate the two.
 *
 * Why never tokens: Anthropic prohibits Claude OAuth tokens in non-Claude-Code
 * tools and enforces it. The pool drives each account through its real
 * framework client pointed at that account's config home; instar never extracts
 * a token. Storing only the location keeps that invariant structural.
 *
 * File-backed JSON at `<stateDir>/subscription-pool.json`, atomic tmp+rename
 * writes, optimistic CAS via a per-record `version` field. Mirrors the
 * CommitmentTracker durable-registry pattern (a simpler single-writer form).
 *
 * Ships DARK: nothing instantiates a pool with accounts unless the operator
 * enrolls one. A pool of zero accounts is a no-op — single-account agents are
 * entirely unaffected.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { ComponentHealth } from './types.js';
import type { SubscriptionAccountMetaReplicationEmitter } from './SubscriptionAccountMetaReplicatedStore.js';

// ── Types ─────────────────────────────────────────────────────────

/** Provider behind a subscription (the account's billing identity). */
export type SubscriptionProvider =
  | 'anthropic'
  | 'openai'
  | 'github-copilot'
  | 'google';

/** Framework client that drives the account. */
export type SubscriptionFramework =
  | 'claude-code'
  | 'codex-cli'
  | 'gemini-cli'
  | 'pi-cli';

/**
 * Account lifecycle status.
 *   active        — usable, login fresh
 *   warming       — being kept warm / refreshing (headless-refresh guard)
 *   rate-limited  — currently at/over a quota window
 *   needs-reauth  — login genuinely failed (refresh token revoked / pw change)
 *   disabled      — operator-disabled; scheduler never selects it
 */
export type SubscriptionAccountStatus =
  | 'active'
  | 'warming'
  | 'rate-limited'
  | 'needs-reauth'
  | 'disabled';

/**
 * Live per-account quota reading (decision C: hybrid read). Populated by the
 * QuotaPoller in P1.2 — in P1.1 it is just carried metadata (optional).
 */
export interface AccountQuotaSnapshot {
  fiveHour?: { utilizationPct: number; resetsAt: string };
  sevenDay?: { utilizationPct: number; resetsAt: string };
  /**
   * Fable-5 weekly usage window (scope.model.display_name === 'Fable' in the
   * usage API `limits[]`). Same shape as fiveHour/sevenDay so the dashboard
   * renders it with the identical quota bar.
   */
  fable?: { utilizationPct: number; resetsAt: string };
  perModel?: Record<string, number | null>;
  extraUsage?: {
    isEnabled: boolean;
    usedCredits: number;
    monthlyLimit: number;
  };
  /** Which read path produced this snapshot (decision C provenance). */
  source?: 'claude-code-usage-screen' | 'oauth-usage-endpoint-fallback' | 'codex-rollout';
  measuredAt?: string;
}

export interface SubscriptionAccount {
  /** Stable id, charset-clamped to ^[a-z0-9-]+$. */
  id: string;
  /** Operator-facing handle (editable), like a machine nickname. */
  nickname: string;
  /** Account email — the disambiguator across same-org accounts (e.g.
   *  "SageMind - Justin" vs "SageMind - Adriana"). Auto-populated from the
   *  account's own login (oauthAccount.emailAddress) on poll, so the stored email
   *  always reflects which account actually authenticated. NEVER a secret. */
  email?: string;
  /** Billing provider. */
  provider: SubscriptionProvider;
  /** Framework client that drives this account. */
  framework: SubscriptionFramework;
  /**
   * The login LOCATION — the per-account config home (CLAUDE_CONFIG_DIR for
   * claude-code). NEVER tokens. This is the swap mechanism: select an account =
   * spawn the framework pointed at this configHome.
   */
  configHome: string;
  /** Lifecycle status. */
  status: SubscriptionAccountStatus;
  /** Last known quota reading (P1.2 populates; optional in P1.1). */
  lastQuota?: AccountQuotaSnapshot | null;
  /** ISO timestamp the account was enrolled. */
  enrolledAt: string;
  /** ISO timestamp the account was last selected for a session. */
  lastUsedAt?: string;
  /**
   * ISO timestamp the poller last silently refreshed this account's access token
   * from its refresh token (P1.2 hardening). Visibility only — lets the dashboard
   * show "token auto-refreshed" so a routine access-token expiry reads as healthy
   * rather than a re-auth event.
   */
  lastRefreshAt?: string;
  /**
   * The credential currently found in this account's labelled slot proved to
   * belong to another pool account. This is first-class operational state:
   * drifted accounts are never capacity-counted or selected as swap targets.
   * It self-closes on the first identity-confirmed poll of the labelled slot.
   */
  identityDrifted?: boolean;
  /** Public, credential-free identity evidence for the active drift episode. */
  identityDrift?: {
    expectedAccountId: string;
    actualAccountId: string;
    actualEmail?: string;
    slot: string;
    detectedAt: string;
    lastConfirmedAt: string;
    repairState: 'planned' | 'dry-run' | 'repairing' | 'owner-relogin-required';
  };
  /** Monotonic version for optimistic CAS in update(). */
  version: number;
}

/**
 * WS5.2 §6.2 — "locally executable" predicate. An account is executable on THIS
 * machine iff this machine holds it with a real local `configHome` AND a valid
 * login (status active/warming, never needs-reauth/disabled/rate-limited). A
 * meta-only account replicated in from a peer (no local credential, empty
 * `configHome`) is NOT locally executable and must be invisible to every
 * account-selection / swap-target / placement path — closing the force-mode
 * "use an account I have metadata for but no credential" hole at SELECTION time.
 *
 * This is a pure tightening: every real pool account today carries a non-empty
 * `configHome` (required by `add()`), so this only ever excludes a credential-less
 * meta projection — it never changes selection among genuinely-held accounts.
 */
export function isLocallyExecutable(a: SubscriptionAccount): boolean {
  return (
    typeof a.configHome === 'string' &&
    a.configHome.trim().length > 0 &&
    (a.status === 'active' || a.status === 'warming') &&
    a.identityDrifted !== true
  );
}

interface SubscriptionPoolStore {
  version: 1;
  accounts: SubscriptionAccount[];
  lastModified: string;
}

export interface SubscriptionPoolConfig {
  /** Agent stateDir (e.g. `.instar`). The store lives at <stateDir>/subscription-pool.json. */
  stateDir: string;
}

export interface AddAccountInput {
  id: string;
  nickname: string;
  provider: SubscriptionProvider;
  framework: SubscriptionFramework;
  configHome: string;
  status?: SubscriptionAccountStatus;
  /** Optional at add time; auto-populated from the account's login on poll. */
  email?: string;
}

/** Fields an operator may patch. id/provider/enrolledAt/version are immutable here. */
export interface UpdateAccountInput {
  nickname?: string;
  framework?: SubscriptionFramework;
  configHome?: string;
  status?: SubscriptionAccountStatus;
  lastQuota?: AccountQuotaSnapshot | null;
  lastUsedAt?: string;
  lastRefreshAt?: string;
  email?: string;
  identityDrifted?: boolean;
  identityDrift?: SubscriptionAccount['identityDrift'] | null;
}

const ID_RE = /^[a-z0-9-]+$/;
const PROVIDERS: readonly SubscriptionProvider[] = [
  'anthropic',
  'openai',
  'github-copilot',
  'google',
];
const FRAMEWORKS: readonly SubscriptionFramework[] = [
  'claude-code',
  'codex-cli',
  'gemini-cli',
  'pi-cli',
];
const STATUSES: readonly SubscriptionAccountStatus[] = [
  'active',
  'warming',
  'rate-limited',
  'needs-reauth',
  'disabled',
];

/**
 * Field names that would smuggle a credential into the registry. Rejected at
 * add()/update() — the registry stores LOCATION, never secrets. This makes the
 * "never store tokens" invariant a structural guard, not a convention.
 */
const FORBIDDEN_CREDENTIAL_FIELDS = [
  'accesstoken',
  'refreshtoken',
  'token',
  'apikey',
  'api_key',
  'credential',
  'credentials',
  'secret',
  'password',
  'oauth',
];

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export class SubscriptionPool {
  private storePath: string;
  private store: SubscriptionPoolStore;
  /**
   * WS5.2 §6.1a — optional emit seam for cross-machine registry follow-me (metadata only).
   * Wired in server.ts ONLY when `multiMachine.accountFollowMe` resolves enabled; null = no
   * replication (single-machine / dark default). The pool emits a REDACTED projection
   * (projectAccountToMeta strips configHome + every credential field by allowlist) — never the
   * login location, never a token.
   */
  private metaReplication: SubscriptionAccountMetaReplicationEmitter | null = null;

  constructor(config: SubscriptionPoolConfig) {
    this.storePath = path.join(config.stateDir, 'subscription-pool.json');
    this.store = this.load();
  }

  /** Inject the follow-me meta emitter (server.ts, gated behind accountFollowMe). */
  setMetaReplicationEmitter(emitter: SubscriptionAccountMetaReplicationEmitter | null): void {
    this.metaReplication = emitter;
  }

  // ── Reads ────────────────────────────────────────────────────────

  /** All accounts (a shallow copy — callers can't mutate the store). */
  list(): SubscriptionAccount[] {
    return this.store.accounts.map((a) => ({ ...a }));
  }

  /** One account by id, or null. */
  get(id: string): SubscriptionAccount | null {
    const found = this.store.accounts.find((a) => a.id === id);
    return found ? { ...found } : null;
  }

  /**
   * WS5.2 §6.2 — accounts THIS machine can actually execute against (real local
   * `configHome` + a valid login). The canonical selectable set for the router and
   * every swap/placement path; a credential-less meta projection is excluded.
   */
  locallyExecutable(): SubscriptionAccount[] {
    return this.store.accounts.filter(isLocallyExecutable).map((a) => ({ ...a }));
  }

  /** Count of accounts. A pool of 0 is the dark/no-op default. */
  size(): number {
    return this.store.accounts.length;
  }

  // ── Writes ───────────────────────────────────────────────────────

  /**
   * Add a new account. Throws ValidationError on bad input or duplicate id.
   * `rawExtra` (if provided) is scanned for credential-bearing field names and
   * rejected — the registry never stores tokens.
   */
  add(input: AddAccountInput, rawExtra?: Record<string, unknown>): SubscriptionAccount {
    this.assertNoCredentialFields(input as unknown as Record<string, unknown>);
    if (rawExtra) this.assertNoCredentialFields(rawExtra);

    const id = (input.id ?? '').trim();
    if (!id) throw new ValidationError('id is required');
    if (!ID_RE.test(id)) {
      throw new ValidationError('id must match ^[a-z0-9-]+$');
    }
    if (this.store.accounts.some((a) => a.id === id)) {
      throw new ValidationError(`account ${id} already exists`);
    }
    const nickname = (input.nickname ?? '').trim();
    if (!nickname) throw new ValidationError('nickname is required');
    if (!PROVIDERS.includes(input.provider)) {
      throw new ValidationError(`provider must be one of: ${PROVIDERS.join(', ')}`);
    }
    if (!FRAMEWORKS.includes(input.framework)) {
      throw new ValidationError(`framework must be one of: ${FRAMEWORKS.join(', ')}`);
    }
    const configHome = (input.configHome ?? '').trim();
    if (!configHome) throw new ValidationError('configHome is required');
    const status = input.status ?? 'active';
    if (!STATUSES.includes(status)) {
      throw new ValidationError(`status must be one of: ${STATUSES.join(', ')}`);
    }

    const account: SubscriptionAccount = {
      id,
      nickname,
      ...(input.email?.trim() ? { email: input.email.trim() } : {}),
      provider: input.provider,
      framework: input.framework,
      configHome,
      status,
      lastQuota: null,
      enrolledAt: new Date().toISOString(),
      version: 1,
    };
    this.store.accounts.push(account);
    this.save();
    this.metaReplication?.emitPut(account);
    return { ...account };
  }

  /**
   * Patch a mutable account. Returns the updated account, or null if not found.
   * id/provider/enrolledAt are immutable here; version auto-increments (CAS).
   * Throws ValidationError on bad field values or credential-bearing input.
   */
  update(id: string, patch: UpdateAccountInput, rawExtra?: Record<string, unknown>): SubscriptionAccount | null {
    this.assertNoCredentialFields(patch as unknown as Record<string, unknown>);
    if (rawExtra) this.assertNoCredentialFields(rawExtra);

    const acct = this.store.accounts.find((a) => a.id === id);
    if (!acct) return null;

    if (patch.nickname !== undefined) {
      const nn = patch.nickname.trim();
      if (!nn) throw new ValidationError('nickname cannot be empty');
      acct.nickname = nn;
    }
    if (patch.framework !== undefined) {
      if (!FRAMEWORKS.includes(patch.framework)) {
        throw new ValidationError(`framework must be one of: ${FRAMEWORKS.join(', ')}`);
      }
      acct.framework = patch.framework;
    }
    if (patch.configHome !== undefined) {
      const ch = patch.configHome.trim();
      if (!ch) throw new ValidationError('configHome cannot be empty');
      acct.configHome = ch;
    }
    if (patch.status !== undefined) {
      if (!STATUSES.includes(patch.status)) {
        throw new ValidationError(`status must be one of: ${STATUSES.join(', ')}`);
      }
      acct.status = patch.status;
    }
    if (patch.lastQuota !== undefined) {
      acct.lastQuota = patch.lastQuota;
    }
    if (patch.lastUsedAt !== undefined) {
      acct.lastUsedAt = patch.lastUsedAt;
    }
    if (patch.lastRefreshAt !== undefined) {
      acct.lastRefreshAt = patch.lastRefreshAt;
    }
    if (patch.email !== undefined) {
      const em = patch.email.trim();
      acct.email = em || undefined;
    }
    if (patch.identityDrifted !== undefined) {
      acct.identityDrifted = patch.identityDrifted;
    }
    if (patch.identityDrift !== undefined) {
      if (patch.identityDrift === null) delete acct.identityDrift;
      else acct.identityDrift = { ...patch.identityDrift };
    }

    acct.version += 1;
    this.save();
    // Re-emit on any mutation — a peer must SEE a status/quota change (§6.1a holder stream).
    this.metaReplication?.emitPut(acct);
    return { ...acct };
  }

  /** Remove an account. Returns true if one was removed. */
  remove(id: string): boolean {
    const before = this.store.accounts.length;
    this.store.accounts = this.store.accounts.filter((a) => a.id !== id);
    const removed = this.store.accounts.length < before;
    if (removed) {
      this.save();
      this.metaReplication?.emitDelete(id, new Date().toISOString());
    }
    return removed;
  }

  // ── Health ───────────────────────────────────────────────────────

  getHealth(): ComponentHealth {
    const total = this.store.accounts.length;
    const usable = this.store.accounts.filter(
      (a) => (a.status === 'active' || a.status === 'warming') && !a.identityDrifted,
    ).length;
    return {
      status: 'healthy',
      message: `${total} account(s), ${usable} usable`,
      lastCheck: new Date().toISOString(),
    };
  }

  // ── Persistence ──────────────────────────────────────────────────

  private assertNoCredentialFields(obj: Record<string, unknown>): void {
    if (!obj || typeof obj !== 'object') return;
    for (const key of Object.keys(obj)) {
      if (FORBIDDEN_CREDENTIAL_FIELDS.includes(key.toLowerCase())) {
        throw new ValidationError(
          `the registry stores login LOCATION, never credentials — field "${key}" is not allowed`,
        );
      }
    }
  }

  private load(): SubscriptionPoolStore {
    try {
      if (fs.existsSync(this.storePath)) {
        const data = JSON.parse(fs.readFileSync(this.storePath, 'utf-8'));
        if (data && data.version === 1 && Array.isArray(data.accounts)) {
          // Backfill version field on any pre-CAS record (defensive).
          for (const a of data.accounts) {
            if (typeof a.version !== 'number') a.version = 1;
          }
          return data as SubscriptionPoolStore;
        }
      }
    } catch {
      // @silent-fallback-ok — corrupt/unreadable store starts fresh; the
      // registry is metadata only, never credentials, so a fresh start loses
      // nothing irrecoverable (the operator re-enrolls / accounts re-detect).
    }
    return { version: 1, accounts: [], lastModified: new Date().toISOString() };
  }

  private save(): void {
    this.store.lastModified = new Date().toISOString();
    try {
      const dir = path.dirname(this.storePath);
      fs.mkdirSync(dir, { recursive: true });
      const tmpPath = `${this.storePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(this.store, null, 2) + '\n');
      fs.renameSync(tmpPath, this.storePath);
    } catch {
      // @silent-fallback-ok — state persistence failure; the in-memory store
      // remains authoritative for this process and the next write retries.
    }
  }
}
