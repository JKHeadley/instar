/** Local, live Codex subscription selection for feedback triage. No credential bytes leave this module. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { parse as parseToml } from 'smol-toml';
import type { SubscriptionAccount, SubscriptionPool } from '../../core/SubscriptionPool.js';
import type { CodexUsageSnapshot } from '../../providers/adapters/openai-codex/observability/codexRateLimitReader.js';
import { readCodexSlotIdentity } from '../../providers/adapters/openai-codex/codexSlotIdentity.js';

export interface VerifiedTriageAccount {
  accountId: string;
  configHome: string;
  credentialVersion: string;
  loginAccountId: string;
  limitFamily: 'codex';
  usedPercent: number;
  acquiredAt: number;
}

export type TriageAccountSelection =
  | { state: 'eligible'; account: VerifiedTriageAccount }
  | { state: 'saturated' | 'unreadable' };

/**
 * One named account, verified the same way as a selection: it must be an active, local,
 * subscription-only codex-cli pool account whose credential identity holds across a fresh
 * live quota read below 75%. `missing` and `unverified` are distinct so an operator can tell
 * a wrong id from a signed-out or drifted login.
 */
export type PinnedAccountSelection =
  | { state: 'eligible'; account: VerifiedTriageAccount }
  | { state: 'missing' | 'unverified' | 'saturated' }
  | { state: 'unreadable'; cause: LiveReadFailureCause; attempts: number };

/**
 * Why a live quota read gave no usable percentage. Kept distinct so a refusal says what happened
 * (2026-11-28: two `pinned-account-quota-unreadable` refusals on codex-amrch were most likely
 * read timeouts, but the reason could not tell a timeout from bad data).
 */
export type LiveReadFailureCause =
  | 'timeout' | 'reader-error' | 'no-snapshot' | 'deadline'
  | 'wrong-source' | 'windows-unavailable' | 'rate-limit-reached' | 'stale-capture' | 'no-windows' | 'invalid-window';

/** The pinned path's total budget: the same 30 s the unpinned selection gets. */
export const PINNED_READ_BUDGET_MS = 30_000;
/** Each live read's own cap (unchanged) and the slack kept before the caller's deadline. */
export const LIVE_READ_TIMEOUT_MS = 4_200;
const DEADLINE_SLACK_MS = 700;
/** At most one retry, and only for a failure that may be transient. */
const PINNED_MAX_ATTEMPTS = 2;
const RETRYABLE_CAUSES: ReadonlySet<LiveReadFailureCause> = new Set(['timeout', 'reader-error', 'no-snapshot']);

/** The failure class of a snapshot that gives no usable percentage, or null when it is usable. */
export function liveTriageReadFailure(snapshot: CodexUsageSnapshot | null, now = Date.now()): LiveReadFailureCause | null {
  if (!snapshot) return 'no-snapshot';
  if (snapshot.source !== 'codex-app-server') return 'wrong-source';
  if (snapshot.windowsUnavailable) return 'windows-unavailable';
  if (snapshot.rateLimitReachedType) return 'rate-limit-reached';
  const acquired = snapshot.capturedAt ? Date.parse(snapshot.capturedAt) : NaN;
  if (!Number.isFinite(acquired) || now - acquired > 60_000 || acquired - now > 60_000) return 'stale-capture';
  const windows = [snapshot.primary, snapshot.secondary].filter((w): w is NonNullable<typeof w> => w != null);
  if (windows.length === 0) return 'no-windows';
  if (windows.some((w) => !Number.isFinite(w.usedPercent) || w.usedPercent < 0 || w.usedPercent > 100)) return 'invalid-window';
  return null;
}

export type LiveTriageQuotaReader = (opts: {
  codexHome: string; subscriptionOnly: true; timeoutMs: number; signal: AbortSignal;
}) => Promise<CodexUsageSnapshot | null>;

function credentialVersion(home: string): string | null {
  try {
    const bytes = fs.readFileSync(path.join(home, 'auth.json'));
    return createHash('sha256').update(bytes).digest('hex');
  } catch { return null; }
}

function eligiblePoolAccount(account: SubscriptionAccount): boolean {
  return account.framework === 'codex-cli' && account.status === 'active' &&
    account.identityDrifted !== true && typeof account.configHome === 'string' &&
    account.configHome.trim().length > 0;
}

