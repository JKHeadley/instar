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
 * ("re-enroll per machine now, architect for cross-machine sync later"):
 * because the registry only ever stores the config-home path, a future
 * cross-machine sync (decision 1B) is a clean bolt-on that ships each account's
 * credential blob over the existing E2E secret-sync — the registry itself never
 * has to change shape, and a leaked registry file never leaks a credential.
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
  perModel?: Record<string, number | null>;
  extraUsage?: {
    isEnabled: boolean;
    usedCredits: number;
    monthlyLimit: number;
  };
  /** Which read path produced this snapshot (decision C provenance). */
  source?: 'claude-code-usage-screen' | 'oauth-usage-endpoint-fallback';
  measuredAt?: string;
}

export interface SubscriptionAccount {
  /** Stable id, charset-clamped to ^[a-z0-9-]+$. */
  id: string;
  /** Operator-facing handle (editable), like a machine nickname. */
  nickname: string;
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
  /** Monotonic version for optimistic CAS in update(). */
  version: number;
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
}

/** Fields an operator may patch. id/provider/enrolledAt/version are immutable here. */
export interface UpdateAccountInput {
  nickname?: string;
  framework?: SubscriptionFramework;
  configHome?: string;
  status?: SubscriptionAccountStatus;
  lastQuota?: AccountQuotaSnapshot | null;
  lastUsedAt?: string;
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

  constructor(config: SubscriptionPoolConfig) {
    this.storePath = path.join(config.stateDir, 'subscription-pool.json');
    this.store = this.load();
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

    acct.version += 1;
    this.save();
    return { ...acct };
  }

  /** Remove an account. Returns true if one was removed. */
  remove(id: string): boolean {
    const before = this.store.accounts.length;
    this.store.accounts = this.store.accounts.filter((a) => a.id !== id);
    const removed = this.store.accounts.length < before;
    if (removed) this.save();
    return removed;
  }

  // ── Health ───────────────────────────────────────────────────────

  getHealth(): ComponentHealth {
    const total = this.store.accounts.length;
    const usable = this.store.accounts.filter(
      (a) => a.status === 'active' || a.status === 'warming',
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
