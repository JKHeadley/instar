/** Explicit manual Codex balancing; no timer, new-work routing or automatic session movement. */
import fs from 'node:fs';
import { CODEX_CLI_FRAMEWORK } from './frameworkFacts.js';
import path from 'node:path';
import { SafeFsExecutor } from './SafeFsExecutor.js';
import { isLocallyExecutable, isDeviceLimitBenched, type SubscriptionAccount } from './SubscriptionPool.js';
import { identityKey, PACING, sameReset, type LoginSummary } from '../monitoring/quotaPacing.js';
import { FRESH_READING_MS, isValidState, WEEKLY_WINDOW_MS, windowNow } from './windowAwareChoice.js';
import type { SwapResult } from './QuotaAwareScheduler.js';

export interface BalanceSession {
  id: string; tmuxSession: string; framework?: string; subscriptionAccountId?: string; status: string;
}
export interface BalancePick { accountId: string; score: number }
interface RankedBalancePick extends BalancePick { running: number }

const HOUR_MS = 3_600_000;

/** Compare forecast gaps and observed fresh resets in separate ranking groups. */
export function selectManualBalanceTarget(accounts: SubscriptionAccount[], summaries: LoginSummary[], sessions: BalanceSession[],
  sourceId: string, now: number, softThreshold = 90, homeReady = (home: string): boolean => {
    try { fs.accessSync(home, fs.constants.R_OK | fs.constants.W_OK); return fs.statSync(home).isDirectory(); } catch { return false; } // @silent-fallback-ok: inaccessible local home is ineligible
  }): BalancePick | null {
  const soft = Math.min(softThreshold, 100);
  if (!Number.isFinite(soft) || soft <= 0) return null;
  const source = accounts.find(account => account.id === sourceId);
  const sourceIdentity = source ? identityKey(source.provider, source.email) : null;
  const scored: RankedBalancePick[] = [];
  const freshResets: RankedBalancePick[] = [];
  for (const account of accounts) {
    if (account.id === sourceId || account.framework !== CODEX_CLI_FRAMEWORK || account.provider !== 'openai' || account.status !== 'active'
      || !isLocallyExecutable(account) || isDeviceLimitBenched(account) || account.deviceLimitSuspectedAt
      || !path.isAbsolute(account.configHome) || !homeReady(account.configHome)) continue;
    const identity = identityKey(account.provider, account.email);
    if (!identity || identity === sourceIdentity) continue;
    const measured = Date.parse(account.lastQuota?.measuredAt ?? '');
    if (!Number.isFinite(measured) || measured > now || now - measured >= FRESH_READING_MS || account.lastQuota?.measuredAtSynthesized) continue;
    const weekly = windowNow(account.lastQuota, 'sevenDay', now, { provider: account.provider });
    const five = windowNow(account.lastQuota, 'fiveHour', now, { provider: account.provider });
    const hasRoom = (reading: typeof weekly) => isValidState(reading.state) && reading.pct !== null && reading.pct >= 0 && reading.pct < soft;
    if (!hasRoom(weekly) || (five.state !== 'not-offered' && !hasRoom(five))) continue;
    const matching = summaries.filter(s => s.accountId === account.id && s.identity === identity && s.provider === 'openai' && s.framework === CODEX_CLI_FRAMEWORK);
    if (matching.length !== 1) continue;
    const summary = matching[0]; const forecast = summary.sevenDay;
    const time = Date.parse(summary.newestMeasuredAt ?? '');
    const forecastReset = Date.parse(forecast?.resetsAt ?? '');
    if (!summary.fresh || summary.drifted || summary.measuredAtSynthesized || summary.sourceKind !== 'live'
      || !Number.isFinite(time) || time > now || now - time >= FRESH_READING_MS || !forecast
      || !Number.isFinite(forecast.hoursLeft) || forecast.hoursLeft === null || forecast.hoursLeft <= 0
      || weekly.resetsAtMs === null || !sameReset(forecastReset, weekly.resetsAtMs)) continue;
    const hoursLeft = (weekly.resetsAtMs - now) / HOUR_MS;
    if (!Number.isFinite(hoursLeft) || hoursLeft <= 0) continue;
    // The local weekly sample proves zero; summary freshness can describe another window.
    const windowStart = Math.max(weekly.resetsAtMs, forecastReset) - WEEKLY_WINDOW_MS;
    const freshReset = forecast.central === null && forecast.reason === 'not-enough-readings'
      && account.lastQuota?.source === 'codex-app-server' && weekly.pct === 0 && forecast.used === 0
      && measured >= windowStart && now - windowStart < PACING.SLOPE_SEGMENT.minSpanH * HOUR_MS;
    const aliases = new Set(accounts.filter(a => identityKey(a.provider, a.email) === identity).map(a => a.id));
    const running = sessions.filter(s => s.status === 'running' && s.framework === CODEX_CLI_FRAMEWORK && aliases.has(s.subscriptionAccountId ?? '')).length;
    if (freshReset) {
      freshResets.push({ accountId: account.id, score: hoursLeft / (1 + running), running });
      continue;
    }
    const central = forecast.central;
    if (central === null || !Number.isFinite(central) || central < 0 || central >= 100) continue;
    const score = (100 - central) / hoursLeft / (1 + running);
    if (Number.isFinite(score) && score > 0) scored.push({ accountId: account.id, score, running });
  }
  const byScore = (a: BalancePick, b: BalancePick) => b.score - a.score || a.accountId.localeCompare(b.accountId);
  const bestForecast = scored.sort(byScore)[0];
  // Scores use different units, so compare concentration across the two groups.
  const bestFresh = freshResets.filter(pick => !bestForecast || pick.running <= bestForecast.running).sort(byScore)[0];
  const selected = bestFresh ?? bestForecast;
  return selected ? { accountId: selected.accountId, score: selected.score } : null;
}

