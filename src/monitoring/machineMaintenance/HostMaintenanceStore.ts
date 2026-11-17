/**
 * The host-level drain record (docs/specs/machine-self-maintenance.md, Part D).
 *
 * One file every agent on this OS login can read, with no token, beside the other
 * host-wide files. Writes go through one lock with fsync and rename. `reserve()` is
 * the only way to open an episode, so concurrent agents share one instead of each
 * opening their own, and a write from a stale generation is refused.
 *
 * Increment 1 writes only rehearsal records. `watchOnly` is the literal `true` in
 * the type: no reader may treat this record as a live drain, and no path in this
 * build can write one that is not watch-only.
 *
 * The wedge sampler (Part E, dry-run) adds two host files under the same lock: the
 * maintainer heartbeat, so only one agent per login samples and calls the judge,
 * and the sampler's durable state, so a takeover inherits its budgets and episodes.
 * Enrolment is not built, so the maintainer is whichever gated agent claims first;
 * a heartbeat older than 10 minutes lets another take over.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicWriteFileSync, legacyPidDeathLockReclaim, releaseLock, tryTakeLockOnce } from '../../core/hostSemaphoreCore.js';
import { pidAlive } from '../../core/pollIntent.js';
import type { DelayId, SafetyHoldId } from './planner.js';

export type DrainState = 'reserved' | 'quiescing' | 'closed';

export interface DrainRecord {
  watchOnly: true;
  episodeId: string;
  generation: number;
  openedBy: string;
  state: DrainState;
  restartAt: number;
  originalRestartAt: number;
  windowEnd: number;
  final: boolean;
  activeDelays: DelayId[];
  delayMinutesUsed: Partial<Record<DelayId, number>>;
  holds: SafetyHoldId[];
  until: number;
  expiresAt: number;
  lastDelayStepAt: number | null;
  outcome: 'would-restart' | 'would-roll' | 'would-hold' | null;
  rollBecause: DelayId | null;
}

export interface AgentAck {
  episodeId: string;
  generation: number;
  bootTime: number;
  state: 'draining' | 'ready';
  delaysClaimed: string[];
  yields: Record<string, number>;
  version: string;
  at: number;
}

/**
 * One row of the host restart ledger (`restarts.jsonl`). This slice writes only
 * `boot-observed`: one per OS boot, attributed to an episode once the actuator exists,
 * else `unattributed`, or `first-seen` for the first boot the ledger ever saw.
 */
export interface RestartLedgerRow {
  type: 'boot-observed';
  bootAt: number;
  previousBootAt: number | null;
  attribution: 'unattributed' | 'first-seen' | string;
  observedBy: string;
  at: number;
}

/** A boot time this close to the ledger's last is the same boot. */
const LEDGER_SAME_BOOT_MS = 60_000;

// ── Restart episodes (Part D "Host store and exclusive authority", "What uses up restart budget") ──

export type EpisodeKind = 'scheduled' | 'wedge' | 'operator' | 'lifeline';
export type EpisodeState =
  | 'reserved' | 'dispatched' | 'outcome-unknown'
  | 'aborted-unclaimed' | 'aborted' | 'rolled' | 'refused' | 'restarted' | 'left-running';
export type DispatchOutcome = 'unknown' | 'accepted' | 'refused';

/** One transition of one episode. The latest row of an episode is its state. */
export interface EpisodeRow {
  type: 'episode';
  episodeId: string;
  generation: number;
  kind: EpisodeKind;
  state: EpisodeState;
  /** The OS boot this episode was reserved on. A dispatch is only valid on this boot. */
  bootAt: number;
  expiresAt: number;
  at: number;
  by: string;
  rung?: 1 | 2;
  dispatch?: DispatchOutcome;
  reason?: string;
}

export type LedgerRow = RestartLedgerRow | EpisodeRow;

const TERMINAL: ReadonlySet<EpisodeState> = new Set(['aborted-unclaimed', 'aborted', 'rolled', 'refused', 'restarted', 'left-running']);
export const isTerminal = (s: EpisodeState): boolean => TERMINAL.has(s);
const AUTOMATIC: ReadonlySet<EpisodeKind> = new Set(['scheduled', 'wedge']);

