/* @self-action-controller: context-budget-canary-heal */
/**
 * The compaction canary's self-heal ladder BY CAUSE
 * (context-budget-layered-summaries §9.1, run by the ContextBudgetSentinel, §7.8).
 *
 *   remediation-actions: [re-run-migration, re-stage-and-reinject-seed, record-only]
 *
 * For every SETTLED divergence the canary reports in the current verification
 * epoch (a compaction missing its recovery block or its PostCompact record):
 *  - the hook family is not installed            ⇒ re-run the migration;
 *  - installed, but no recovery block reached the model (none, or a truncated
 *    preview — RF's `recoveryTruncated`)         ⇒ re-stage the standing packet
 *    and inject it ONCE through the idle-gated injection step (the
 *    CompactionSentinel's `healReinject`, never `report`), idempotent on
 *    (session, context epoch), compensated by the seeded marker;
 *  - a "detection" with no real compaction (a press no boundary followed), a
 *    session that is gone, a session with no packet to re-seed (a throwaway), a compaction a newer one superseded, an engine whose
 *    detection cannot be healed by injection, or a missing PostCompact record
 *    with the block delivered                      ⇒ record only.
 *
 * Brakes are the SelfHealGate's (declared once, not re-implemented): one
 * episode per `machine.session.epoch` (the spec's dedupe key), `max-attempts: 3`,
 * `backoff: 10 min, 1 h`, `max-wall-clock: 30 min`, pool-shared (only the
 * session's owner acts), a ring of four episodes per session in the ladder's
 * OWN store file. Two brakes the gate does not hold live here, beside it, as
 * the quarantine ladder's 24 h breaker does: at most 3 heal attempts per session
 * per day (`eligible`), and the BREAKER — 3 completed heals of the same cause in
 * 24 h ⇒ that cause turns record-only and ONE Attention item is raised.
 * A completed remediation restarts the canary's verification epoch.
 */
import fs from 'node:fs';
import path from 'node:path';
import { SelfHealGate, SqliteSelfHealEpisodeStore, type SelfHealEpisodeStore, type SelfHealGateDeps, type SelfHealNotice, type SelfHealRemediationResult, type SelfHealSpec } from '../core/SelfHealGate.js';
import type { CanaryDetection, CompactionCanary } from './compactionCanary.js';
import type { HealReinjectOutcome } from './CompactionSentinel.js';
import { markerEpoch } from './contextEpoch.js';
import type { SeedMarker } from './compactionSeedMarker.js';

export const CANARY_HEAL_LADDER_ID = 'context-budget-canary-heal';
export const HEAL_MAX_ATTEMPTS = 3;
export const HEAL_BACKOFF_MS: readonly number[] = [10 * 60_000, 60 * 60_000];
export const HEAL_MAX_WALL_CLOCK_MS = 30 * 60_000;
export const HEAL_NOTIFICATION_LATENCY_MS = 300_000;
export const HEAL_PER_SESSION_PER_DAY = 3;
export const HEAL_BREAKER = { heals: 3, windowMs: 24 * 60 * 60_000 } as const;
/** How long one remediation waits for the idle-gated delivery before the next attempt checks again. */
export const HEAL_DELIVERY_WAIT_MS = 60_000;

export type HealCause =
  | 'hook-not-installed'
  | 'no-recovery-block'
  | 'recovery-truncated'
  | 'post-compact-missing'
  | 'session-gone'
  | 'superseded'
  | 'unhealable-engine'
  | 'not-reseedable'
  | 'press-without-compaction';
export type HealAction = 're-run-migration' | 're-stage-and-reinject-seed' | 'record-only';

/** The ladder, by cause (§9.1). */
export function actionForCause(c: HealCause): HealAction {
  switch (c) {
    case 'hook-not-installed': return 're-run-migration';
    case 'no-recovery-block':
    case 'recovery-truncated': return 're-stage-and-reinject-seed';
    default: return 'record-only';
  }
}

export interface HealLiveSession {
  tmuxSession: string;
  topicKey: string;
  /** Does the session have a standing packet to re-seed (a Telegram topic)? A throwaway press target does not. */
  reseedable: boolean;
}

