/* @self-action-controller: context-budget-quarantine-reconcile */
/**
 * The ContextBudgetSentinel — Phase 0 core
 * (context-budget-layered-summaries §7.8, §9.3 "Quarantine", §16 Phase 0
 * "the sentinel skeleton (… boot sweep, quarantine reconciliation)").
 *
 * One server-side watcher per machine. Each tick (default 5 minutes), in this
 * order:
 *  1. QUARANTINE RECONCILIATION — every `quarantined` fold record this machine
 *     owns runs step 8 through a pool-shared, async `SelfHealGate` ladder (one
 *     episode per fold). Within the reconciliation bound (default 15 minutes,
 *     measured from the quarantine) it asks the rollback runner (Phase 2;
 *     absent ⇒ unavailable). Past the bound it FORCE-ENDS the candidate and,
 *     on a later tick, VERIFIES termination (no tmux session it ended is
 *     alive, no live session on the topic, and no transcript it recorded grew
 *     since the force-end). Only then does it move the record to
 *     `rolled-back` (`rollback-degraded`), which releases the holds and every
 *     carrier, and raise ONE notice. If termination cannot be verified —
 *     including a transcript it cannot read — containment STAYS: the record
 *     stays `quarantined`, and the ladder's exhaustion escalates through the
 *     Attention queue with the topic named. Nothing is released on an unknown.
 *  2. TORN RECORDS — a fold record file that exists but cannot be read is an
 *     unknown: the boot sweep keeps its carriers, and the owner's sentinel
 *     raises one Attention item naming the topic.
 *  3. CHECKPOINT GRACE PASS — `pruneSettledCheckpoints` deletes rolled-back
 *     folds' engine checkpoints after their 24 h grace.
 *  3b. OUTBOX and CANARY — pending notices are sent; the standing compaction
 *     canary (§9.1, `compactionCanary.ts`) scans the topic sessions' transcripts.
 *  4. GATE PRUNE — after the attempts (the gate's idle rule assumes the caller
 *     attempts before it prunes, and ticks well inside the ladder's wall clock).
 *  5. HEARTBEAT — the fold coordinator's `sentinelHeartbeatFresh` precondition
 *     reads it: no live sentinel, no fold.
 *
 * Non-owner sentinels observe only (the gate refuses before touching
 * anything). Never: writes A, G, U, C or H3; authors a handoff; sends to the
 * user (its notices go to the Attention queue); replaces a context except
 * through the fold's own rollback path.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { SelfHealGate, SqliteSelfHealEpisodeStore, type SelfHealEpisodeStore, type SelfHealGateDeps, type SelfHealNotice, type SelfHealRemediationResult, type SelfHealSpec } from '../core/SelfHealGate.js';
import type { FoldCoordinator, FoldRecord, FoldRecordStore } from './FoldCoordinator.js';
import { pruneSettledCheckpoints } from './engineCheckpoint.js';
import type { CanaryReport, CanarySession, CompactionCanary } from './compactionCanary.js';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';

export const CONTEXT_BUDGET_SENTINEL_TICK_MS = 5 * 60_000;
export const QUARANTINE_RECONCILE_BOUND_MS = 15 * 60_000;
export const QUARANTINE_LADDER_ID = 'context-budget-quarantine-reconcile';

export type RollbackOutcome = 'rolled-back' | 'failed' | 'unavailable';

/** A live process that may be the fold's candidate (a topic session). */
export interface FoldCandidate { tmuxSession: string; transcriptPath: string | null }

export interface AttentionNotice { id: string; title: string; summary: string; priority: 'NORMAL' | 'HIGH' | 'URGENT' }

