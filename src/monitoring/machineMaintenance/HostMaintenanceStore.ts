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