export interface CanaryHealDeps {
  stateDir: string;
  machineId: string;
  canary: CompactionCanary;
  /** Is the compaction hook family installed (settings entries + current scripts)? */
  installCheck(): { installed: boolean; missing: string[] };
  /** Re-run the hook and settings migration. */
  rerunMigration(): Promise<{ ok: boolean; detail?: string }> | { ok: boolean; detail?: string };
  /** Can the injector act yet (the CompactionSentinel is built later in boot)? Not ready ⇒ the tick waits, spending nothing. */
  ready?(): boolean;
  /** The engine session's live Instar session on THIS machine, or null. */
  liveSession(claudeSessionId: string): HealLiveSession | null;
  /** Does this machine own that session's conversation? Anything but `true` refuses (pool-shared). */
  ownsSession(claudeSessionId: string): boolean | 'unknown';
  readMarker(claudeSessionId: string): SeedMarker | null;
  /** Re-stage the standing packet and deliver it once through the idle-gated path. */
  reinject(t: HealLiveSession & { claudeSessionId: string; epoch: string; boundaryAt: number }): Promise<HealReinjectOutcome | 'no-packet'>;
  attention(n: { id: string; title: string; summary: string; priority: 'NORMAL' | 'HIGH' | 'URGENT' }): void | Promise<void>;
  admit: SelfHealGateDeps['admit'];
  consumeToken: SelfHealGateDeps['consumeToken'];
  episodeStore?: SelfHealEpisodeStore;
  audit?: (e: { event: string; reason?: string; topicKey?: string }) => void;
  now?: () => number;
  bootId?: string;
  deliveryWaitMs?: number;
}

interface HandledRow { cause: HealCause; action: HealAction; outcome: string; at: number; sessionId: string; topicKey: string; terminal: boolean }
interface HealLedger {
  schema: 'canary-heal/1';
  handled: Record<string, HandledRow>;
  /** Completed remediations (the breaker's count). */
  heals: Array<{ cause: HealCause; at: number; sessionId: string }>;
  /** Every remediation run (the per-session daily cap). */
  runs: Array<{ sessionId: string; at: number }>;
  breakerRaisedAt: Partial<Record<HealCause, number>>;
  /** Exhaustion notices raised, per cause (at most one per cause per 24 h). */
  exhaustedRaisedAt?: Partial<Record<HealCause, number>>;
  /** A remediation completed: restart the verification epoch once every divergence in it is handled. */
  restartPending?: boolean;
  pendingNotices: Array<{ id: string; title: string; summary: string; priority: 'NORMAL' | 'HIGH' | 'URGENT' }>;
}

type Ctx = { d: CanaryDetection; cause: HealCause; action: HealAction };

export interface CanaryHealStatus {
  recent: Array<HandledRow & { epoch: string }>;
  healsLast24h: Partial<Record<HealCause, number>>;
  breakerOpen: HealCause[];
  lastRun: { at: number; outcome: string } | null;
}

const MAX_HANDLED = 500;

export class CanaryHealLadder {
  private readonly now: () => number;
  private readonly gate: SelfHealGate<Ctx>;
  private readonly file: string;
  private lastRun: { at: number; outcome: string } | null = null;
  /** The incident the gate is attempting right now (its notices are synchronous inside the attempt). */
  private current: Ctx | null = null;