function subscriptionAuthSafe(home: string): boolean {
  try {
    const auth = JSON.parse(fs.readFileSync(path.join(home, 'auth.json'), 'utf8')) as Record<string, unknown>;
    const tokens = auth.tokens && typeof auth.tokens === 'object' ? auth.tokens as Record<string, unknown> : {};
    for (const key of ['OPENAI_API_KEY', 'api_key', 'apiKey', 'openai_api_key']) {
      if (auth[key] || tokens[key]) return false;
    }
    const configPath = path.join(home, 'config.toml');
    if (fs.existsSync(configPath)) {
      const config = parseToml(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
      if (config.model_provider !== undefined && config.model_provider !== 'openai') return false;
      if (config.model_providers !== undefined || config.openai_base_url !== undefined ||
        config.chatgpt_base_url !== undefined) return false;
    }
    return true;
  } catch { return false; }
}

function verifiedIdentity(account: SubscriptionAccount): { version: string; loginAccountId: string } | null {
  if (!eligiblePoolAccount(account)) return null;
  const home = path.resolve(account.configHome);
  const version = credentialVersion(home);
  const identity = readCodexSlotIdentity(home);
  if (!version || !subscriptionAuthSafe(home) || identity.unavailable || !identity.accountId || !identity.email ||
    identity.email.toLowerCase() !== account.email.toLowerCase()) return null;
  return { version, loginAccountId: identity.accountId };
}

/** The bound account must remain active with the same local credential before model launch. */
export function revalidateTriageAccount(pool: SubscriptionPool, selected: VerifiedTriageAccount, now = Date.now()): boolean {
  if (now - selected.acquiredAt > 60_000 || selected.acquiredAt - now > 60_000) return false;
  return verifyTriageExecutionIdentity(pool, selected);
}

/** Post-launch observation: credential identity only; quota age does not expire an already running call. */
export function verifyTriageExecutionIdentity(pool: SubscriptionPool, selected: VerifiedTriageAccount): boolean {
  const current = pool.list().find((a) => a.id === selected.accountId);
  if (!current || !eligiblePoolAccount(current) || path.resolve(current.configHome) !== selected.configHome) return false;
  const identity = verifiedIdentity(current);
  return identity?.version === selected.credentialVersion && identity.loginAccountId === selected.loginAccountId;
}

/**
 * The reader parser admits only the `codex` family. A live acquisition is the
 * observation for this app-server method; cached rollout snapshots are refused.
 */
export function liveTriageUsedPercent(snapshot: CodexUsageSnapshot | null, now = Date.now()): number | null {
  if (!snapshot || snapshot.source !== 'codex-app-server' || snapshot.windowsUnavailable ||
    snapshot.rateLimitReachedType) return null;
  const acquired = snapshot.capturedAt ? Date.parse(snapshot.capturedAt) : NaN;
  if (!Number.isFinite(acquired) || now - acquired > 60_000 || acquired - now > 60_000) return null;
  const windows = [snapshot.primary, snapshot.secondary].filter((w): w is NonNullable<typeof w> => w != null);
  if (windows.length === 0 || windows.some((w) => !Number.isFinite(w.usedPercent) || w.usedPercent < 0 || w.usedPercent > 100)) return null;
  return Math.max(...windows.map((w) => w.usedPercent));
}

export class FeedbackTriageAccountSelector {
  private cursor = 0;
  constructor(
    private readonly pool: SubscriptionPool,
    private readonly reader: LiveTriageQuotaReader,
    private readonly now: () => number = Date.now,
  ) {}

  async select(deadlineAt = this.now() + 30_000): Promise<TriageAccountSelection> {
    const startedAt = this.now();
    const budgetEnd = Math.min(deadlineAt, startedAt + 30_000);
    const candidates = this.pool.list().filter(eligiblePoolAccount);
    if (candidates.length === 0) return { state: 'unreadable' };
    const start = this.cursor % candidates.length;
    this.cursor = (start + 1) % candidates.length;
    const ordered = [...candidates.slice(start), ...candidates.slice(0, start)];
    let sawSaturated = false;

    for (let i = 0; i < ordered.length && this.now() < budgetEnd; i += 2) {
      const wave = ordered.slice(i, i + 2);
      const remaining = Math.min(5_000, budgetEnd - this.now());
      if (remaining <= 700) break;
      const controllers = wave.map(() => new AbortController());
      const reads = wave.map(async (account, index): Promise<VerifiedTriageAccount | null> => {
        const before = verifiedIdentity(account);
        if (!before) return null;
        const snapshot = await this.reader({
          codexHome: path.resolve(account.configHome), subscriptionOnly: true,
          timeoutMs: Math.min(4_200, remaining - 700), signal: controllers[index].signal,
        }).catch(() => null);
        const after = verifiedIdentity(account);
        if (!after || after.version !== before.version || after.loginAccountId !== before.loginAccountId) return null;
        const usedPercent = liveTriageUsedPercent(snapshot, this.now());
        if (usedPercent === null) return null;
        if (usedPercent >= 75) { sawSaturated = true; return null; }
        return {
          accountId: account.id, configHome: path.resolve(account.configHome),
          credentialVersion: after.version, loginAccountId: after.loginAccountId,
          limitFamily: 'codex', usedPercent,
          acquiredAt: Date.parse(snapshot!.capturedAt!),
        };
      });
      const firstEligible = Promise.any(reads.map(async (read) => {
        const value = await read;
        if (!value) throw new Error('ineligible');
        return value;
      })).catch(() => null);
      const winner = await firstEligible;
      controllers.forEach((controller) => controller.abort());
      const settled = await Promise.allSettled(reads);
      const eligible = settled.flatMap((result) => result.status === 'fulfilled' && result.value ? [result.value] : []);
      if (winner && !eligible.some((account) => account.accountId === winner.accountId)) eligible.push(winner);
      const fresh = eligible.filter((account) => revalidateTriageAccount(this.pool, account, this.now()));
      fresh.sort((a, b) => a.usedPercent - b.usedPercent || a.accountId.localeCompare(b.accountId));
      if (fresh[0]) return { state: 'eligible', account: fresh[0] };
    }
    return { state: sawSaturated ? 'saturated' : 'unreadable' };
  }

  /** Ambient account choice for off/observe still needs a local, verified subscription. */
  ambientAccount(): SubscriptionAccount | null {
    const home = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
    return this.pool.list().find((account) => eligiblePoolAccount(account) && path.resolve(account.configHome) === home) ?? null;
  }

  /**
   * Exactly the named pool account, or a named refusal. Never another account: a caller that
   * pins an account must not be served by a neighbour when the pinned one is unavailable.
   */
  async selectPinned(accountId: string, deadlineAt = this.now() + PINNED_READ_BUDGET_MS): Promise<PinnedAccountSelection> {
    const account = this.pool.list().find((entry) => entry.id === accountId);
    if (!account) return { state: 'missing' };
    const before = verifiedIdentity(account);
    if (!before) return { state: 'unverified' };
    // The same budget the unpinned selection gets (it was capped at 5 s here), bounded by the
    // caller's deadline, with at most one retry of a possibly transient read failure.
    const budgetEnd = Math.min(deadlineAt, this.now() + PINNED_READ_BUDGET_MS);
    let snapshot: CodexUsageSnapshot | null = null;
    let usedPercent: number | null = null;
    let cause: LiveReadFailureCause = 'deadline';
    let attempts = 0;
    while (attempts < PINNED_MAX_ATTEMPTS) {
      const remaining = budgetEnd - this.now();
      if (remaining <= DEADLINE_SLACK_MS) { if (attempts === 0) cause = 'deadline'; break; }
      attempts++;
      const timeoutMs = Math.min(LIVE_READ_TIMEOUT_MS, remaining - DEADLINE_SLACK_MS);
      const controller = new AbortController();
      const startedAt = this.now();
      let threw = false;
      snapshot = await this.reader({ codexHome: path.resolve(account.configHome), subscriptionOnly: true,
        timeoutMs, signal: controller.signal }).catch(() => { threw = true; return null; });
      const elapsed = this.now() - startedAt;
      const after = verifiedIdentity(account);
      if (!after || after.version !== before.version || after.loginAccountId !== before.loginAccountId) return { state: 'unverified' };
      usedPercent = liveTriageUsedPercent(snapshot, this.now());
      if (usedPercent !== null) break;
      cause = snapshot === null
        ? (elapsed >= timeoutMs - 50 ? 'timeout' : threw ? 'reader-error' : 'no-snapshot')
        : (liveTriageReadFailure(snapshot, this.now()) ?? 'no-snapshot');
      if (!RETRYABLE_CAUSES.has(cause)) break;
    }
    if (usedPercent === null) return { state: 'unreadable', cause, attempts };
    if (usedPercent >= 75) return { state: 'saturated' };
    // Every attempt re-checked that the identity still equals `before`, so `before` is the identity
    // the successful read ran under.
    const selected: VerifiedTriageAccount = { accountId: account.id, configHome: path.resolve(account.configHome),
      credentialVersion: before.version, loginAccountId: before.loginAccountId, limitFamily: 'codex',
      usedPercent, acquiredAt: Date.parse(snapshot!.capturedAt!) };
    return revalidateTriageAccount(this.pool, selected, this.now()) ? { state: 'eligible', account: selected } : { state: 'unverified' };
  }

  async selectAmbient(deadlineAt = this.now() + 5_000): Promise<TriageAccountSelection> {
    const account = this.ambientAccount();
    if (!account) return { state: 'unreadable' };
    const before = verifiedIdentity(account);
    if (!before) return { state: 'unreadable' };
    const remaining = Math.min(5_000, deadlineAt - this.now());
    if (remaining <= 700) return { state: 'unreadable' };
    const controller = new AbortController();
    const snapshot = await this.reader({ codexHome: path.resolve(account.configHome), subscriptionOnly: true,
      timeoutMs: Math.min(4_200, remaining - 700), signal: controller.signal }).catch(() => null);
    const after = verifiedIdentity(account);
    if (!after || after.version !== before.version || after.loginAccountId !== before.loginAccountId) return { state: 'unreadable' };
    const usedPercent = liveTriageUsedPercent(snapshot, this.now());
    if (usedPercent === null) return { state: 'unreadable' };
    if (usedPercent >= 75) return { state: 'saturated' };
    return { state: 'eligible', account: { accountId: account.id, configHome: path.resolve(account.configHome),
      credentialVersion: after.version, loginAccountId: after.loginAccountId, limitFamily: 'codex',
      usedPercent, acquiredAt: Date.parse(snapshot!.capturedAt!) } };
  }
}
