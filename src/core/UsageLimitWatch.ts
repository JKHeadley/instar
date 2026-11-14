/**
 * UsageLimitWatch — when the agent's Claude usage runs out and no other account can take over, the
 * operator is told, and waiting conversations pick up by themselves once it is back
 * (fb-cab84278-0b4, B2Lead condition 1).
 *
 * Before this the limit was invisible to everyone but the person who happened to be waiting: a limit
 * is not a 401, so the sign-in key monitor stayed "ok", and UsageWallRescue does nothing under 2
 * accounts. The notices promised that the conversation would carry on, and nothing made it.
 *
 * Signals (a session settled at the limit banner, an internal call refused for usage) only open a
 * check. The authority is the provider's own word: the serving session's latest transcript row, or
 * a real probe. A probe's clean answer, or a fresh reading of an account with room, ends the limit.
 *
 * The person in a conversation is told by the standby (PresenceProxy), which reads isLimited(), so
 * there is one voice. This class speaks to a person only when a session is gone or never answered.
 *
 * @self-action-controller: usage-limit-session-refresh
 */

import fs from 'node:fs';
import path from 'node:path';
import { isQuietReceipt, type QuietReceipt } from '../messaging/NotificationSelectivityGate.js';
import type { RecoveryChannel } from './claudeKeyRecovery.js';

export type UsageProbeResult = 'ok' | 'limited' | 'other';

export const TICK_MS = 60_000;
export const SIGNAL_MIN_PROBE_INTERVAL_MS = 5 * 60_000;
export const PROBE_START_MS = 10 * 60_000;
export const PROBE_CEILING_MS = 30 * 60_000;
export const NOTICE_MAX_ATTEMPTS = 5;
/** Restarts of one conversation in a day. A session that walls again right away stays put. */
export const REFRESH_MAX_PER_DAY = 3;
export const REFRESH_WINDOW_MS = 24 * 60 * 60_000;
export const REFRESH_BATCH = 10;
export const ANSWER_WAIT_MS = 15 * 60_000;
/** After usage reads back, a wall isn't a new episode for this long: an old banner can still be on a pane. */
export const REOPEN_COOLDOWN_MS = 60 * 60_000;
/** At most one operator notice in this long, however the limit comes and goes. */
export const OPERATOR_NOTICE_GAP_MS = 6 * 60 * 60_000;

export const OPERATOR_OK_TEXT = "Your agent's Claude usage is back. Conversations that were waiting are picking up.";
export const PERSON_RESEND_TEXT =
  "I'm back, but I couldn't pick up what you sent while I was out of Claude usage. Please send it again.";
export const PERSON_LIMITED_TEXT =
  "I've run out of Claude usage, so I can't answer right now. Your message is here, and I'll pick this conversation up when usage is back.";

export function operatorLimitText(input: { resets: string | null; keyAgent: boolean }): string {
  const when = input.resets ? ` It resets ${input.resets}.` : '';
  const act = input.keyAgent
    ? 'To get it answering sooner, create a key with `claude setup-token` on an account with room, then run `instar set-claude-key` on the server and paste it.'
    : 'To get it answering sooner, connect another account with room from the Accounts page.';
  return `Your agent has run out of Claude usage, so its conversations on Claude can't reply.${when} ${act} Waiting conversations pick up by themselves once usage is back.`;
}

/** The reset as the banner says it: "You've hit your weekly limit · resets Nov 8, 11am (UTC)". */
export function resetFromBanner(banner: string | null | undefined): string | null {
  const m = banner?.match(/\bresets?\s+([^·•∙\n]+?)\s*(?:[·•∙\n]|$)/i);
  return m ? m[1].trim() : null;
}

/** The refresh brake, pure (shared with the self-action convergence ratchet). */
export function decideLimitRefresh(input: { recentRefreshes: number }): 'attempt' | 'gave-up' {
  return input.recentRefreshes >= REFRESH_MAX_PER_DAY ? 'gave-up' : 'attempt';
}

export function nextProbeDelay(currentMs: number): number {
  return Math.min(currentMs * 2, PROBE_CEILING_MS);
}

interface WalledSession { channel: RecoveryChannel | null }
interface AwaitingAnswer { session: string; since: number }

interface PersistedState {
  limited: boolean;
  since: number | null;
  resets: string | null;
  probeDelayMs: number;
  nextProbeAt: number;
  operatorTold: boolean;
  operatorQuietId?: string;
  noticeAttempts: number;
  allClearPending: boolean;
  walled: Record<string, WalledSession>;
  awaiting: AwaitingAnswer[];
  refreshTimes: Record<string, number[]>;
  recoveredAt: number | null;
  operatorNoticeAt: number | null;
}