  constructor(private readonly d: CanaryHealDeps) {
    this.now = d.now ?? Date.now;
    this.file = path.join(d.stateDir, 'state', 'context-budget', 'canary-heal.json');
    const store = d.episodeStore ?? new SqliteSelfHealEpisodeStore(path.join(d.stateDir, 'state', 'context-budget', 'canary-heal-episodes.db'), {
      // Four episodes per session (keys end in `.<epoch>`).
      ring: { groupOf: (k) => k.slice(0, k.lastIndexOf('.')), perGroup: 4 },
    });
    const spec: SelfHealSpec<Ctx> = {
      id: CANARY_HEAL_LADDER_ID, controllerResource: 'pool-shared', episodeAuthority: 'durable-machine-local', classId: 'context-budget-canary-heal',
      severity: () => 'recoverable',
      dedupeKey: (c) => this.episodeKey(c.d),
      eligible: (c) => {
        const l = this.load();
        const row = l.handled[c.d.boundaryUuid];
        if (row?.terminal) return { eligible: false, fence: null };
        if (this.runsToday(l, c.d.sessionId) >= HEAL_PER_SESSION_PER_DAY) return { eligible: false, fence: null };
        return { eligible: true, fence: `${c.d.sessionId}:${c.d.boundaryUuid}:${c.action}` };
      },
      isOwner: (c) => d.ownsSession(c.d.sessionId),
      remediationMode: 'async',
      remediationAsync: (c) => this.remediate(c),
      maxRemediationMs: (d.deliveryWaitMs ?? HEAL_DELIVERY_WAIT_MS) + 15_000,
      maxAttempts: HEAL_MAX_ATTEMPTS,
      maxWallClockMs: HEAL_MAX_WALL_CLOCK_MS,
      backoffMs: (attempt) => HEAL_BACKOFF_MS[Math.min(Math.max(attempt, 1), HEAL_BACKOFF_MS.length) - 1],
      notificationLatencyCeilingMs: HEAL_NOTIFICATION_LATENCY_MS,
      flap: { maxRecoveries: 3, windowMs: 24 * 60 * 60_000 },
      remediationActions: {
        operation: 're-run-migration | re-stage-and-reinject-seed',
        idempotencyGuard: 'one episode per machine.session.context-epoch; a server-written seeded marker for the epoch means delivered',
        compensation: 'the seeded marker for the epoch makes a later carrier for that compaction a no-op',
      },
    };
    this.gate = new SelfHealGate(spec, {
      admit: d.admit, consumeToken: d.consumeToken, episodeStore: store, now: this.now, bootId: d.bootId,
      notify: (n) => this.onGateNotice(n),
      audit: (e) => d.audit?.({ event: `heal-gate:${e.event}`, ...(e.reason ? { reason: e.reason } : {}) }),
    });
  }

  private machineSlug(): string {
    const s = this.d.machineId.toLowerCase().replace(/[^a-z0-9._-]/g, '-').replace(/^[^a-z0-9]+/, '');
    return (s || 'm').slice(0, 20);
  }

