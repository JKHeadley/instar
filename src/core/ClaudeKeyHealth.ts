/**
 * ClaudeKeyHealth — notices when the agent's configured Claude sign-in key stops working, tells the
 * operator plainly, and recovers stuck conversations once a working key is proven
 * (spec cloud-key-internal-calls, fb-1dc4a0ca-260).
 *
 * Active only on an agent with an oauth-token configured. Elsewhere every method is a no-op.
 *
 * Signals (a failed internal call, a session at the login screen) only ask for a probe. The probe is
 * the authority: a real authenticated call where only Anthropic's own 401, seen twice, makes a key
 * dead. A changed key proves nothing until a probe of it succeeds.
 *
 * Never holds the key in persisted state or logs: only a short fingerprint.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type ClaudeKeyStatus = 'ok' | 'suspect' | 'dead';
export type ClaudeKeyProbeResult = 'ok' | 'rejected' | 'no-auth' | 'inconclusive';

export const CONFIRM_DELAY_MS = 30_000;
export const TICK_MS = 60_000;
export const OK_MIN_PROBE_INTERVAL_MS = 5 * 60_000;
export const DEAD_PROBE_START_MS = 10 * 60_000;
export const NEW_KEY_RETRY_START_MS = 60_000;
export const PROBE_CEILING_MS = 60 * 60_000;
export const PROBE_BREAKER_MS = 24 * 60 * 60_000;
export const NOTICE_MAX_ATTEMPTS = 5;
export const REFRESH_MAX_ATTEMPTS = 3;
export const REFRESH_BATCH = 10;

export const OPERATOR_DEAD_TEXT =
  "Your agent can't reach Claude because its sign-in key was rejected. It can't reply to anyone until this is fixed. " +
  'Create a new key with `claude setup-token` on any computer, then run `instar set-claude-key` on the server and paste it. ' +
  'Open conversations will pick up by themselves once the key works.';
export const OPERATOR_OK_TEXT = "Your agent's Claude sign-in key is working again. Open conversations are picking up.";
export const PERSON_TEXT = "I can't reply right now because my sign-in key stopped working. I'll pick this conversation up once it's fixed.";
export const PERSON_TOLD_SUFFIX = ' My operator has been told.';
export const RECOVERY_PROMPT =
  'Your sign-in key stopped working for a while and has now been fixed. Messages sent during that time were not answered. ' +
  'Read the conversation and answer anything still unanswered.';

export function claudeKeyFingerprint(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
}

/** The refresh brake, pure (shared with the self-action convergence ratchet). */
export function decideKeyRefresh(input: { attempts: number; maxAttempts: number }): 'attempt' | 'gave-up' {
  return input.attempts >= input.maxAttempts ? 'gave-up' : 'attempt';
}

/** Next probe delay: doubles to the ceiling. */
export function nextProbeDelay(currentMs: number): number {
  return Math.min(currentMs * 2, PROBE_CEILING_MS);
}

interface PendingRefresh { session: string; attempts: number }

interface PersistedState {
  status: ClaudeKeyStatus;
  fingerprint: string | null; // of the suspect or dead key
  since: number | null;
  probeDelayMs: number;
  nextProbeAt: number;
  keySeenAt: number | null; // when the key under test was first seen: the breaker's clock
  operatorTold: boolean;
  noticeAttempts: number;
  peopleTold: string[];
  sweepPending: boolean;
  pending: PendingRefresh[];
  refreshed: Record<string, string>; // session → fingerprint of the key it was refreshed onto
}

const initialState = (): PersistedState => ({
  status: 'ok', fingerprint: null, since: null, probeDelayMs: DEAD_PROBE_START_MS, nextProbeAt: 0, keySeenAt: null,
  operatorTold: false, noticeAttempts: 0, peopleTold: [], sweepPending: false, pending: [], refreshed: {},
});