const initialState = (): PersistedState => ({
  limited: false, since: null, resets: null, probeDelayMs: PROBE_START_MS, nextProbeAt: 0, operatorTold: false,
  noticeAttempts: 0, allClearPending: false, walled: {}, awaiting: [], refreshTimes: {}, recoveredAt: null, operatorNoticeAt: null,
});

export interface UsageLimitWatchDeps {
  stateFile: string;
  /** Provider proof that this session's last turn was refused for usage. A signal alone never counts. */
  confirmSession: (sessionName: string) => boolean;
  /**
   * Some usable account is not known to be full, so saying conversations can't reply would be false (and
   * UsageWallRescue owns any session that hits a limit). False on an agent with under 2 accounts.
   */
  anotherAccountHasRoom: () => boolean;
  /** A fresh reading shows an account with room, so the limit is over without a probe. */
  accountKnownToHaveRoom: () => boolean;
  /** The session's pane shows the limit and its transcript still proves it, right now. */
  stillWalled: (sessionName: string) => boolean;
  /** The limit banner on the session's pane, for the reset time. */
  bannerFor: (sessionName: string) => string | null;
  /** Where the session's conversation is, or null when it serves no conversation. */
  channelFor: (sessionName: string) => RecoveryChannel | null;
  /** A real call on the login in use. */
  probe: () => Promise<UsageProbeResult>;
  /**
   * Put a key the operator saved on disk into use before it is read. Without it a key put in during the
   * limit is never probed, and the probe keeps testing the old walled key (2026-11-07 live proof).
   */
  syncKey?: () => void;
  /** Changes when the operator puts in a different key: worth a probe straight away. */
  keyFingerprint: () => string | null;
  isKeyAgent: () => boolean;
  /** Live sessions now showing the limit. */
  listWalledSessions: () => Promise<string[]>;
  isSessionRunning: (sessionName: string) => boolean;
  /** Held messages and the prompt. Null when it can't be read. */
  recoveryPrompt: (sessionName: string) => Promise<{ prompt: string; held: number } | null>;
  /** Refused when the session is busy (ok false): it stays listed and is tried again. */
  refresh: (sessionName: string, prompt: string) => Promise<{ ok: boolean; newSessionName?: string }>;
  answeredSince: (sessionName: string, sinceMs: number) => Promise<boolean | null>;
  notifyOperator: (text: string) => Promise<boolean | QuietReceipt>;
  notifySession: (sessionName: string, text: string) => Promise<boolean>;
  notifyChannel: (channel: RecoveryChannel, text: string) => Promise<boolean>;
  report: (input: { reason: string; impact: string }) => void;
  now?: () => number;
  logger?: { log: (m: string) => void; warn: (m: string) => void };
  manualTimers?: boolean;
}

let active: UsageLimitWatch | null = null;
/** The running instance, for /health and the standby. */
export function activeUsageLimitWatch(): UsageLimitWatch | null { return active; }
export function setActiveUsageLimitWatch(instance: UsageLimitWatch | null): void { active = instance; }

export class UsageLimitWatch {
  private state: PersistedState = initialState();
  private timer: NodeJS.Timeout | null = null;
  private probing: Promise<void> | null = null;
  private working = false;
  private started = false;
  private lastSignalProbeAt = 0;
  private lastFingerprint: string | null = null;
  private readonly now: () => number;
  private readonly logger: { log: (m: string) => void; warn: (m: string) => void };

  constructor(private readonly deps: UsageLimitWatchDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.logger = deps.logger ?? { log: () => {}, warn: () => {} };
  }

  boot(): void {
    try {
      this.state = { ...initialState(), ...(JSON.parse(fs.readFileSync(this.deps.stateFile, 'utf-8')) as Partial<PersistedState>) };
    } catch { this.state = initialState(); } // @silent-fallback-ok: no file or a bad one means nothing was in progress
    this.lastFingerprint = this.deps.keyFingerprint();
  }