  /** The spec's dedupe key `machine-session-epoch` (dots: ids contain hyphens; pool-shared keys forbid colons). */
  private episodeKey(d: CanaryDetection): string {
    const safe = (x: string) => x.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 48);
    return `${this.machineSlug()}.${safe(d.sessionId)}.${safe(d.boundaryUuid)}`;
  }

  private load(): HealLedger {
    try {
      const v = JSON.parse(fs.readFileSync(this.file, 'utf-8')) as HealLedger;
      if (v && v.schema === 'canary-heal/1' && v.handled && Array.isArray(v.heals)) return { ...v, runs: v.runs ?? [], breakerRaisedAt: v.breakerRaisedAt ?? {}, exhaustedRaisedAt: v.exhaustedRaisedAt ?? {}, pendingNotices: v.pendingNotices ?? [] };
    } catch { /* @silent-fallback-ok — no ledger yet (or unreadable: start over; the gate's episode store still holds the brakes) */ }
    return { schema: 'canary-heal/1', handled: {}, heals: [], runs: [], breakerRaisedAt: {}, exhaustedRaisedAt: {}, pendingNotices: [] };
  }

  private save(l: HealLedger): void {
    const now = this.now();
    l.heals = l.heals.filter((h) => now - h.at <= HEAL_BREAKER.windowMs);
    l.runs = l.runs.filter((r) => now - r.at <= 24 * 60 * 60_000);
    const keys = Object.keys(l.handled);
    if (keys.length > MAX_HANDLED) for (const k of keys.sort((a, b) => l.handled[a].at - l.handled[b].at).slice(0, keys.length - MAX_HANDLED)) delete l.handled[k];
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(l), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  private runsToday(l: HealLedger, sessionId: string): number {
    const now = this.now();
    return l.runs.filter((r) => r.sessionId === sessionId && now - r.at <= 24 * 60 * 60_000).length;
  }

  private breakerOpen(l: HealLedger, cause: HealCause): boolean {
    const now = this.now();
    return l.heals.filter((h) => h.cause === cause && now - h.at <= HEAL_BREAKER.windowMs).length >= HEAL_BREAKER.heals;
  }

  /** Why this divergence happened, for the ladder (deterministic, over file and session evidence). */
  classify(d: CanaryDetection, newestBoundary: string | null): HealCause {
    if (d.engine !== 'claude-code') return 'unhealable-engine';
    if (newestBoundary !== null && newestBoundary !== d.boundaryUuid) return 'superseded';
    const live = this.d.liveSession(d.sessionId);
    if (!live) return 'session-gone';
    const inst = this.d.installCheck();
    if (!inst.installed) return 'hook-not-installed';
    if (d.recoveryTruncated === true || !d.recoveryBlock) {
      if (!live.reseedable) return 'not-reseedable';
      return d.recoveryTruncated === true ? 'recovery-truncated' : 'no-recovery-block';
    }
    return 'post-compact-missing';
  }

  /** One pass over the canary's settled divergences. Never more than one remediation per tick. */
  async tick(): Promise<void> {
    await this.flushNotices();
    const l = this.load();
    // A press no boundary followed: a detection without a real compaction ⇒ record only.
    for (const p of this.d.canary.takeUnmatchedPresses()) {
      l.handled[`press:${p.sessionId}:${p.at}`] = { cause: 'press-without-compaction', action: 'record-only', outcome: 'recorded', at: this.now(), sessionId: p.sessionId, topicKey: '', terminal: true };
      this.d.audit?.({ event: 'heal-recorded', reason: 'press-without-compaction' });
    }
    this.save(l);
    let ready = true;
    try { ready = this.d.ready?.() ?? true; } catch { ready = false; } // @silent-fallback-ok — not ready: wait a tick, spend nothing
    const divergences = this.d.canary.divergences();
    let ran = false;
    for (const det of divergences) {
      const cur = this.load();
      if (cur.handled[det.boundaryUuid]?.terminal) continue;
      const bounds = this.d.canary.boundariesOf(det.sessionId);
      const newest = bounds.length ? bounds.reduce((a, b) => (b.at >= a.at ? b : a)).uuid : null;
      const cause = this.classify(det, newest);
      let action = actionForCause(cause);
      const breaker = action !== 'record-only' && this.breakerOpen(cur, cause);
      if (breaker) action = 'record-only';
      if (action === 'record-only') {
        cur.handled[det.boundaryUuid] = { cause, action, outcome: breaker ? 'breaker-open' : 'recorded', at: this.now(), sessionId: det.sessionId, topicKey: det.topicKey, terminal: true };
        this.save(cur);
        this.d.audit?.({ event: 'heal-recorded', reason: `${cause}${breaker ? ' (breaker open)' : ''}`, topicKey: det.topicKey });
        continue;
      }
      if (ran) continue; // one remediation per tick (each may wait on an idle prompt)
      if (!ready && action === 're-stage-and-reinject-seed') continue; // the injector is not built yet: wait, spending nothing
      // The per-session daily cap is checked BEFORE the gate, so a capped session opens no episode
      // (an episode that never runs would exhaust on its wall clock and page about tries never made).
      if (this.runsToday(cur, det.sessionId) >= HEAL_PER_SESSION_PER_DAY) {
        cur.handled[det.boundaryUuid] = { cause, action, outcome: 'capped', at: this.now(), sessionId: det.sessionId, topicKey: det.topicKey, terminal: false };
        this.save(cur);
        continue;
      }
      const ctx: Ctx = { d: det, cause, action };
      this.current = ctx;
      let res;
      try { res = await this.gate.attempt(ctx); } finally { this.current = null; }
      this.lastRun = { at: this.now(), outcome: `${res.outcome}:${res.reason}` };
      const after = this.load();
      const row = (outcome: string, terminal: boolean): HandledRow => ({ cause, action, outcome, at: this.now(), sessionId: det.sessionId, topicKey: det.topicKey, terminal });
      if (res.outcome === 'healed') {
        after.handled[det.boundaryUuid] = row(`healed:${res.reason}`, true);
        after.heals.push({ cause, at: this.now(), sessionId: det.sessionId });
        after.restartPending = true;
        this.save(after);
        this.d.audit?.({ event: 'heal-completed', reason: `${cause} → ${action}`, topicKey: det.topicKey });
        await this.maybeTripBreaker(cause);
        ran = true;
        continue;
      }
      after.handled[det.boundaryUuid] = row(`${res.outcome}:${res.reason}`, res.outcome === 'exhausted');
      this.save(after);
      if (res.outcome === 'attempted') ran = true;
      if (res.outcome === 'state-failure') throw new Error(`heal episode store: ${res.reason}`);
    }
    // §9.1: the verification epoch restarts when a remediation completes — once EVERY divergence
    // in it has been handled (healed, exhausted or recorded), so a restart never drops another
    // session's outstanding divergence before the ladder has served it.
    const fin = this.load();
    if (fin.restartPending && this.d.canary.divergences().every((x) => fin.handled[x.boundaryUuid]?.terminal === true)) {
      fin.restartPending = false;
      this.save(fin);
      this.d.canary.restartEpoch();
      this.d.audit?.({ event: 'heal-epoch-restarted' });
    }
  }

  /** Terminal episodes of this ladder only (the sentinel's prune step). */
  prune(): void { this.gate.pruneTerminal(); }

  private async remediate(c: Ctx): Promise<SelfHealRemediationResult> {
    const l = this.load();
    l.runs.push({ sessionId: c.d.sessionId, at: this.now() });
    this.save(l);
    if (c.action === 're-run-migration') {
      let r: { ok: boolean; detail?: string };
      try { r = await this.d.rerunMigration(); } catch (err) { r = { ok: false, detail: err instanceof Error ? err.message : String(err) }; /* @silent-fallback-ok — audited just below; the install check decides the outcome */ }
      this.d.audit?.({ event: 'heal-migration', reason: `${r.ok ? 'ok' : 'failed'}${r.detail ? `: ${r.detail}` : ''}`, topicKey: c.d.topicKey });
      return this.d.installCheck().installed ? { outcome: 'healed', evidence: 'repaired' } : { outcome: 'not-healed', evidence: 'verification-failed' };
    }
    // re-stage-and-reinject-seed — compensation first: the epoch already delivered by the server.
    const marker = this.d.readMarker(c.d.sessionId);
    if (marker && marker.source !== undefined && marker.source !== 'compact'
      && markerEpoch(marker, this.d.canary.boundariesOf(c.d.sessionId)) === c.d.boundaryUuid) {
      return { outcome: 'healed', evidence: 'already-healthy' };
    }
    const live = this.d.liveSession(c.d.sessionId);
    if (!live) return { outcome: 'not-healed', evidence: 'source-absent' };
    const wait = this.d.deliveryWaitMs ?? HEAL_DELIVERY_WAIT_MS;
    let timer: NodeJS.Timeout | undefined;
    const outcome = await Promise.race([
      this.d.reinject({ ...live, claudeSessionId: c.d.sessionId, epoch: c.d.boundaryUuid, boundaryAt: c.d.at }),
      new Promise<'still-staged'>((resolve) => { timer = setTimeout(() => resolve('still-staged'), wait); timer.unref?.(); }),
    ]).finally(() => { if (timer) clearTimeout(timer); });
    this.d.audit?.({ event: 'heal-reinject', reason: String(outcome), topicKey: c.d.topicKey });
    if (outcome === 'delivered' || outcome === 'already-delivered') return { outcome: 'healed', evidence: 'repaired' };
    if (outcome === 'no-packet') return { outcome: 'not-healed', evidence: 'source-absent' };
    return { outcome: 'not-healed', evidence: 'verification-failed' };
  }

  private async maybeTripBreaker(cause: HealCause): Promise<void> {
    const l = this.load();
    if (!this.breakerOpen(l, cause)) return;
    const last = l.breakerRaisedAt[cause];
    if (last !== undefined && this.now() - last < HEAL_BREAKER.windowMs) return; // raise ONCE per window
    l.breakerRaisedAt[cause] = this.now();
    l.pendingNotices.push({
      id: `context-budget-canary-heal-breaker-${cause}-${this.now()}`,
      title: 'Compaction recovery keeps failing the same way on this machine',
      summary: `The same problem (${cause.replace(/-/g, ' ')}) needed fixing ${HEAL_BREAKER.heals} times in a day, so the automatic fix has stopped for now and only records it. Sessions on this machine may lose their place after a compaction until someone looks at it.`,
      priority: 'HIGH',
    });
    this.save(l);
    await this.flushNotices();
  }

  private async flushNotices(): Promise<void> {
    const l = this.load();
    if (l.pendingNotices.length === 0) return;
    const keep: HealLedger['pendingNotices'] = [];
    for (const n of l.pendingNotices) {
      try { await this.d.attention(n); } catch (err) { keep.push(n); this.d.audit?.({ event: 'heal-notice-pending', reason: err instanceof Error ? err.message : String(err) }); /* @silent-fallback-ok — kept durably and retried every tick */ }
    }
    const fresh = this.load();
    fresh.pendingNotices = [...keep, ...fresh.pendingNotices.filter((x) => !l.pendingNotices.some((y) => y.id === x.id))];
    this.save(fresh);
  }

  /**
   * Exhaustion reaches the operator ONCE per cause per 24 h (an Attention item; §7.8's
   * "same-cause exhaustions ⇒ one notice"); a slow heal is audited, never paged (its own
   * backoff exceeds the ceiling by design).
   */
  private async onGateNotice(n: SelfHealNotice): Promise<void> {
    const exhausted = ['max-attempts', 'wall-clock', 'flap', 'state-failure'].includes(n.reason);
    if (!exhausted) { this.d.audit?.({ event: 'heal-slow', reason: n.reason }); return; }
    const l = this.load();
    const cause = this.current?.cause;
    const raisedKey: HealCause | undefined = n.reason === 'state-failure' ? undefined : cause;
    if (raisedKey) {
      const last = l.exhaustedRaisedAt?.[raisedKey];
      if (last !== undefined && this.now() - last < HEAL_BREAKER.windowMs) { this.d.audit?.({ event: 'heal-exhausted-again', reason: raisedKey }); return; }
      l.exhaustedRaisedAt = { ...(l.exhaustedRaisedAt ?? {}), [raisedKey]: this.now() };
    }
    const id = `context-budget-canary-heal-${n.id.replace(/[^A-Za-z0-9_-]/g, '-')}`;
    if (l.pendingNotices.some((x) => x.id === id)) return;
    l.pendingNotices.push({
      id,
      title: n.reason === 'state-failure' ? 'The compaction recovery watcher on this machine could not record its work' : 'A session did not get its context back after a compaction',
      summary: n.reason === 'state-failure'
        ? 'Its record of repair attempts could not be written, so it has stopped repairing until that is fixed.'
        : 'After a compaction the session\'s briefing did not arrive, and the tries to restore it did not work. That session may have lost its place; a fresh session for that conversation will start with its full context. Further failures of the same kind today are recorded without another notice.',
      priority: 'HIGH',
    });
    this.save(l);
    // Sent on the next flush (this tick or the next), so a down Attention channel never loses it.
  }

  status(): CanaryHealStatus {
    const l = this.load();
    const now = this.now();
    const counts: Partial<Record<HealCause, number>> = {};
    for (const h of l.heals) if (now - h.at <= HEAL_BREAKER.windowMs) counts[h.cause] = (counts[h.cause] ?? 0) + 1;
    const causes = Object.keys(counts) as HealCause[];
    return {
      recent: Object.entries(l.handled).sort((a, b) => b[1].at - a[1].at).slice(0, 20).map(([epoch, r]) => ({ ...r, epoch })),
      healsLast24h: counts,
      breakerOpen: causes.filter((c) => this.breakerOpen(l, c)),
      lastRun: this.lastRun,
    };
  }
}