export interface ClaudeKeyHealthDeps {
  stateFile: string;
  /** The key in memory now (oauth-token only), or undefined when there is none or the feature is off. */
  currentKey: () => string | undefined;
  /** The key in memory now, of any kind. Compared with disk so an API key isn't seen as "changed". */
  currentRawKey: () => string | undefined;
  /** The key on disk: string, null for none, undefined when unreadable (keep the last key). */
  readKeyFromDisk: () => string | null | undefined;
  /** Put what disk says into every live config copy. Null removes the key. */
  applyKey: (key: string | null) => void;
  /** A real authenticated call with exactly this key. Must not raise signals of its own. */
  probe: (key: string) => Promise<ClaudeKeyProbeResult>;
  /** True only on confirmed delivery to at least one channel. */
  notifyOperator: (text: string) => Promise<boolean>;
  /** True only on confirmed delivery. A session with no channel returns false. */
  notifyPerson: (sessionName: string, text: string) => Promise<boolean>;
  /** Live, channel-bound, unprotected claude-code sessions showing the login screen now. */
  listStuckSessions: () => Promise<string[]>;
  /** Fingerprint of the key the session was launched with, or null when it has none. */
  sessionLaunchFingerprint: (tmuxSession: string) => string | null;
  /** Through SessionRefresh, ordinary work gate. */
  refresh: (sessionName: string, prompt: string) => Promise<{ ok: boolean; reason?: string; newSessionName?: string }>;
  /** Forget the monitor's report marks so a stuck session is offered again promptly. */
  clearLoginReports: () => void;
  report: (input: { reason: string; impact: string }) => void;
  now?: () => number;
  logger?: { log: (m: string) => void; warn: (m: string) => void };
  /** Tests drive ticks by hand. */
  manualTimers?: boolean;
}

let active: ClaudeKeyHealth | null = null;
/** The running instance, for /health. */
export function activeClaudeKeyHealth(): ClaudeKeyHealth | null { return active; }
export function setActiveClaudeKeyHealth(instance: ClaudeKeyHealth | null): void { active = instance; }

/* @self-action-controller: claude-key-session-refresh */
export class ClaudeKeyHealth {
  private state: PersistedState = initialState();
  private probing: Promise<void> | null = null;
  private working = false;
  private timer: NodeJS.Timeout | null = null;
  private confirmTimer: NodeJS.Timeout | null = null;
  private lastProbeAt = 0;
  private lastOkFingerprint: string | null = null;
  private noAuthReported: string | null = null;
  private readonly now: () => number;
  private readonly logger: { log: (m: string) => void; warn: (m: string) => void };

  constructor(private readonly deps: ClaudeKeyHealthDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.logger = deps.logger ?? { log: () => {}, warn: () => {} };
  }

  /** What /health shows. */
  status(): { status: ClaudeKeyStatus; since: string | null } | null {
    if (!this.deps.currentKey()) return null;
    return { status: this.state.status, since: this.state.since ? new Date(this.state.since).toISOString() : null };
  }

  /** Load persisted state and pick up anything a restart interrupted. */
  async boot(): Promise<void> {
    this.load();
    this.syncKeyFromDisk();
    if (this.state.status === 'suspect') this.reset(); // its confirming timer did not survive
    if (this.state.sweepPending) await this.collectStuck();
    this.dropStateWithoutKey();
    if (this.state.status === 'dead') {
      const key = this.deps.currentKey();
      if (key && claudeKeyFingerprint(key) !== this.state.fingerprint) this.startTestingNewKey();
    }
    this.save();
    this.ensureTimer();
    if (this.state.status === 'dead') await this.tick();
  }

  /** A signal from an internal call. Asks for a probe, decides nothing. */
  noteCallOutcome(outcome: 'ok' | 'rejected' | 'no-auth'): void {
    if (!this.deps.currentKey()) return;
    if (outcome === 'ok') {
      // Only worth a probe while dead: this is the fast way back from a false alarm.
      if (this.state.status === 'dead') this.background(this.runProbe({ force: true }));
      return;
    }
    this.background(this.runProbe({ force: false }));
  }

