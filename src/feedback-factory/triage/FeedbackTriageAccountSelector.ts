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
