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
import type { IdentityOracle } from './CredentialLocationLedger.js';

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
  email: string;
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

/** True only for the explicit local-login-loss drift episode. Drift of a
 * different kind remains quarantined but does not authorize a session kill. */
export function requiresOwnerRelogin(account: SubscriptionAccount): boolean {
  const drift = account.identityDrift;
  return account.identityDrifted === true && !!drift && (
    drift.repairState === 'owner-relogin-required' ||
    drift.actualAccountId === 'missing-local-login'
  );
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
  accounts: StoredSubscriptionAccount[];
  lastModified: string;
}

type StoredSubscriptionAccount = Omit<SubscriptionAccount, 'email'> & { email?: string };

export interface SubscriptionAccountEmailGap {
  accountId: string;
  nickname: string;
  provider: SubscriptionProvider;
  framework: SubscriptionFramework;
  configHome: string;
  status: SubscriptionAccountStatus;
  identityDrifted: boolean;
}

export interface SubscriptionPoolConfig {
  /** Agent stateDir (e.g. `.instar`). The store lives at <stateDir>/subscription-pool.json. */
  stateDir: string;
}

export interface SubscriptionEmailBindingAuthority {
  tenantOf(slot: string): string | null;
  readonly version: number;
}

export class SubscriptionEmailReconciliationBarrier {
  private phase: 'running' | 'complete' | 'degraded' = 'running';
  private unresolved = 0;
  private readonly timedOut = new Set<string>();
  status(): 'running' | 'complete' | 'degraded' { return this.phase; }
  finish(unresolved: number | Array<{ accountId: string; reason: string }>): void {
    const rows = typeof unresolved === 'number' ? null : unresolved;
    this.unresolved = rows?.length ?? unresolved as number;
    this.timedOut.clear();
    for (const row of rows ?? []) {
      if (row.reason === 'reconciliation-timeout') this.timedOut.add(row.accountId);
    }
    this.phase = this.unresolved > 0 ? 'degraded' : 'complete';
  }
  isBlocking(): boolean { return this.phase === 'running'; }
  timedOutAccount(accountId: string): boolean { return this.timedOut.has(accountId); }
  snapshot(): {
    state: 'running' | 'complete' | 'degraded';
    unresolvedCount: number;
    repairRunsFreshProbe: true;
  } {
    return {
      state: this.phase,
      unresolvedCount: this.unresolved,
      repairRunsFreshProbe: true,
    };
  }
}