export interface ContextBudgetSentinelDeps {
  stateDir: string;
  machineId: string;
  coordinator: FoldCoordinator;
  store: FoldRecordStore;
  /** Does this machine own the fold (the coordinator's own rule: topic owner, or its own record on a single machine)? */
  ownsFold(rec: FoldRecord): boolean | 'unknown';
  /** Does this machine own the topic (for torn-record escalation)? */
  ownsTopic(topicKey: string): boolean | 'unknown';
  /** Step 8's rollback runner (Phase 2). Absent ⇒ every quarantine waits for the bound. */
  rollback?(rec: FoldRecord): Promise<RollbackOutcome>;
  /** The topic's live sessions (the fold's possible candidates). */
  candidates(topicKey: string): FoldCandidate[];
  /** Is the tmux session alive? `'unknown'` when the probe failed or timed out — never read as gone. */
  tmuxAlive(tmuxSession: string): boolean | 'unknown';
  kill(tmuxSession: string): void | Promise<void>;
  /** A file's size, or null when it cannot be read. */
  fileBytes(p: string): number | null;
  attention(n: AttentionNotice): void | Promise<void>;
  admit: SelfHealGateDeps['admit'];
  consumeToken: SelfHealGateDeps['consumeToken'];
  audit?: (event: { event: string; reason?: string; topicKey?: string; foldId?: string }) => void;
  episodeStore?: SelfHealEpisodeStore;
  now?: () => number;
  tickMs?: number;
  reconcileBoundMs?: number;
  bootId?: string;
  /**
   * The standing compaction canary (§9.1): observation only. Each tick scans the
   * topic sessions' transcripts; its report rides the sentinel's status.
   */
  canary?: { instance: CompactionCanary; sessions(): CanarySession[]; switchOn(): boolean };
}

type Ctx = { topicKey: string; foldId: string };

/** What a force-end left behind for the termination check. */
interface TerminationSnapshot { topicKey: string; at: number; tmux: string[]; transcripts: Array<{ path: string | null; bytes: number | null }> }

/** A notice that must survive a down Attention channel and a restart; sent once its condition holds. */
interface OutboxEntry { notice: AttentionNotice; whenRolledBack?: { topicKey: string; foldId: string } }

/** Bound on any one tick step, so a hung dependency cannot wedge the sentinel. */
const STEP_TIMEOUT_MS = 2 * 60_000;

export interface SentinelStatus {
  lastTickAt: number | null;
  heartbeatFresh: boolean;
  quarantined: Array<{ topicKey: string; foldId: string; ageMs: number; owned: boolean | 'unknown'; lastOutcome: string | null }>;
  torn: Array<{ topicKey: string; foldId: string }>;
  checkpointsPruned: number;
  lastError: string | null;
  /** The compaction canary's report (null when no canary is wired). */
  canary: CanaryReport | null;
}

function keyHash(value: string): string { return crypto.createHash('sha256').update(value).digest('hex').slice(0, 24); }

export class ContextBudgetSentinel {
  private readonly now: () => number;
  private readonly tickMs: number;
  private readonly boundMs: number;
  private readonly gate: SelfHealGate<Ctx>;
  private readonly lastOutcome = new Map<string, string>();
  private readonly noticeTopics = new Map<string, Ctx>();
  private lastTickAt: number | null = null;
  private lastError: string | null = null;
  private lastTorn: Array<{ topicKey: string; foldId: string }> = [];
  private checkpointsPruned = 0;
  private ticking = false;

  constructor(private readonly d: ContextBudgetSentinelDeps) {
    this.now = d.now ?? Date.now;
    this.tickMs = d.tickMs ?? CONTEXT_BUDGET_SENTINEL_TICK_MS;
    this.boundMs = d.reconcileBoundMs ?? QUARANTINE_RECONCILE_BOUND_MS;
    // The gate's idle-prune rule needs the tick well inside the ladder's wall clock.
    const wallClock = this.boundMs * 3;
    if (!(this.tickMs > 0) || this.tickMs * 2 > wallClock) throw new Error('ContextBudgetSentinel: tick interval must be under half the ladder wall clock');
    const store = d.episodeStore ?? new SqliteSelfHealEpisodeStore(path.join(d.stateDir, 'state', 'context-budget', 'self-heal-episodes.db'), {
      // Four episodes per topic+cause (§9.4); per-incident keys end in `-<foldId>`.
      ring: { groupOf: (k) => k.slice(0, k.lastIndexOf('-')), perGroup: 4 },
    });
    const spec: SelfHealSpec<Ctx> = {
      id: QUARANTINE_LADDER_ID, controllerResource: 'pool-shared', episodeAuthority: 'durable-machine-local', classId: 'context-budget-quarantine',
      severity: () => 'recoverable',
      dedupeKey: (c) => `${this.machineSlug()}-${c.topicKey}-quarantine-${c.foldId}`.slice(0, 120),
      eligible: (c) => {
        const r = d.store.get(c.topicKey, c.foldId);
        return r && r.state === 'quarantined' ? { eligible: true, fence: `${r.foldId}:${r.seq}:${r.generation}` } : { eligible: false, fence: null };
      },
      isOwner: (c) => { const r = d.store.get(c.topicKey, c.foldId); return r ? d.ownsFold(r) : false; },
      remediationMode: 'async',
      remediationAsync: (c) => this.reconcileOnce(c),
      maxRemediationMs: 2 * 60_000,
      maxAttempts: 12,
      maxWallClockMs: wallClock,
      backoffMs: () => 0, // paced by the tick
      // Above the bound plus two ticks: a quarantine waiting its bound is expected, not slow.
      notificationLatencyCeilingMs: this.boundMs + 2 * this.tickMs,
      flap: { maxRecoveries: 3, windowMs: 24 * 60 * 60_000 },
      remediationActions: { operation: 'rollback-or-force-end-and-verify', idempotencyGuard: 'fold record CAS on (state, seq, generation)', compensation: 'containment stays on any unknown' },
    };
    this.gate = new SelfHealGate(spec, {
      admit: d.admit, consumeToken: d.consumeToken, episodeStore: store, now: this.now, bootId: d.bootId,
      notify: (n) => this.onGateNotice(n),
      audit: (e) => d.audit?.({ event: `gate:${e.event}`, ...(e.reason ? { reason: e.reason } : {}) }),
    });
  }