interface PendingBalance { sessionName: string; sessionId: string; sourceId: string; targetId: string; sourceIdentity: string; targetIdentity: string; targetHome: string }
export interface ManualQuotaBalanceDeps {
  stateDir: string;
  accounts: () => SubscriptionAccount[];
  sessions: () => BalanceSession[];
  forecasts: () => Promise<LoginSummary[] | null>;
  execute: (intent: { sessionName: string; sourceId: string; targetId: string; sourceCurrent: () => boolean }) => Promise<SwapResult>;
  now?: () => number;
  softThreshold?: () => number;
}

/** Serializes this explicit mode through settlement; a durable unknown blocks later requests. */
export class ManualQuotaBalance {
  private chain: Promise<unknown> = Promise.resolve();
  private readonly file: string;
  private pending: PendingBalance | null = null;
  private unreadable = false;
  constructor(private readonly deps: ManualQuotaBalanceDeps) {
    this.file = path.join(deps.stateDir, 'state', 'manual-quota-balance.json');
    try {
      const state = JSON.parse(fs.readFileSync(this.file, 'utf8')) as { version?: number; pending?: PendingBalance | null };
      if (state.version !== 1 || !('pending' in state)) throw new Error('invalid balance state');
      this.pending = state.pending ?? null;
      if (this.pending && ['sessionName', 'sessionId', 'sourceId', 'targetId', 'sourceIdentity', 'targetIdentity', 'targetHome'].some(k => typeof (this.pending as unknown as Record<string, unknown>)[k] !== 'string')) throw new Error('invalid balance intent');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.unreadable = true;
    }
  }
  balance(sessionName: string, sourceId: string): Promise<SwapResult> {
    const task = this.chain.then(() => this.run(sessionName, sourceId));
    this.chain = task.then(() => undefined, () => undefined);
    return task;
  }
  private save(pending: PendingBalance | null): boolean {
    try {
      SafeFsExecutor.atomicWriteFileSync(this.file, JSON.stringify({ version: 1, pending }), { operation: 'manual quota balance intent' });
      this.pending = pending; return true;
    } catch { return false; } // @silent-fallback-ok: failed custody write refuses further manual balance execution
  }
  private findSession(name: string): BalanceSession | undefined {
    const matching = this.deps.sessions().filter(s => s.tmuxSession === name && s.status === 'running');
    return matching.length === 1 ? matching[0] : undefined;
  }
  private settled(intent: PendingBalance): boolean {
    const session = this.findSession(intent.sessionName);
    const account = this.deps.accounts().find(a => a.id === intent.targetId);
    return !!session && session.id !== intent.sessionId && session.framework === CODEX_CLI_FRAMEWORK && session.subscriptionAccountId === intent.targetId
      && !!account && !account.identityDrifted && account.configHome === intent.targetHome && identityKey(account.provider, account.email) === intent.targetIdentity;
  }
  private async run(sessionName: string, sourceId: string): Promise<SwapResult> {
    const refused = (reason: string, target: string | null = null): SwapResult => ({ swapped: false, toAccountId: target, reason });
    if (this.unreadable) return refused('manual-balance-custody-unavailable');
    if (this.pending && (!this.settled(this.pending) || !this.save(null))) return refused('manual-balance-settlement-pending', this.pending.targetId);
    const before = this.findSession(sessionName);
    const source = this.deps.accounts().find(a => a.id === sourceId);
    const sourceIdentity = source ? identityKey(source.provider, source.email) : null;
    if (!before || before.framework !== CODEX_CLI_FRAMEWORK || before.subscriptionAccountId !== sourceId || !sourceIdentity || source?.identityDrifted) return refused('manual-balance-source-changed');
    const summaries = await this.deps.forecasts();
    if (!summaries) return refused('manual-balance-forecast-unavailable');
    const sourceCurrent = (): boolean => {
      const live = this.findSession(sessionName); const account = this.deps.accounts().find(a => a.id === sourceId);
      return !!live && live.id === before.id && live.framework === CODEX_CLI_FRAMEWORK && live.subscriptionAccountId === sourceId
        && !!account && account.framework === CODEX_CLI_FRAMEWORK && !account.identityDrifted && identityKey(account.provider, account.email) === sourceIdentity;
    };
    if (!sourceCurrent()) return refused('manual-balance-source-changed');
    const pick = selectManualBalanceTarget(this.deps.accounts(), summaries, this.deps.sessions(), sourceId,
      this.deps.now?.() ?? Date.now(), this.deps.softThreshold?.() ?? 90);
    if (!pick) return refused('manual-balance-no-measured-target');
    const selected = this.deps.accounts().find(a => a.id === pick.accountId)!;
    const targetHome = selected.configHome; const targetIdentity = identityKey(selected.provider, selected.email)!;
    const stillCurrent = (): boolean => sourceCurrent()
      && this.deps.accounts().find(a => a.id === pick.accountId)?.configHome === targetHome
      && selectManualBalanceTarget(this.deps.accounts().filter(a => a.id === sourceId || a.id === pick.accountId),
        summaries, this.deps.sessions(), sourceId, this.deps.now?.() ?? Date.now(), this.deps.softThreshold?.() ?? 90)?.accountId === pick.accountId;
    const pending = { sessionName, sessionId: before.id, sourceId, targetId: pick.accountId, sourceIdentity, targetIdentity, targetHome };
    if (!this.save(pending)) return refused('manual-balance-custody-unavailable');
    let result: SwapResult;
    try { result = await this.deps.execute({ sessionName, sourceId, targetId: pick.accountId, sourceCurrent: stillCurrent }); }
    catch { return refused('manual-balance-settlement-pending', pick.accountId); } // @silent-fallback-ok: a thrown refresh may have moved the session; retain durable intent
    if (result.swapped) {
      if (result.toAccountId !== pick.accountId) return refused('manual-balance-settlement-pending', pick.accountId);
      if (!this.settled(pending) || !this.save(null)) return refused('manual-balance-settlement-pending', pick.accountId);
      return result;
    }
    // Structured refusals precede the kill. Unclassified failures are not proof of no effect.
    const definite = ['session-busy', 'session_busy', 'rate_limited', 'refresh_in_progress', 'session-not-found', 'session_not_found',
      'manual-target-ineligible', 'refresh_intent_changed', 'manual-balance-source-changed', 'source-framework-unknown', 'conflicting-swap-intent', 'intent-stale', 'not-topic-bound', 'not_topic_bound',
      'not_telegram_bound', 'no_telegram_adapter', 'slack_respawner_unwired'];
    if (!definite.includes(result.reason) || !this.save(null)) return refused('manual-balance-settlement-pending', pick.accountId);
    return result;
  }
}