const H = 60 * 60_000;
const D = 24 * H;
/** Brakes (Part E table). Constants: the spec fixes them; config cannot loosen them. */
export const BRAKES = {
  recentBootMs: 6 * H,
  wedgePer24h: 2,
  wedgePer7d: 3,
  scheduledPer5d: 1,
  abortsPer7d: 3,
} as const;

export type BrakeId =
  | 'episode-open' | 'outcome-unknown' | 'recent-boot' | 'wedge-24h' | 'wedge-7d' | 'scheduled-5d'
  | 'abort-brake' | 'proof-failed' | 'ledger-unreadable';

/** Latest row per episode, in first-seen order. */
export function episodesOf(rows: LedgerRow[]): Map<string, { first: EpisodeRow; latest: EpisodeRow; rows: EpisodeRow[] }> {
  const out = new Map<string, { first: EpisodeRow; latest: EpisodeRow; rows: EpisodeRow[] }>();
  for (const r of rows) {
    if (r.type !== 'episode') continue;
    const e = out.get(r.episodeId);
    if (e) { e.latest = r; e.rows.push(r); } else out.set(r.episodeId, { first: r, latest: r, rows: [r] });
  }
  return out;
}

/**
 * The brakes, pure. An automatic request is refused by any of them. An operator request
 * passes every brake except `recent-boot` (which needs `overrideRecentBoot`, the card's
 * second confirmation); it never passes S1, S2 or the off switch, which `claimRung` checks.
 */
export function checkBrakes(rows: LedgerRow[], input: { kind: EpisodeKind; now: number; bootAt: number; proofFailed?: boolean; overrideRecentBoot?: boolean }): BrakeId | null {
  const automatic = AUTOMATIC.has(input.kind);
  const eps = [...episodesOf(rows).values()];
  if (eps.some((e) => e.latest.state === 'outcome-unknown') && automatic) return 'outcome-unknown';
  if (automatic && eps.some((e) => !isTerminal(e.latest.state) && input.now < e.latest.expiresAt)) return 'episode-open';
  if (input.now - input.bootAt < BRAKES.recentBootMs && (automatic || !input.overrideRecentBoot)) return 'recent-boot';
  if (!automatic) return null;
  if (input.proofFailed) return 'proof-failed';
  const spent = (kind: EpisodeKind, windowMs: number) => eps.filter((e) => e.first.kind === kind && e.rows.some((r) => r.state === 'dispatched') && input.now - e.first.at < windowMs).length;
  if (input.kind === 'wedge' && spent('wedge', D) >= BRAKES.wedgePer24h) return 'wedge-24h';
  if (input.kind === 'wedge' && spent('wedge', 7 * D) >= BRAKES.wedgePer7d) return 'wedge-7d';
  if (input.kind === 'scheduled' && spent('scheduled', 5 * D) >= BRAKES.scheduledPer5d) return 'scheduled-5d';
  const aborts = eps.filter((e) => (e.latest.state === 'aborted' || e.latest.state === 'refused') && input.now - e.latest.at < 7 * D).length;
  if (aborts >= BRAKES.abortsPer7d) return 'abort-brake';
  return null;
}

export type ClaimResult =
  | { ok: true; row: EpisodeRow }
  | { ok: false; reason: 'no-episode' | 'terminal' | 'stale-generation' | 'expired' | 'wrong-boot' | 'rung-claimed' | 'rung1-not-dispatched' | 'lock-unavailable' | string };

export interface ReserveInput {
  openedBy: string;
  restartAt: number;
  windowEnd: number;
  final: boolean;
  /** The delay ceiling, added to T-0 for the record's expiry along with 15 minutes. */
  maxEpisodeDelayMinutes: number;
}

export function defaultHostMaintenanceDir(): string {
  return path.join(os.homedir(), '.instar', 'host-maintenance');
}

const AGENT_FILE = /^[A-Za-z0-9._-]{1,120}$/;