export interface AddAccountInput {
  id: string;
  nickname: string;
  provider: SubscriptionProvider;
  framework: SubscriptionFramework;
  configHome: string;
  status?: SubscriptionAccountStatus;
  /** Provider-attested identity. Registration callers cannot omit it. */
  email: string;
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
const VERIFIED_EMAIL_COMMIT = Symbol('verified-email-commit');
const VERIFIED_ACCOUNT_ADD = Symbol('verified-account-add');

/** Provider-scoped identity comparison; intentionally does not rewrite aliases. */
export function normalizeSubscriptionEmail(value: unknown): { display: string; key: string } {
  if (typeof value !== 'string') throw new ValidationError('email is required');
  const display = value.trim();
  if (
    !display ||
    display.length > 254 ||
    /[\x00-\x1f\x7f]/.test(display) ||
    display.startsWith('@') ||
    display.endsWith('@') ||
    display.split('@').length !== 2
  ) {
    throw new ValidationError('email must be a valid non-blank provider account email');
  }
  return { display, key: display.toLowerCase() };
}

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
    return this.store.accounts
      .filter((a): a is SubscriptionAccount => typeof a.email === 'string' && a.email.trim().length > 0)
      .map((a) => ({ ...a }));
  }

  /** Legacy rows are visible for repair, but never enter normal selectors. */
  listEmailGaps(): SubscriptionAccountEmailGap[] {
    return this.store.accounts
      .filter((a) => !a.email?.trim())
      .map((a) => ({
        accountId: a.id,
        nickname: a.nickname,
        provider: a.provider,
        framework: a.framework,
        configHome: a.configHome,
        status: a.status,
        identityDrifted: a.identityDrifted === true,
      }));
  }

  /** One account by id, or null. */
  get(id: string): SubscriptionAccount | null {
    const found = this.store.accounts.find((a) => a.id === id);
    return found?.email?.trim() ? { ...found, email: found.email } : null;
  }

  /**
   * WS5.2 §6.2 — accounts THIS machine can actually execute against (real local
   * `configHome` + a valid login). The canonical selectable set for the router and
   * every swap/placement path; a credential-less meta projection is excluded.
   */
  locallyExecutable(): SubscriptionAccount[] {
    return this.list().filter(isLocallyExecutable);
  }

  /** Count of accounts. A pool of 0 is the dark/no-op default. */
  size(): number {
    return this.list().length;
  }

  // ── Writes ───────────────────────────────────────────────────────

  /**
   * Add a new account. Throws ValidationError on bad input or duplicate id.
   * `rawExtra` (if provided) is scanned for credential-bearing field names and
   * rejected — the registry never stores tokens.
   */
  [VERIFIED_ACCOUNT_ADD](input: AddAccountInput, rawExtra?: Record<string, unknown>): SubscriptionAccount {
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

    const email = normalizeSubscriptionEmail(input.email).display;
    const account: SubscriptionAccount = {
      id,
      nickname,
      email,
      provider: input.provider,
      framework: input.framework,
      configHome,
      status,
      lastQuota: null,
      enrolledAt: new Date().toISOString(),
      version: 1,
    };
    const next = this.cloneStore();
    next.accounts.push(account);
    this.persist(next);
    this.store = next;
    this.metaReplication?.emitPut(account);
    return { ...account };
  }

  /** Test-only fixture seam. Production identity admission is symbol-gated. */
  addFixture(input: AddAccountInput, rawExtra?: Record<string, unknown>): SubscriptionAccount {
    if (process.env.NODE_ENV !== 'test') {
      throw new ValidationError('addFixture is available only in the test environment');
    }
    return this[VERIFIED_ACCOUNT_ADD](input, rawExtra);
  }

  /**
   * Identity-authority commit seam. Only SubscriptionAccountEmailRegistrar,
   * defined in this module, possesses the symbol needed to call it.
   */
  [VERIFIED_EMAIL_COMMIT](
    id: string,
    email: string,
    patch?: Pick<UpdateAccountInput, 'nickname' | 'configHome' | 'status'>,
  ): SubscriptionAccount | null {
    const next = this.cloneStore();
    const acct = next.accounts.find((candidate) => candidate.id === id);
    if (!acct) return null;
    acct.email = normalizeSubscriptionEmail(email).display;
    if (patch?.nickname !== undefined) {
      const nickname = patch.nickname.trim();
      if (!nickname) throw new ValidationError('nickname cannot be empty');
      acct.nickname = nickname;
    }
    if (patch?.configHome !== undefined) {
      const configHome = patch.configHome.trim();
      if (!configHome) throw new ValidationError('configHome cannot be empty');
      acct.configHome = configHome;
    }
    if (patch?.status !== undefined) {
      if (!STATUSES.includes(patch.status)) {
        throw new ValidationError(`status must be one of: ${STATUSES.join(', ')}`);
      }
      acct.status = patch.status;
    }
    acct.version += 1;
    this.persist(next);
    this.store = next;
    this.metaReplication?.emitPut(acct as SubscriptionAccount);
    return { ...acct } as SubscriptionAccount;
  }

  /**
   * Patch a mutable account. Returns the updated account, or null if not found.
   * id/provider/enrolledAt are immutable here; version auto-increments (CAS).
   * Throws ValidationError on bad field values or credential-bearing input.
   */
  update(id: string, patch: UpdateAccountInput, rawExtra?: Record<string, unknown>): SubscriptionAccount | null {
    this.assertNoCredentialFields(patch as unknown as Record<string, unknown>);
    if (rawExtra) this.assertNoCredentialFields(rawExtra);

    const existing = this.store.accounts.find((a) => a.id === id);
    if (!existing?.email?.trim()) return null;
    const next = this.cloneStore();
    const acct = next.accounts.find((a) => a.id === id)!;
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
    if (patch.identityDrifted !== undefined) {
      acct.identityDrifted = patch.identityDrifted;
    }
    if (patch.identityDrift !== undefined) {
      if (patch.identityDrift === null) delete acct.identityDrift;
      else acct.identityDrift = { ...patch.identityDrift };
    }

    acct.version += 1;
    this.persist(next);
    this.store = next;
    // Re-emit on any mutation — a peer must SEE a status/quota change (§6.1a holder stream).
    this.metaReplication?.emitPut(acct as SubscriptionAccount);
    return { ...acct } as SubscriptionAccount;
  }

  /** Remove an account. Returns true if one was removed. */
  remove(id: string): boolean {
    const next = this.cloneStore();
    const before = next.accounts.length;
    next.accounts = next.accounts.filter((a) => a.id !== id);
    const removed = next.accounts.length < before;
    if (removed) {
      this.persist(next);
      this.store = next;
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

  private cloneStore(): SubscriptionPoolStore {
    return structuredClone(this.store);
  }

  private persist(next: SubscriptionPoolStore): void {
    next.lastModified = new Date().toISOString();
    const dir = path.dirname(this.storePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmpPath = `${this.storePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(next, null, 2) + '\n');
    fs.renameSync(tmpPath, this.storePath);
  }
}

/**
 * The sole authority that turns credential identity evidence into a pool email.
 * Generic pool mutation deliberately cannot create, replace, or repair identity.
 */
export class SubscriptionAccountEmailRegistrar {
  constructor(
    private readonly pool: SubscriptionPool,
    private readonly oracle: IdentityOracle,
    private readonly binding?: SubscriptionEmailBindingAuthority,
  ) {}

  async register(
    input: Omit<AddAccountInput, 'email'> & { email?: string },
    rawExtra?: Record<string, unknown>,
  ): Promise<SubscriptionAccount> {
    const identity = await this.oracle.resolveSlotTenant(input.configHome);
    if (identity.unavailable || !identity.email) {
      throw new SubscriptionIdentityError(
        'subscription-account-email-unresolved',
        'The credential slot identity could not be verified. Sign in to that slot, then try again.',
      );
    }
    const attested = normalizeSubscriptionEmail(identity.email);
    if (input.email !== undefined && normalizeSubscriptionEmail(input.email).key !== attested.key) {
      throw new SubscriptionIdentityError(
        'subscription-account-email-mismatch',
        'The supplied email does not match the account signed in at this credential slot.',
      );
    }
    return this.pool[VERIFIED_ACCOUNT_ADD]({ ...input, email: attested.display }, rawExtra);
  }

  completeNewValidated(input: AddAccountInput): SubscriptionAccount {
    return this.pool[VERIFIED_ACCOUNT_ADD](input);
  }

  async repairLegacy(
    accountId: string,
    options: { canCommit?: () => boolean } = {},
  ): Promise<SubscriptionAccount> {
    const gap = this.pool.listEmailGaps().find((candidate) => candidate.accountId === accountId);
    if (!gap) {
      throw new SubscriptionIdentityError(
        'subscription-account-not-found',
        `Subscription account "${accountId}" has no repairable email gap.`,
      );
    }
    if (gap.identityDrifted) {
      throw new SubscriptionIdentityError(
        'identity-drifted',
        `Subscription account "${accountId}" is identity-drifted and cannot be repaired automatically.`,
      );
    }
    if (gap.provider !== 'anthropic' || gap.framework !== 'claude-code') {
      throw new SubscriptionIdentityError(
        'subscription-account-identity-provider-unsupported',
        `Provider identity verification is not supported for ${gap.provider}/${gap.framework}.`,
      );
    }
    const epoch = this.binding?.version;
    if (!this.binding || this.binding.tenantOf(gap.configHome) !== accountId) {
      throw new SubscriptionIdentityError(
        'account-binding-unproven',
        `Subscription account "${accountId}" is not bound to its credential slot.`,
      );
    }
    const identity = await this.oracle.resolveSlotTenant(gap.configHome);
    if (identity.unavailable || !identity.email) {
      throw new SubscriptionIdentityError(
        'identity-oracle-unavailable',
        'The credential slot identity could not be verified.',
      );
    }
    if (this.binding.version !== epoch || this.binding.tenantOf(gap.configHome) !== accountId) {
      throw new SubscriptionIdentityError(
        'account-binding-changed',
        `Subscription account "${accountId}" changed credential binding during repair.`,
      );
    }
    if (options.canCommit && !options.canCommit()) {
      throw new SubscriptionIdentityError(
        'reconciliation-timeout',
        `Subscription account "${accountId}" was not repaired before the reconciliation deadline.`,
      );
    }
    return this.pool[VERIFIED_EMAIL_COMMIT](accountId, identity.email)!;
  }

  /**
   * A completed enrollment has already passed EnrollmentWizard's expected-email
   * validation, so its provider-returned email is credential-attested evidence.
   */
  completeValidated(
    accountId: string,
    email: string,
    patch: Pick<UpdateAccountInput, 'nickname' | 'configHome' | 'status'>,
  ): SubscriptionAccount | null {
    return this.pool[VERIFIED_EMAIL_COMMIT](accountId, email, patch);
  }
}

export class SubscriptionIdentityError extends Error {
  constructor(
    readonly code: 'subscription-account-email-unresolved' | 'subscription-account-email-mismatch' |
      'identity-oracle-unavailable' | 'subscription-account-not-found' | 'identity-drifted' |
      'account-binding-unproven' | 'account-binding-changed' |
      'subscription-account-identity-provider-unsupported' | 'reconciliation-timeout',
    message: string,
  ) {
    super(message);
    this.name = 'SubscriptionIdentityError';
  }
}