  /**
   * A session has sat at the login screen past the dwell. Returns true on a key agent, where the
   * pool swap cannot help because the env key overrides any pool account.
   */
  async handle(signal: { session: string; protected: boolean }): Promise<boolean> {
    this.syncKeyFromDisk();
    const key = this.deps.currentKey();
    if (!key) return false;
    const fp = claudeKeyFingerprint(key);

    if (this.state.status === 'dead') {
      await this.tellPerson(signal.session);
      return true;
    }
    await this.runProbe({ force: false });
    if ((this.state.status as ClaudeKeyStatus) === 'dead') {
      await this.tellPerson(signal.session);
      return true;
    }
    // The key is good. A session launched on a different key is stuck on the old one. A matching
    // key never refreshes, so login text printed in a working session cannot cause a kill.
    if (signal.protected || this.lastOkFingerprint !== fp) return true;
    const launched = this.deps.sessionLaunchFingerprint(signal.session);
    if (launched && launched !== fp && this.state.refreshed[signal.session] !== fp) {
      this.enqueue(signal.session);
      this.save();
      this.ensureTimer();
      await this.workPending();
    }
    return true;
  }

  /** One timer pass. Runs only while dead or while recovery work is pending. */
  async tick(): Promise<void> {
    this.syncKeyFromDisk();
    this.dropStateWithoutKey();
    if (this.state.status === 'dead') {
      await this.sendOperatorNotice();
      const brokenOut = this.state.keySeenAt !== null && this.now() - this.state.keySeenAt >= PROBE_BREAKER_MS;
      if (!brokenOut && this.now() >= this.state.nextProbeAt) await this.runProbe({ force: true });
    }
    await this.workPending();
    this.ensureTimer();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.confirmTimer) clearTimeout(this.confirmTimer);
    this.timer = null;
    this.confirmTimer = null;
  }

  private syncKeyFromDisk(): void {
    const onDisk = this.deps.readKeyFromDisk();
    if (onDisk === undefined || (onDisk ?? undefined) === this.deps.currentRawKey()) return;
    this.deps.applyKey(onDisk);
    this.logger.log('[ClaudeKeyHealth] the configured key changed');
    if (this.state.status === 'dead') {
      this.startTestingNewKey();
      this.save();
    } else if (this.state.status === 'suspect') {
      this.reset();
    }
  }

  private startTestingNewKey(): void {
    this.state.nextProbeAt = 0;
    this.state.probeDelayMs = NEW_KEY_RETRY_START_MS;
    this.state.keySeenAt = this.now();
  }

  /** The key was removed or the feature switched off: there is nothing left to be dead. */
  private dropStateWithoutKey(): void {
    if (this.deps.currentKey() || (this.state.status === 'ok' && this.state.pending.length === 0)) return;
    this.reset();
    this.state.pending = [];
    this.save();
  }

  private background(work: Promise<unknown>): void {
    work.catch((err) => this.logger.warn(`[ClaudeKeyHealth] ${err instanceof Error ? err.message : String(err)}`));
  }

  private runProbe(opts: { force: boolean }): Promise<void> {
    if (this.probing) return this.probing;
    // First, so a key already put on disk is what gets tested: never page about a replaced key.
    this.syncKeyFromDisk();
    const key = this.deps.currentKey();
    if (!key) return Promise.resolve();
    // Signals only start a probe from `ok`. `suspect` waits for its confirming delay, and `dead` for
    // its backoff, however many calls fail meanwhile.
    if (!opts.force && (this.state.status !== 'ok' || this.now() - this.lastProbeAt < OK_MIN_PROBE_INTERVAL_MS)) {
      return Promise.resolve();
    }
    this.lastProbeAt = this.now();
    this.probing = (async () => {
      let result: ClaudeKeyProbeResult;
      try { result = await this.deps.probe(key); }
      catch { result = 'inconclusive'; } // @silent-fallback-ok: a probe that could not run concludes nothing, by design
      // The key changed while this ran: the answer is about a key no longer in use.
      if (this.deps.currentKey() !== key) return;
      await this.applyResult(claudeKeyFingerprint(key), result);
    })().finally(() => { this.probing = null; });
    return this.probing;
  }

  private async applyResult(fp: string, result: ClaudeKeyProbeResult): Promise<void> {
    if (result === 'ok') {
      this.lastOkFingerprint = fp;
      if (this.state.status === 'dead') await this.recovered();
      else if (this.state.status === 'suspect') this.reset();
      return;
    }
    if (result === 'rejected') {
      if (this.state.status === 'dead' && this.state.fingerprint === fp) { this.backOff(); return; }
      if (this.state.status === 'suspect' && this.state.fingerprint === fp) { await this.declareDead(fp); return; }
      if (this.state.status === 'dead') { await this.declareDead(fp); return; } // a new key, also refused
      this.suspect(fp);
      return;
    }
    if (result === 'no-auth' && this.noAuthReported !== fp) {
      // The CLI had nothing to send, so the key never reached it. Telling the operator to replace
      // a key that may be fine would be the wrong instruction.
      this.noAuthReported = fp;
      this.deps.report({
        reason: 'A configured Claude sign-in key did not reach the claude process.',
        impact: 'Internal model calls may be failing. This is an Instar fault, not a bad key.',
      });
    }
    if (this.state.status === 'suspect') this.reset();
    else if (this.state.status === 'dead') this.backOff();
  }

  private suspect(fp: string): void {
    this.state.status = 'suspect';
    this.state.fingerprint = fp;
    this.save();
    if (this.deps.manualTimers) return;
    this.confirmTimer = setTimeout(() => this.background(this.confirm()), CONFIRM_DELAY_MS);
    this.confirmTimer.unref?.();
  }

  /** The confirming probe, exempt from the interval limit. Public for tests. */
  async confirm(): Promise<void> {
    if (this.state.status === 'suspect') await this.runProbe({ force: true });
  }

  private async declareDead(fp: string): Promise<void> {
    const sameEpisode = this.state.status === 'dead';
    this.state = {
      ...this.state, status: 'dead', fingerprint: fp, since: sameEpisode ? this.state.since : this.now(),
      probeDelayMs: DEAD_PROBE_START_MS, nextProbeAt: this.now() + DEAD_PROBE_START_MS, keySeenAt: this.now(),
      operatorTold: false, noticeAttempts: 0, peopleTold: [],
    };
    this.save();
    this.logger.warn('[ClaudeKeyHealth] Anthropic rejected the configured sign-in key');
    this.deps.report({
      reason: 'Anthropic rejected the configured Claude sign-in key.',
      impact: 'The agent cannot reply or run internal model calls until a working key is set.',
    });
    await this.sendOperatorNotice();
    for (const session of await this.safeListStuck()) await this.tellPerson(session);
    this.ensureTimer();
  }

  private backOff(): void {
    this.state.nextProbeAt = this.now() + this.state.probeDelayMs;
    this.state.probeDelayMs = nextProbeDelay(this.state.probeDelayMs);
    this.save();
  }

  private async recovered(): Promise<void> {
    // Written first: a crash before the sweep finishes resumes it at boot.
    this.state = { ...initialState(), sweepPending: true, pending: this.state.pending, refreshed: this.state.refreshed };
    this.save();
    this.logger.log('[ClaudeKeyHealth] the sign-in key works again');
    this.deps.clearLoginReports();
    await this.collectStuck();
    this.save();
    try { await this.deps.notifyOperator(OPERATOR_OK_TEXT); }
    catch (err) { this.logger.warn(`[ClaudeKeyHealth] all-clear send failed: ${err instanceof Error ? err.message : String(err)}`); }
    this.ensureTimer(); // the next tick works the list, one batch at a time
  }

  private async collectStuck(): Promise<void> {
    const key = this.deps.currentKey();
    if (key) {
      const fp = claudeKeyFingerprint(key);
      // Once per session per key: a session already moved onto this key holds a good key now.
      for (const session of await this.safeListStuck()) {
        if (this.state.refreshed[session] !== fp) this.enqueue(session);
      }
    }
    this.state.sweepPending = false;
  }

  private async safeListStuck(): Promise<string[]> {
    try { return await this.deps.listStuckSessions(); }
    catch (err) {
      this.logger.warn(`[ClaudeKeyHealth] could not list stuck sessions: ${err instanceof Error ? err.message : String(err)}`);
      // @silent-fallback-ok: reported just below, so a skipped sweep is never silent
      this.deps.report({
        reason: 'Could not list conversations stuck at the login screen.',
        impact: 'Those conversations recover on their next message instead of by themselves.',
      });
      return [];
    }
  }

  private enqueue(session: string): void {
    if (!this.state.pending.some((p) => p.session === session)) this.state.pending.push({ session, attempts: 0 });
  }

  private async workPending(): Promise<void> {
    if (this.working || this.state.status !== 'ok' || this.state.pending.length === 0 || !this.deps.currentKey()) return;
    this.working = true;
    try { await this.workBatch(); }
    finally { this.working = false; }
  }

  private async workBatch(): Promise<void> {
    const key = this.deps.currentKey();
    const fp = key ? claudeKeyFingerprint(key) : '';
    for (const item of this.state.pending.slice(0, REFRESH_BATCH)) {
      if (!this.state.pending.includes(item)) continue;
      if (decideKeyRefresh({ attempts: item.attempts, maxAttempts: REFRESH_MAX_ATTEMPTS }) === 'gave-up') {
        this.drop(item.session);
        this.deps.report({
          reason: `Session "${item.session}" could not be restarted after the sign-in key was fixed.`,
          impact: 'It will pick up on its next message.',
        });
        continue;
      }
      item.attempts += 1;
      let done = false;
      let newName: string | undefined;
      try {
        const result = await this.deps.refresh(item.session, RECOVERY_PROMPT);
        done = result.ok;
        newName = result.newSessionName;
      }
      catch (err) { this.logger.warn(`[ClaudeKeyHealth] refresh of "${item.session}" failed: ${err instanceof Error ? err.message : String(err)}`); }
      if (done) {
        this.drop(item.session);
        // A Slack respawn gets a new name, and that is the name the next sweep will see.
        this.state.refreshed[newName ?? item.session] = fp;
      }
    }
    this.save();
  }

  private drop(session: string): void {
    this.state.pending = this.state.pending.filter((p) => p.session !== session);
  }

  private async sendOperatorNotice(): Promise<void> {
    if (this.state.operatorTold || this.state.noticeAttempts >= NOTICE_MAX_ATTEMPTS) return;
    this.state.noticeAttempts += 1;
    let delivered = false;
    try { delivered = await this.deps.notifyOperator(OPERATOR_DEAD_TEXT); }
    catch (err) { this.logger.warn(`[ClaudeKeyHealth] operator notice failed: ${err instanceof Error ? err.message : String(err)}`); }
    this.state.operatorTold = delivered;
    if (!delivered && this.state.noticeAttempts >= NOTICE_MAX_ATTEMPTS) {
      this.deps.report({
        reason: 'The operator could not be told that the Claude sign-in key was rejected.',
        impact: 'The rejected key shows in /health only.',
      });
    }
    this.save();
  }

  private async tellPerson(sessionName: string): Promise<void> {
    if (this.state.peopleTold.includes(sessionName)) return;
    const text = this.state.operatorTold ? `${PERSON_TEXT}${PERSON_TOLD_SUFFIX}` : PERSON_TEXT;
    let delivered = false;
    try { delivered = await this.deps.notifyPerson(sessionName, text); }
    catch (err) { /* @silent-fallback-ok: undelivered stays untold, so the next report of this session tries again */ this.logger.warn(`[ClaudeKeyHealth] person notice failed: ${err instanceof Error ? err.message : String(err)}`); }
    if (delivered) {
      this.state.peopleTold.push(sessionName);
      this.save();
    }
  }

  private reset(): void {
    if (this.confirmTimer) clearTimeout(this.confirmTimer);
    this.confirmTimer = null;
    this.state = { ...initialState(), pending: this.state.pending, refreshed: this.state.refreshed };
    this.save();
  }

  private ensureTimer(): void {
    const needed = this.state.status === 'dead' || this.state.pending.length > 0;
    if (this.deps.manualTimers) return;
    if (needed && !this.timer) {
      this.timer = setInterval(() => this.background(this.tick()), TICK_MS);
      this.timer.unref?.();
    } else if (!needed && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private load(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.deps.stateFile, 'utf-8')) as Partial<PersistedState>;
      this.state = { ...initialState(), ...raw };
    } catch { this.state = initialState(); } // @silent-fallback-ok: no file or a bad one means nothing was in progress
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.deps.stateFile), { recursive: true });
      const tmp = `${this.deps.stateFile}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.deps.stateFile);
    } catch (err) {
      this.logger.warn(`[ClaudeKeyHealth] could not save state: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