/** A maintainer heartbeat older than this lets a co-resident agent take over. */
export const WEDGE_MAINTAINER_STALE_MS = 10 * 60_000;

export interface WedgeMaintainerRecord { agent: string; heartbeatAt: number; generation: number }

export type WedgeMaintainerClaim =
  | { self: true; maintainer: string; generation: number; tookOver: boolean }
  | { self: false; maintainer: string; heartbeatAt: number }
  | null;

export type OperatorControlAction = 'skip' | 'unskip' | 'window' | 'window-reset';
export interface OperatorControlChange { at: number; by: string; action: OperatorControlAction; skipUntil: number | null; window: { start: string; end: string } | null }
export interface OperatorControls {
  skipUntil: number | null;
  window: { start: string; end: string } | null;
  /** The last changes, newest last: who, what and when. */
  history: OperatorControlChange[];
}
export const CONTROLS_HISTORY_KEPT = 20;

export class HostMaintenanceStore {
  private readonly dir: string;
  private readonly now: () => number;

  constructor(opts: { dir?: string; now?: () => number } = {}) {
    this.dir = opts.dir ?? defaultHostMaintenanceDir();
    this.now = opts.now ?? Date.now;
  }

  private get planPath(): string { return path.join(this.dir, 'plan.json'); }
  private get ackDir(): string { return path.join(this.dir, 'acks'); }

  /** Any agent, any time, no lock. Missing, malformed or expired reads as no record. */
  readPlan(): DrainRecord | null {
    const plan = this.readRaw();
    if (!plan || plan.state === 'closed' || this.now() >= plan.expiresAt) return null;
    return plan;
  }