  private machineSlug(): string {
    const s = this.d.machineId.toLowerCase().replace(/[^a-z0-9._-]/g, '-').replace(/^[^a-z0-9]+/, '');
    return (s || 'm').slice(0, 40);
  }

  /** The fold precondition: a sentinel that ticked within two intervals. */
  heartbeatFresh(): boolean {
    return this.lastTickAt !== null && this.now() - this.lastTickAt <= 2 * this.tickMs;
  }

  /** One tick. Never throws; overlapping calls are skipped. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    this.lastError = null;
    let clean = true;
    try {
      clean = await this.step('quarantine', () => this.reconcileQuarantines()) && clean;
      clean = await this.step('torn', () => this.escalateTorn()) && clean;
      clean = await this.step('outbox', () => this.flushOutbox()) && clean;
      if (this.d.canary) { const k = this.d.canary; clean = await this.step('canary', () => k.instance.scan(k.sessions(), k.switchOn())) && clean; }
      clean = await this.step('checkpoints', () => { this.checkpointsPruned += pruneSettledCheckpoints(this.d.stateDir, this.now()).length; }) && clean;
      clean = await this.step('prune', () => { this.gate.pruneTerminal(); }) && clean;
      // The heartbeat means a WORKING sentinel: a tick with a failed step does not refresh it.
      if (clean) this.lastTickAt = this.now();
    } finally {
      this.ticking = false;
    }
  }

  private async step(name: string, fn: () => unknown): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.resolve().then(fn),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${STEP_TIMEOUT_MS} ms`)), STEP_TIMEOUT_MS); timer.unref?.(); }),
      ]);
      return true;
    } catch (err) { // @silent-fallback-ok — not silent: recorded as lastError (in the status), audited, and the tick is unclean so the heartbeat goes stale (no fold can begin)
      this.lastError = `${name}: ${err instanceof Error ? err.message : String(err)}`;
      this.d.audit?.({ event: 'step-failed', reason: this.lastError });
      return false;
    } finally { if (timer) clearTimeout(timer); }
  }

  private quarantinedRecords(): FoldRecord[] {
    const out: FoldRecord[] = [];
    for (const t of this.d.store.topics()) for (const r of this.d.store.list(t)) if (r.state === 'quarantined') out.push(r);
    return out;
  }

  private async reconcileQuarantines(): Promise<void> {
    const live = new Set<string>();
    let stateFailure: string | null = null;
    this.noticeTopics.clear();
    for (const r of this.quarantinedRecords()) {
      const ctx = { topicKey: r.topicKey, foldId: r.foldId };
      live.add(r.foldId);
      this.noticeTopics.set(keyHash(`${QUARANTINE_LADDER_ID}:${`${this.machineSlug()}-${r.topicKey}-quarantine-${r.foldId}`.slice(0, 120)}`), ctx);
      const res = await this.gate.attempt(ctx);
      this.lastOutcome.set(r.foldId, `${res.outcome}:${res.reason}`);
      if (res.outcome === 'state-failure') stateFailure = res.reason;
    }
    // Drop a snapshot only on a KNOWN end: the record is absent, or readable and no
    // longer quarantined. A torn record or a failed listing keeps it (never forget
    // evidence on an unknown).
    for (const k of this.listSnapshots()) {
      if (live.has(k)) continue;
      const snap = this.readSnapshot(k);
      if (!snap) continue;
      const seen = this.d.store.inspect(snap.topicKey, k);
      if (seen.kind === 'absent' || (seen.kind === 'ok' && seen.record.state !== 'quarantined')) this.dropSnapshot(k);
    }
    for (const k of [...this.lastOutcome.keys()]) if (!live.has(k)) this.lastOutcome.delete(k);
    // A sentinel that cannot record its own ladder is not a working sentinel (no heartbeat).
    if (stateFailure) throw new Error(`episode store: ${stateFailure}`);
  }

  /** Step 8 for one quarantined fold: rollback within the bound; past it, force-end, verify, then rollback-degraded. */
  private async reconcileOnce(c: Ctx): Promise<SelfHealRemediationResult> {
    const rec = this.d.store.get(c.topicKey, c.foldId);
    if (!rec || rec.state !== 'quarantined') return { outcome: 'healed', evidence: 'already-healthy' };
    const age = this.now() - rec.updatedAt; // quarantined → rolled-back is the only edge, so updatedAt is the quarantine time
    if (!(age >= this.boundMs)) { // a missing or bad timestamp waits, never ends a session early
      if (!this.d.rollback) return { outcome: 'not-healed', evidence: 'source-absent' };
      const r = await this.d.rollback(rec);
      const after = this.d.store.get(c.topicKey, c.foldId);
      return r === 'rolled-back' && after?.state === 'rolled-back' ? { outcome: 'healed', evidence: 'repaired' } : { outcome: 'not-healed', evidence: 'verification-failed' };
    }
    // Past the bound: force-end the candidate, then verify termination on a LATER tick.
    // The snapshot is DURABLE and only ever GROWS (every session and transcript seen
    // across attempts and restarts), so an unreadable transcript is never forgotten
    // and a re-force-end can never verify vacuously.
    const prev = this.readSnapshot(c.foldId);
    if (prev && this.terminated(c.topicKey, prev)) {
      // fall through to the rollback-degraded transition below
    } else {
      const cands = this.d.candidates(c.topicKey);
      const tmux = [...new Set([...(prev?.tmux ?? []), ...cands.map((k) => k.tmuxSession)])];
      for (const t of tmux) {
        if (this.d.tmuxAlive(t) === false) continue;
        try { await this.d.kill(t); } catch (err) {
          // e.g. a protected session: it stays alive, so termination is not verified and the ladder escalates.
          this.d.audit?.({ event: 'kill-refused', reason: err instanceof Error ? err.message : String(err), topicKey: c.topicKey, foldId: c.foldId });
        }
      }
      const paths = new Map<string, string | null>();
      for (const t of prev?.transcripts ?? []) paths.set(t.path ?? `null:${paths.size}`, t.path);
      for (const k of cands) paths.set(k.transcriptPath ?? `null:${paths.size}`, k.transcriptPath);
      this.writeSnapshot(c.foldId, {
        topicKey: c.topicKey, at: this.now(), tmux,
        transcripts: [...paths.values()].map((p) => ({ path: p, bytes: p ? this.d.fileBytes(p) : null })),
      });
      this.d.audit?.({ event: prev ? 'force-end-repeated' : 'force-ended', topicKey: c.topicKey, foldId: c.foldId });
      return { outcome: 'not-healed', evidence: 'verification-failed' }; // verified no sooner than one tick later
    }
    // The notice is written DURABLY before the transition and sent only once the
    // record is rolled back, so a down Attention channel or a crash cannot lose it.
    this.enqueue({
      notice: {
        id: `context-budget-rollback-degraded-${c.topicKey}-${c.foldId}`,
        title: `A context fold on topic ${c.topicKey} was rolled back the slow way`,
        summary: `Fold ${c.foldId} could not finish or roll back within its time limit, so its session was ended and the conversation was released. Its earlier context may need restoring by hand.`,
        priority: 'HIGH',
      },
      whenRolledBack: { topicKey: c.topicKey, foldId: c.foldId },
    });
    const t = this.d.coordinator.transition(c.topicKey, c.foldId, { state: rec.state, seq: rec.seq, generation: rec.generation }, 'rolled-back', {
      reason: 'rollback-degraded: reconciliation bound passed; the candidate was force-ended and its termination verified',
    });
    if (!t.ok) return { outcome: 'not-healed', evidence: 'fence-stale' };
    this.dropSnapshot(c.foldId);
    await this.flushOutbox();
    return { outcome: 'healed', evidence: 'repaired' };
  }

