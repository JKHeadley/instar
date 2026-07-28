/**
 * parityMonitorStore.ts — durable persistence for the Phase-3 parity monitor.
 *
 * The zero-divergence window that gates cutover spans HOURS of real dual-forward traffic.
 * If the monitor's passes lived only in memory, a server restart mid-window would silently
 * reset the streak — at best re-blocking cutover (conservative, survivable), at worst making
 * the gate's `windowMs` meaningless across the very restart it must survive. So passes are
 * appended to a JSONL and reloaded on construction: the window is durable across restarts.
 *
 * Append-only JSONL (one MonitorPass per line) matches Instar's file-based-state convention
 * and is crash-safe (a torn final line is skipped on reload, never corrupting the rest).
 * The pure ParityMonitor stays the gate brain; this is the I/O shell around it.
 */

import { appendFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { ParityMonitor, type CutoverGatePolicy, type CutoverGateStatus, type MonitorPass } from './parityMonitor.js';
import type { ParityResult } from '../processor/parity.js';

/** Injectable I/O so unit tests can drive the durable layer without touching disk. */
export interface PassPersistence {
  /** Load all previously-recorded passes, oldest-first. */
  load(): MonitorPass[];
  /** Durably append one pass. */
  append(pass: MonitorPass): void;
}

/** The default JSONL-on-disk persistence (append-only, torn-line tolerant). */
export class JsonlPassPersistence implements PassPersistence {
  constructor(private readonly path: string) {}

  load(): MonitorPass[] {
    if (!existsSync(this.path)) return [];
    const out: MonitorPass[] = [];
    const lines = readFileSync(this.path, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const p = JSON.parse(trimmed) as MonitorPass;
        // Defensive: only accept well-formed pass records.
        if (typeof p.at === 'string' && typeof p.clustersCompared === 'number' && typeof p.divergences === 'number') {
          out.push({ at: p.at, clustersCompared: p.clustersCompared, divergences: p.divergences, divergent: !!p.divergent });
        }
      } catch {
        // A torn final line (crash mid-append) is skipped, never corrupting the prior window.
        // @silent-fallback-ok — durability is best-effort-forward; a bad line is dropped, loudly recoverable.
      }
    }
    return out;
  }

  append(pass: MonitorPass): void {
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, JSON.stringify(pass) + '\n');
  }
}

/**
 * A ParityMonitor whose passes survive a restart. Reloads persisted passes on construction,
 * then every record() both persists and feeds the in-memory monitor. gate() delegates to the
 * monitor over the full (reloaded + new) history.
 */
export class DurableParityMonitor {
  private readonly monitor: ParityMonitor;
  private readonly persistence: PassPersistence;

  constructor(persistence: PassPersistence, policy: Partial<CutoverGatePolicy> = {}) {
    this.persistence = persistence;
    this.monitor = new ParityMonitor(policy);
    for (const p of persistence.load()) this.monitor.record(p);
  }

  record(pass: MonitorPass): void {
    this.persistence.append(pass);
    this.monitor.record(pass);
  }

  recordResult(result: ParityResult, at: string): void {
    const divergences = result.fingerprintDivergences.length + result.outcomeDivergences.length;
    this.record({ at, clustersCompared: result.clustersCompared, divergences, divergent: divergences > 0 });
  }

  gate(now: string): CutoverGateStatus {
    return this.monitor.gate(now);
  }

  get passes(): readonly MonitorPass[] {
    return this.monitor.passes;
  }
}