  /** The server is fully up, so whether another account has room can be read. */
  start(): void {
    this.started = true;
    this.ensureTimer();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Is the agent out of usage, as far as anything has proven? */
  isLimited(): boolean { return this.state.limited; }

  /** What /health shows. Null when usage is not known to be out. */
  status(): { status: 'limited'; since: string | null; resets: string | null } | null {
    if (!this.state.limited) return null;
    return { status: 'limited', since: this.state.since ? new Date(this.state.since).toISOString() : null, resets: this.state.resets };
  }

  /** The line the standby says while limited, so nobody hears "actively working". Null when not. */
  personNotice(): string | null { return this.state.limited ? PERSON_LIMITED_TEXT : null; }

  /** A session settled at the limit banner. Asks; the transcript decides. Never throws. */
  async noteWall(sessionName: string): Promise<void> {
    try {
      if (!this.started || this.inCooldown()) return; // a wall re-signals every few minutes
      if (this.deps.anotherAccountHasRoom()) return;
      if (!this.deps.confirmSession(sessionName)) return;
      this.state.walled[sessionName] = { channel: this.deps.channelFor(sessionName) };
      await this.open(resetFromBanner(this.deps.bannerFor(sessionName)));
    } catch (err) { this.logger.warn(`[UsageLimitWatch] ${err instanceof Error ? err.message : String(err)}`); }
  }

  /** An internal call was refused for usage. Asks for a probe; decides nothing. */
  noteCallLimited(): void {
    if (!this.started || this.state.limited || this.inCooldown() || this.now() - this.lastSignalProbeAt < SIGNAL_MIN_PROBE_INTERVAL_MS) return;
    if (this.deps.anotherAccountHasRoom()) return;
    this.lastSignalProbeAt = this.now();
    void this.runProbe().catch((err) => {
      // @silent-fallback-ok: a failed probe concludes nothing, and the next signal asks again
      this.logger.warn(`[UsageLimitWatch] ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  private inCooldown(): boolean {
    return this.state.recoveredAt !== null && this.now() - this.state.recoveredAt < REOPEN_COOLDOWN_MS;
  }

  private async open(resets: string | null): Promise<void> {
    if (!this.state.limited) {
      this.state.limited = true;
      this.lastFingerprint = this.deps.keyFingerprint();
      this.state.since = this.now();
      this.state.resets = resets;
      this.state.probeDelayMs = PROBE_START_MS;
      this.state.nextProbeAt = this.now() + PROBE_START_MS;
      this.state.operatorTold = false;
      this.state.operatorQuietId = undefined;
      this.state.noticeAttempts = 0;
      this.state.allClearPending = false;
      this.logger.warn('[UsageLimitWatch] Claude usage has run out');
      this.deps.report({ reason: 'The agent has run out of Claude usage.', impact: 'It cannot reply or run model work until usage is back or capacity is added.' });
    } else if (resets && !this.state.resets) {
      this.state.resets = resets;
    }
    this.save();
    await this.sendOperatorNotice();
    this.ensureTimer();
  }

  private runProbe(): Promise<void> {
    if (this.probing) return this.probing;
    this.probing = (async () => {
      let result: UsageProbeResult = 'other';
      try { result = await this.deps.probe(); }
      catch { /* @silent-fallback-ok: a probe that could not run concludes nothing, by design */ }
      // One line per probe, so a limit that never ends can be read from the log (it could not on 2026-11-07).
      this.logger.log(`[UsageLimitWatch] usage probe: ${result}${this.state.limited ? ' (limited)' : ''}`);
      if (result === 'limited') { await this.open(null); this.backOffIfProbeWasDue(); return; }
      if (result === 'ok') { if (this.state.limited) await this.recovered(); return; }
      if (this.state.limited) this.backOffIfProbeWasDue();
    })().finally(() => { this.probing = null; });
    return this.probing;
  }

  private backOffIfProbeWasDue(): void {
    if (this.now() < this.state.nextProbeAt) return;
    this.state.nextProbeAt = this.now() + this.state.probeDelayMs;
    this.state.probeDelayMs = nextProbeDelay(this.state.probeDelayMs);
    this.save();
  }

  /** One timer pass. Runs only while limited or while recovery is being watched. */
  async tick(): Promise<void> {
    if (!this.started) return;
    if (this.state.limited) {
      await this.sendOperatorNotice();
      try { this.deps.syncKey?.(); }
      catch (err) { /* @silent-fallback-ok: logged; the fingerprint below is still read */ this.logger.warn(`[UsageLimitWatch] key sync failed: ${err instanceof Error ? err.message : String(err)}`); }
      const fp = this.deps.keyFingerprint();
      if (fp !== this.lastFingerprint) { this.lastFingerprint = fp; this.state.nextProbeAt = 0; }
      if (this.deps.accountKnownToHaveRoom()) await this.recovered(); // an account came back or was added
      else if (this.now() >= this.state.nextProbeAt) await this.runProbe();
    }
    await this.checkAnswers();
    if (!this.state.limited && Object.keys(this.state.walled).length > 0) await this.workRecovery();
    if (this.state.allClearPending) await this.sendAllClear();
    this.prune();
    this.ensureTimer();
  }

  private async recovered(): Promise<void> {
    this.state.limited = false;
    this.state.since = null;
    this.state.resets = null;
    this.state.allClearPending = true;
    this.state.recoveredAt = this.now();
    // Written first: a crash before the sweep finishes resumes it from `walled`.
    this.save();
    this.logger.log('[UsageLimitWatch] Claude usage is back');
    try {
      for (const name of await this.deps.listWalledSessions()) {
        this.state.walled[name] ??= { channel: this.deps.channelFor(name) };
      }
    } catch (err) {
      /* @silent-fallback-ok: reported just below, so a skipped sweep is never silent */
      this.logger.warn(`[UsageLimitWatch] could not list sessions: ${err instanceof Error ? err.message : String(err)}`);
      this.deps.report({ reason: 'Could not list conversations waiting on usage.', impact: 'Conversations not already known pick up on their next message.' });
    }
    this.save();
    await this.workRecovery();
    await this.sendAllClear();
    this.ensureTimer();
  }

  private async sendAllClear(): Promise<void> {
    if (!this.state.operatorTold && !this.state.operatorQuietId) { this.state.allClearPending = false; this.save(); return; } // never told, nothing to clear
    try {
      const sent = await this.deps.notifyOperator(OPERATOR_OK_TEXT);
      if (sent) { this.state.allClearPending = false; this.state.operatorTold = false; this.state.operatorQuietId = undefined; this.save(); }
    } catch (err) { this.logger.warn(`[UsageLimitWatch] all-clear failed: ${err instanceof Error ? err.message : String(err)}`); }
  }

  private async workRecovery(): Promise<void> {
    if (this.working || this.state.limited) return;
    this.working = true;
    try {
      for (const [name, entry] of Object.entries(this.state.walled).slice(0, REFRESH_BATCH)) {
        if (this.state.limited) break;
        if (await this.recoverOne(name, entry) === 'done') delete this.state.walled[name];
        this.save();
      }
    } finally { this.working = false; }
  }

  private async recoverOne(name: string, entry: WalledSession): Promise<'done' | 'try-again'> {
    if (!this.deps.isSessionRunning(name)) {
      // The session ended during the limit. Nobody can read what it held from here, so ask.
      if (entry.channel) {
        let told = false;
        try { told = await this.deps.notifyChannel(entry.channel, PERSON_RESEND_TEXT); }
        catch (err) { /* @silent-fallback-ok: reported just below */ this.logger.warn(`[UsageLimitWatch] resend request failed: ${err instanceof Error ? err.message : String(err)}`); }
        if (!told) this.deps.report({ reason: `A conversation that ended during the usage limit could not be told to resend (${name}).`, impact: 'The person may still be waiting.' });
      }
      return 'done';
    }
    // It moved on by itself (Claude Code can continue at the reset): a restart would kill its work.
    if (!this.deps.stillWalled(name)) return 'done';
    let built: { prompt: string; held: number } | null = null;
    try { built = await this.deps.recoveryPrompt(name); }
    catch (err) { /* @silent-fallback-ok: reported just below */ this.logger.warn(`[UsageLimitWatch] prompt for ${name}: ${err instanceof Error ? err.message : String(err)}`); }
    if (!built) {
      this.deps.report({ reason: `Could not read what "${name}" had waiting when usage came back.`, impact: 'It picks up on its next message.' });
      return 'done';
    }
    if (built.held === 0) return 'done'; // at its prompt with nothing waiting: the next message works as it is
    const times = (this.state.refreshTimes[name] ?? []).filter((t) => this.now() - t < REFRESH_WINDOW_MS);
    if (decideLimitRefresh({ recentRefreshes: times.length }) === 'gave-up') {
      const told = await this.askToResend(name);
      this.deps.report({
        reason: `"${name}" was tried ${times.length} times in a day after the usage limit and did not pick up.`,
        impact: told ? 'It was left as it is, and the person was asked to send again.' : 'It was left as it is, and the person may still be waiting.',
      });
      return 'done';
    }
    this.state.refreshTimes[name] = [...times, this.now()];
    const startedAt = this.now();
    let result: { ok: boolean; newSessionName?: string } = { ok: false };
    try { result = await this.deps.refresh(name, built.prompt); }
    catch (err) { this.logger.warn(`[UsageLimitWatch] refresh of ${name} failed: ${err instanceof Error ? err.message : String(err)}`); }
    if (!result.ok) return 'try-again'; // the cap above ends this
    this.state.awaiting.push({ session: result.newSessionName ?? name, since: startedAt });
    return 'done';
  }

  private async askToResend(name: string): Promise<boolean> {
    try { return (await this.deps.notifySession(name, PERSON_RESEND_TEXT)) === true; }
    catch (err) { /* @silent-fallback-ok: the caller's report states whether anyone was told */ this.logger.warn(`[UsageLimitWatch] resend request for ${name} failed: ${err instanceof Error ? err.message : String(err)}`); return false; }
  }

  private async checkAnswers(): Promise<void> {
    if (this.state.limited || this.state.awaiting.length === 0) return;
    const still: AwaitingAnswer[] = [];
    for (const item of this.state.awaiting) {
      let answered: boolean | null = null;
      try { answered = await this.deps.answeredSince(item.session, item.since); }
      catch (err) { this.logger.warn(`[UsageLimitWatch] answer check failed: ${err instanceof Error ? err.message : String(err)}`); }
      if (answered === true) continue;
      if (this.now() - item.since < ANSWER_WAIT_MS) { still.push(item); continue; }
      const told = await this.askToResend(item.session);
      this.deps.report({
        reason: `"${item.session}" restarted when usage came back but no answer was seen in ${ANSWER_WAIT_MS / 60_000} minutes.`,
        impact: told ? 'The person was asked to send their message again.' : 'The person may still be waiting.',
      });
    }
    if (still.length !== this.state.awaiting.length) { this.state.awaiting = still; this.save(); }
  }

  private async sendOperatorNotice(): Promise<void> {
    if (this.state.operatorTold || this.state.operatorQuietId || this.state.noticeAttempts >= NOTICE_MAX_ATTEMPTS) return;
    if (this.state.operatorNoticeAt !== null && this.now() - this.state.operatorNoticeAt < OPERATOR_NOTICE_GAP_MS) return;
    this.state.noticeAttempts += 1;
    let delivered: boolean | QuietReceipt = false;
    try { delivered = await this.deps.notifyOperator(operatorLimitText({ resets: this.state.resets, keyAgent: this.deps.isKeyAgent() })); }
    catch (err) { /* @silent-fallback-ok: `delivered` stays false, which drives the retry and its capped report */ this.logger.warn(`[UsageLimitWatch] operator notice failed: ${err instanceof Error ? err.message : String(err)}`); }
    if (isQuietReceipt(delivered)) this.state.operatorQuietId = delivered.quietId;
    else this.state.operatorTold = delivered === true;
    if (this.state.operatorTold || this.state.operatorQuietId) this.state.operatorNoticeAt = this.now();
    if (!this.state.operatorTold && !this.state.operatorQuietId && this.state.noticeAttempts >= NOTICE_MAX_ATTEMPTS) {
      this.deps.report({ reason: 'The operator could not be told that Claude usage ran out.', impact: 'It shows in /health only.' });
    }
    this.save();
  }

  private prune(): void {
    let changed = false;
    for (const [k, times] of Object.entries(this.state.refreshTimes)) {
      if (!times.some((t) => this.now() - t < REFRESH_WINDOW_MS)) { delete this.state.refreshTimes[k]; changed = true; }
    }
    if (changed) this.save();
  }

  private ensureTimer(): void {
    if (this.deps.manualTimers || !this.started) return;
    const needed = this.state.limited || this.state.allClearPending || this.state.awaiting.length > 0 || Object.keys(this.state.walled).length > 0;
    if (needed && !this.timer) {
      this.timer = setInterval(() => {
        void this.tick().catch((err) => {
          // @silent-fallback-ok: the next tick retries; state stays on disk
          this.logger.warn(`[UsageLimitWatch] ${err instanceof Error ? err.message : String(err)}`);
        });
      }, TICK_MS);
      this.timer.unref?.();
    } else if (!needed && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.deps.stateFile), { recursive: true });
      const tmp = `${this.deps.stateFile}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.deps.stateFile);
    } catch (err) {
      this.logger.warn(`[UsageLimitWatch] could not save: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