  /** Verified termination: nothing it ended is alive, no live session on the topic, and no transcript grew (or is unreadable). */
  private terminated(topicKey: string, snap: TerminationSnapshot): boolean {
    if (this.now() - snap.at < this.tickMs) return false; // at least one tick of quiet
    // Nothing was ever seen to end (e.g. the candidate died with a crash and left no
    // session): there is no evidence of termination, so containment stays.
    if (snap.tmux.length === 0 && snap.transcripts.length === 0) return false;
    if (snap.tmux.some((t) => this.d.tmuxAlive(t) !== false)) return false; // alive OR unknown
    if (this.d.candidates(topicKey).some((k) => this.d.tmuxAlive(k.tmuxSession) !== false)) return false;
    for (const t of snap.transcripts) {
      if (t.path === null || t.bytes === null) return false; // no evidence of quiet is not quiet
      if (this.d.fileBytes(t.path) !== t.bytes) return false;
    }
    return true;
  }

  private snapshotDir(): string { return path.join(this.d.stateDir, 'state', 'context-budget', 'termination'); }
  private readSnapshot(foldId: string): TerminationSnapshot | null {
    try {
      const v = JSON.parse(fs.readFileSync(path.join(this.snapshotDir(), `${foldId}.json`), 'utf-8')) as TerminationSnapshot;
      return v && typeof v.topicKey === 'string' && typeof v.at === 'number' && Array.isArray(v.tmux) && Array.isArray(v.transcripts) ? v : null;
    } catch { return null; } // @silent-fallback-ok — no snapshot yet: the next attempt force-ends and records one
  }
  private writeSnapshot(foldId: string, snap: TerminationSnapshot): void {
    const dir = this.snapshotDir(); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const f = path.join(dir, `${foldId}.json`); const tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(snap), { mode: 0o600 }); fs.renameSync(tmp, f);
  }
  private listSnapshots(): string[] {
    try { return fs.readdirSync(this.snapshotDir()).filter((f) => /^[A-Za-z0-9_-]+\.json$/.test(f)).map((f) => f.slice(0, -5)); } catch { return []; } // @silent-fallback-ok — no directory means no snapshots
  }
  private dropSnapshot(foldId: string): void {
    const f = path.join(this.snapshotDir(), `${foldId}.json`);
    if (fs.existsSync(f)) SafeFsExecutor.safeRmSync(f, { force: true, operation: 'src/monitoring/ContextBudgetSentinel.ts:dropSnapshot' });
  }

  private outboxFile(): string { return path.join(this.d.stateDir, 'state', 'context-budget', 'outbox.json'); }
  private readOutbox(): Record<string, OutboxEntry> {
    try { const v = JSON.parse(fs.readFileSync(this.outboxFile(), 'utf-8')); return v && typeof v === 'object' ? v as Record<string, OutboxEntry> : {}; } catch { return {}; } // @silent-fallback-ok — no outbox yet
  }
  private writeOutbox(o: Record<string, OutboxEntry>): void {
    const f = this.outboxFile(); fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
    const tmp = `${f}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(o), { mode: 0o600 }); fs.renameSync(tmp, f);
  }
  private enqueue(e: OutboxEntry): void { const o = this.readOutbox(); if (!o[e.notice.id]) { o[e.notice.id] = e; this.writeOutbox(o); } }

  /** Send every pending notice whose condition holds; keep the rest (and any that fail) for the next tick. */
  private async flushOutbox(): Promise<void> {
    const o = this.readOutbox();
    const done: string[] = [];
    for (const [id, e] of Object.entries(o)) {
      if (e.whenRolledBack) {
        const seen = this.d.store.inspect(e.whenRolledBack.topicKey, e.whenRolledBack.foldId);
        if (seen.kind === 'torn' || (seen.kind === 'ok' && seen.record.state === 'quarantined')) continue; // not yet (or unknown): keep
        // Only a fold THIS path rolled back the slow way gets the notice; any other end drops it.
        if (!(seen.kind === 'ok' && seen.record.state === 'rolled-back' && (seen.record.reason ?? '').startsWith('rollback-degraded'))) { done.push(id); continue; }
      }
      try { await this.d.attention(e.notice); done.push(id); } catch (err) {
        this.d.audit?.({ event: 'notice-pending', reason: err instanceof Error ? err.message : String(err) });
      }
    }
    // Re-read before writing: an entry queued meanwhile (e.g. by a step still running after its timeout) survives.
    if (done.length) { const fresh = this.readOutbox(); for (const id of done) delete fresh[id]; this.writeOutbox(fresh); }
  }

  private onGateNotice(n: SelfHealNotice): Promise<void> | void {
    const m = /^self-heal:([0-9a-f]{24}):/.exec(n.id);
    const ctx = m ? this.noticeTopics.get(m[1]) : undefined;
    const where = ctx ? `topic ${ctx.topicKey} (fold ${ctx.foldId})` : 'a topic on this machine';
    const exhausted = ['max-attempts', 'wall-clock', 'flap', 'state-failure'].includes(n.reason);
    return this.d.attention({
      id: `context-budget-quarantine-${ctx ? `${ctx.topicKey}-${ctx.foldId}` : n.id.replace(/[^A-Za-z0-9_-]/g, '-')}-${n.reason}`,
      title: n.reason === 'state-failure' ? `The context fold watcher on this machine could not record its work${ctx ? ` (${where})` : ''}`
        : exhausted ? `A stuck context fold on ${where} needs you` : `A context fold on ${where} is slow to recover`,
      summary: exhausted
        ? 'Its session could not be confirmed as stopped, so the conversation stays paused rather than risk replies from the wrong state. Check the session for that topic.'
        : 'Its recovery is taking longer than expected; the conversation stays paused until it finishes.',
      priority: exhausted ? 'URGENT' : 'HIGH',
    });
  }

  private raisedTornFile(): string { return path.join(this.d.stateDir, 'state', 'context-budget', 'torn-raised.json'); }
  private readRaisedTorn(): Set<string> {
    try { const v = JSON.parse(fs.readFileSync(this.raisedTornFile(), 'utf-8')); return new Set(Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []); } catch { return new Set(); } // @silent-fallback-ok — no file yet means nothing raised
  }

  /** One Attention item per torn record this machine owns, raised once (durably). */
  private async escalateTorn(): Promise<void> {
    const torn: Array<{ topicKey: string; foldId: string }> = [];
    for (const t of this.d.store.topics()) for (const f of this.d.store.tornRecords(t)) torn.push({ topicKey: t, foldId: f });
    this.lastTorn = torn;
    const raised = this.readRaisedTorn();
    let changed = false;
    for (const x of torn) {
      const k = `${x.topicKey}/${x.foldId}`;
      if (raised.has(k) || this.d.ownsTopic(x.topicKey) !== true) continue;
      this.enqueue({ notice: {
        id: `context-budget-torn-record-${x.topicKey}-${x.foldId}`,
        title: `A context fold record on topic ${x.topicKey} is unreadable`,
        summary: `The record for fold ${x.foldId} is damaged, so the conversation's pause and its saved copy are kept in place rather than released on a guess. It needs a look before that conversation can continue normally.`,
        priority: 'URGENT',
      } });
      raised.add(k); changed = true;
    }
    // Forget entries whose record became readable or vanished, so a recurrence raises again.
    const live = new Set(torn.map((x) => `${x.topicKey}/${x.foldId}`));
    for (const k of [...raised]) if (!live.has(k)) { raised.delete(k); changed = true; }
    if (changed) {
      const f = this.raisedTornFile();
      fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
      const tmp = `${f}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify([...raised]), { mode: 0o600 });
      fs.renameSync(tmp, f);
    }
  }

  status(): SentinelStatus {
    const now = this.now();
    return {
      lastTickAt: this.lastTickAt,
      heartbeatFresh: this.heartbeatFresh(),
      quarantined: this.quarantinedRecords().map((r) => ({ topicKey: r.topicKey, foldId: r.foldId, ageMs: now - r.updatedAt, owned: this.d.ownsFold(r), lastOutcome: this.lastOutcome.get(r.foldId) ?? null })),
      torn: this.lastTorn,
      checkpointsPruned: this.checkpointsPruned,
      lastError: this.lastError,
      canary: this.d.canary ? this.d.canary.instance.report(this.d.canary.switchOn()) : null,
    };
  }
}