  private readRaw(): DrainRecord | null {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.planPath, 'utf-8')) as DrainRecord;
      if (parsed?.watchOnly !== true || typeof parsed.episodeId !== 'string' || !Number.isFinite(parsed.expiresAt) || !Number.isFinite(parsed.generation)) return null;
      return parsed;
    } catch {
      // @silent-fallback-ok — an absent or unreadable record means no drain is open.
      return null;
    }
  }

  /** The last record of this episode, closed included. Lets an agent finish after another closed it. */
  readLatest(episodeId: string): DrainRecord | null {
    const plan = this.readRaw();
    return plan?.episodeId === episodeId ? plan : null;
  }

  /** Opens an episode, or joins the one already open. Null when the lock cannot be taken. */
  reserve(input: ReserveInput): { plan: DrainRecord; opened: boolean } | null {
    return this.withLock(() => {
      const open = this.readPlan();
      if (open) return { plan: open, opened: false };
      const prior = this.readRaw();
      const plan: DrainRecord = {
        watchOnly: true,
        episodeId: randomUUID(),
        generation: (prior?.generation ?? 0) + 1,
        openedBy: input.openedBy,
        state: 'reserved',
        restartAt: input.restartAt,
        originalRestartAt: input.restartAt,
        windowEnd: input.windowEnd,
        final: input.final,
        activeDelays: [],
        delayMinutesUsed: {},
        holds: [],
        until: input.restartAt + 20 * 60_000,
        expiresAt: input.restartAt + (input.maxEpisodeDelayMinutes + 15) * 60_000,
        lastDelayStepAt: null,
        outcome: null,
        rollBecause: null,
      };
      this.writePlan(plan);
      return { plan, opened: true };
    });
  }

  /** Changes the open record. Refused for another episode or a stale generation. */
  update(episodeId: string, generation: number, change: (plan: DrainRecord) => DrainRecord): DrainRecord | null {
    return this.withLock(() => {
      const plan = this.readPlan();
      if (!plan || plan.episodeId !== episodeId || plan.generation !== generation) return null;
      const next = { ...change(plan), watchOnly: true as const, episodeId, generation };
      this.writePlan(next);
      return next;
    });
  }

  writeAck(agent: string, ack: AgentAck): boolean {
    if (!AGENT_FILE.test(agent)) return false;
    try {
      fs.mkdirSync(this.ackDir, { recursive: true });
      atomicWriteFileSync(path.join(this.ackDir, `${agent}.json`), JSON.stringify(ack), { mode: 0o644, operation: 'HostMaintenanceStore.writeAck' });
      return true;
    } catch {
      // @silent-fallback-ok — a missing ack is what the census reports for this agent.
      return false;
    }
  }

  /** Acks for this exact episode and generation. An older file never satisfies a new record. */
  readAcks(episodeId: string, generation: number): Record<string, AgentAck> {
    const out: Record<string, AgentAck> = {};
    let names: string[];
    try { names = fs.readdirSync(this.ackDir); } catch { return out; }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      try {
        const ack = JSON.parse(fs.readFileSync(path.join(this.ackDir, name), 'utf-8')) as AgentAck;
        if (ack?.episodeId === episodeId && ack.generation === generation) out[name.slice(0, -'.json'.length)] = ack;
      } catch { /* @silent-fallback-ok — an unreadable ack counts as no ack */ }
    }
    return out;
  }

  private get wedgeMaintainerPath(): string { return path.join(this.dir, 'wedge-maintainer.json'); }
  private get wedgeStatePath(): string { return path.join(this.dir, 'wedge-state.json'); }

  /**
   * The wedge maintainer heartbeat. Holds or renews the role for `agent`, or takes it
   * over from a heartbeat older than 10 minutes. Null when the lock cannot be taken,
   * which the caller treats as "not the maintainer this tick".
   */
  claimWedgeMaintainer(agent: string): WedgeMaintainerClaim {
    if (!AGENT_FILE.test(agent)) return null;
    return this.withLock(() => {
      const now = this.now();
      const current = this.readJsonFile<WedgeMaintainerRecord>(this.wedgeMaintainerPath);
      const valid = current && typeof current.agent === 'string' && Number.isFinite(current.heartbeatAt) && Number.isFinite(current.generation);
      if (valid && current!.agent !== agent && now - current!.heartbeatAt <= WEDGE_MAINTAINER_STALE_MS) {
        return { self: false as const, maintainer: current!.agent, heartbeatAt: current!.heartbeatAt };
      }
      const tookOver = !valid || current!.agent !== agent;
      const generation = valid ? (tookOver ? current!.generation + 1 : current!.generation) : 1;
      atomicWriteFileSync(this.wedgeMaintainerPath, JSON.stringify({ agent, heartbeatAt: now, generation }), { mode: 0o644, operation: 'HostMaintenanceStore.claimWedgeMaintainer' });
      return { self: true as const, maintainer: agent, generation, tookOver };
    });
  }

  /** The maintainer's last published wedge state. Any agent, no lock. */
  readWedgeState<T>(): T | null {
    return this.readJsonFile<T>(this.wedgeStatePath);
  }

  /** Written only by the current maintainer generation; refused otherwise. */
  writeWedgeState(agent: string, generation: number, state: unknown): boolean {
    return this.withLock(() => {
      const current = this.readJsonFile<WedgeMaintainerRecord>(this.wedgeMaintainerPath);
      if (!current || current.agent !== agent || current.generation !== generation) return false;
      atomicWriteFileSync(this.wedgeStatePath, JSON.stringify(state), { mode: 0o644, operation: 'HostMaintenanceStore.writeWedgeState' });
      return true;
    }) === true;
  }

  private get controlsPath(): string { return path.join(this.dir, 'controls.json'); }

  /**
   * The owner's controls for this machine (Part F): Skip once and Change window. One record
   * per host, so every agent on the machine plans from the same answer. Missing or
   * malformed reads as no controls.
   */
  readControls(): OperatorControls | null {
    const raw = this.readJsonFile<OperatorControls>(this.controlsPath);
    if (!raw || typeof raw !== 'object') return null;
    const skipUntil = typeof raw.skipUntil === 'number' && Number.isFinite(raw.skipUntil) ? raw.skipUntil : null;
    const w = raw.window && typeof raw.window === 'object' && typeof raw.window.start === 'string' && typeof raw.window.end === 'string' ? { start: raw.window.start, end: raw.window.end } : null;
    const history = Array.isArray(raw.history) ? raw.history.slice(-CONTROLS_HISTORY_KEPT) : [];
    return { skipUntil, window: w, history };
  }

  /** Change the controls under the host lock. Null when the lock cannot be taken. */
  changeControls(by: string, action: OperatorControlAction, change: (c: OperatorControls) => OperatorControls): OperatorControls | null {
    return this.withLock(() => {
      const current = this.readControls() ?? { skipUntil: null, window: null, history: [] };
      const next = change({ ...current, history: [...current.history] });
      next.history = [...next.history, { at: this.now(), by, action, skipUntil: next.skipUntil, window: next.window }].slice(-CONTROLS_HISTORY_KEPT);
      atomicWriteFileSync(this.controlsPath, JSON.stringify(next, null, 2), { mode: 0o644, operation: 'HostMaintenanceStore.changeControls' });
      return next;
    });
  }

  private get restartsPath(): string { return path.join(this.dir, 'restarts.jsonl'); }

  /** The boot rows of the ledger, oldest first. A torn or foreign line is skipped. */
  readRestartRows(): RestartLedgerRow[] {
    return (this.readLedger() ?? []).filter((r): r is RestartLedgerRow => r.type === 'boot-observed');
  }

  /**
   * Every readable ledger row, oldest first; a torn line is skipped. Null when the file
   * exists but cannot be read at all: automatic restarts then fail closed.
   */
  readLedger(): LedgerRow[] | null {
    let raw: string;
    try { raw = fs.readFileSync(this.restartsPath, 'utf-8'); } catch (err) {
      return (err as NodeJS.ErrnoException)?.code === 'ENOENT' ? [] : null; // @silent-fallback-ok — absent is empty; unreadable is null (fail closed)
    }
    const rows: LedgerRow[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as LedgerRow;
        if (row?.type === 'boot-observed' && Number.isFinite(row.bootAt)) rows.push(row);
        else if (row?.type === 'episode' && typeof row.episodeId === 'string' && Number.isFinite(row.generation)) rows.push(row);
      } catch { /* @silent-fallback-ok — a torn line is skipped */ }
    }
    return rows;
  }

  private appendLedger(row: LedgerRow): void {
    fs.appendFileSync(this.restartsPath, JSON.stringify(row) + '\n', { mode: 0o644 });
    // fsync: the row must be on disk before anything it authorizes happens.
    try { const fd = fs.openSync(this.restartsPath, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } } catch { /* @silent-fallback-ok — append landed; fsync is best effort on odd filesystems */ }
  }

  /**
   * reserve(): the first write of every restart episode, under the host lock. Checks the
   * brakes, then either opens a new episode or, for an operator request, takes over the
   * open one with a new generation. An automatic request never joins with authority.
   */
  reserveEpisode(input: { kind: EpisodeKind; by: string; bootAt: number; ttlMs: number; proofFailed?: boolean; overrideRecentBoot?: boolean }):
    | { ok: true; episodeId: string; generation: number; tookOver: boolean }
    | { ok: false; brake: BrakeId | 'lock-unavailable' } {
    const r = this.withLock(() => {
      const now = this.now();
      const rows = this.readLedger();
      if (rows === null) {
        // Unreadable ledger: automatic refused; an operator sets the bad file aside and starts a new one.
        if (AUTOMATIC.has(input.kind)) return { ok: false as const, brake: 'ledger-unreadable' as const };
        try { fs.renameSync(this.restartsPath, `${this.restartsPath}.unreadable-${now}`); } catch { return { ok: false as const, brake: 'ledger-unreadable' as const }; }
      }
      const ledger = rows ?? [];
      const brake = checkBrakes(ledger, { kind: input.kind, now, bootAt: input.bootAt, proofFailed: input.proofFailed, overrideRecentBoot: input.overrideRecentBoot });
      if (brake) return { ok: false as const, brake };
      const open = [...episodesOf(ledger).values()].find((e) => !isTerminal(e.latest.state) && (now < e.latest.expiresAt || e.latest.state === 'outcome-unknown'));
      const episodeId = open ? open.first.episodeId : randomUUID();
      const generation = open ? open.latest.generation + 1 : 1;
      this.appendLedger({
        type: 'episode', episodeId, generation, kind: input.kind, state: open?.latest.state === 'outcome-unknown' ? 'outcome-unknown' : 'reserved',
        bootAt: input.bootAt, expiresAt: now + input.ttlMs, at: now, by: input.by,
      });
      return { ok: true as const, episodeId, generation, tookOver: !!open };
    });
    return r ?? { ok: false, brake: 'lock-unavailable' };
  }

  /**
   * claimRung: immediately before a privileged command. Under the host lock: the episode is
   * open, this generation is current, the plan has not expired, it was reserved on THIS boot,
   * and the rung is unclaimed; then `fresh()` re-reads the off switch and the safety holds
   * that no caller passes (S1, S2). Only then is the dispatch written as `unknown` and
   * `spawn()` called, still inside the lock, so a takeover serializes with dispatch.
   */
  claimRung(input: { episodeId: string; generation: number; rung: 1 | 2; currentBootAt: number; by: string; fresh: () => string | null; spawn: () => void }): ClaimResult {
    const r = this.withLock((): ClaimResult => {
      const now = this.now();
      const ep = episodesOf(this.readLedger() ?? []).get(input.episodeId);
      if (!ep) return { ok: false, reason: 'no-episode' };
      const latest = ep.latest;
      if (isTerminal(latest.state)) return { ok: false, reason: 'terminal' };
      if (latest.generation !== input.generation) return { ok: false, reason: 'stale-generation' };
      if (now >= latest.expiresAt && latest.state !== 'outcome-unknown') return { ok: false, reason: 'expired' };
      if (Math.abs(latest.bootAt - input.currentBootAt) > LEDGER_SAME_BOOT_MS) return { ok: false, reason: 'wrong-boot' };
      if (ep.rows.some((x) => x.state === 'dispatched' && x.rung === input.rung && x.generation === input.generation)) return { ok: false, reason: 'rung-claimed' };
      if (input.rung === 2) {
        const r1 = [...ep.rows].reverse().find((x) => x.rung === 1 && x.dispatch && x.dispatch !== 'refused');
        if (!r1) return { ok: false, reason: 'rung1-not-dispatched' };
      }
      const base = { type: 'episode' as const, episodeId: latest.episodeId, generation: latest.generation, kind: ep.first.kind, bootAt: latest.bootAt, expiresAt: latest.expiresAt, by: input.by };
      const refusal = input.fresh();
      if (refusal) {
        // Before rung 1 nothing was asked of the OS: abort. Before rung 2, rung 1 may still land.
        this.appendLedger({ ...base, state: input.rung === 1 ? 'aborted' : 'outcome-unknown', at: now, rung: input.rung, reason: refusal });
        return { ok: false, reason: refusal };
      }
      const row: EpisodeRow = { ...base, state: 'dispatched', at: now, rung: input.rung, dispatch: 'unknown' };
      this.appendLedger(row);
      input.spawn();
      return { ok: true, row };
    });
    return r ?? { ok: false, reason: 'lock-unavailable' };
  }

  /** The command's result. A refused rung 1 closes the episode; anything else stays open. */
  recordDispatch(input: { episodeId: string; generation: number; rung: 1 | 2; outcome: DispatchOutcome; by: string; reason?: string }): boolean {
    return this.withLock(() => {
      const ep = episodesOf(this.readLedger() ?? []).get(input.episodeId);
      if (!ep) return false;
      const l = ep.latest;
      const state: EpisodeState = input.outcome === 'refused' && input.rung === 1 ? 'refused' : l.state === 'outcome-unknown' ? 'outcome-unknown' : 'dispatched';
      this.appendLedger({ type: 'episode', episodeId: l.episodeId, generation: input.generation, kind: ep.first.kind, state, bootAt: l.bootAt, expiresAt: l.expiresAt, at: this.now(), by: input.by, rung: input.rung, dispatch: input.outcome, ...(input.reason ? { reason: input.reason } : {}) });
      return true;
    }) === true;
  }

  /** Closes or moves an open episode. Refused for a stale generation, so a stale controller cannot undo a takeover. */
  transitionEpisode(input: { episodeId: string; generation: number; state: EpisodeState; by: string; reason?: string }): boolean {
    return this.withLock(() => {
      const ep = episodesOf(this.readLedger() ?? []).get(input.episodeId);
      if (!ep || isTerminal(ep.latest.state) || ep.latest.generation !== input.generation) return false;
      const l = ep.latest;
      this.appendLedger({ type: 'episode', episodeId: l.episodeId, generation: l.generation, kind: ep.first.kind, state: input.state, bootAt: l.bootAt, expiresAt: l.expiresAt, at: this.now(), by: input.by, ...(input.reason ? { reason: input.reason } : {}) });
      return true;
    }) === true;
  }

  /**
   * Records this OS boot once, under the host lock, so co-resident agents never write it
   * twice. Returns the row for this boot (new or already there) and the boot before it.
   * Null when the lock cannot be taken this tick.
   */
  observeBoot(bootAt: number, agent: string): { row: RestartLedgerRow; previousBootAt: number | null; added: boolean } | null {
    return this.withLock(() => {
      const rows = this.readRestartRows();
      const last = rows[rows.length - 1] ?? null;
      if (last && Math.abs(last.bootAt - bootAt) <= LEDGER_SAME_BOOT_MS) {
        return { row: last, previousBootAt: last.previousBootAt, added: false };
      }
      // A boot after an episode dispatched on the previous boot is that episode's restart.
      const prevBoot = last?.bootAt ?? null;
      const ledger = this.readLedger() ?? [];
      const dispatched = prevBoot === null ? undefined : [...episodesOf(ledger).values()].find((e) =>
        !['aborted-unclaimed', 'aborted', 'rolled', 'refused', 'restarted', 'left-running'].includes(e.latest.state)
        && Math.abs(e.latest.bootAt - prevBoot) <= LEDGER_SAME_BOOT_MS
        && e.rows.some((x) => x.state === 'dispatched'));
      const row: RestartLedgerRow = {
        type: 'boot-observed',
        bootAt,
        previousBootAt: prevBoot,
        attribution: dispatched ? dispatched.first.episodeId : last ? 'unattributed' : 'first-seen',
        observedBy: agent,
        at: this.now(),
      };
      this.appendLedger(row);
      if (dispatched) {
        const l = dispatched.latest;
        this.appendLedger({ type: 'episode', episodeId: l.episodeId, generation: l.generation, kind: dispatched.first.kind, state: 'restarted', bootAt: l.bootAt, expiresAt: l.expiresAt, at: this.now(), by: agent });
      }
      return { row, previousBootAt: row.previousBootAt, added: true };
    });
  }

  private readJsonFile<T>(file: string): T | null {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
    } catch {
      // @silent-fallback-ok — an absent or unreadable host file reads as no record.
      return null;
    }
  }

  private writePlan(plan: DrainRecord): void {
    atomicWriteFileSync(this.planPath, JSON.stringify(plan, null, 2), { mode: 0o644, operation: 'HostMaintenanceStore.writePlan' });
  }

  private withLock<T>(fn: () => T): T | null {
    fs.mkdirSync(this.dir, { recursive: true });
    const lockPath = `${this.planPath}.lock`;
    // A server's tick runs here, so the wait stays short and sleeps rather than spins.
    const deadline = Date.now() + 200;
    for (;;) {
      const taken = tryTakeLockOnce(lockPath, JSON.stringify({ pid: process.pid, at: Date.now() }));
      if (taken.ok) {
        try { return fn(); } finally { releaseLock(lockPath, taken.fd, 'HostMaintenanceStore.withLock:release'); }
      }
      if (taken.reason !== 'held') return null;
      if (legacyPidDeathLockReclaim(lockPath, pidAlive)) continue;
      if (Date.now() >= deadline) return null;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
}
