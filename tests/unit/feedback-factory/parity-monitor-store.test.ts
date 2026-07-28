/**
 * Unit tests (Tier 1) — durable parity monitor (restart-survival of the cutover window).
 *
 * The Phase-3 zero-divergence window spans hours; a server restart mid-window must NOT
 * silently reset the streak. These tests prove the window survives a simulated restart, and
 * that the JSONL persistence round-trips + tolerates a torn final line.
 */

import { describe, it, expect } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync, mkdtempSync, readFileSync } from 'node:fs';
import {
  DurableParityMonitor,
  JsonlPassPersistence,
  type PassPersistence,
} from '../../../src/feedback-factory/monitor/parityMonitorStore.js';
import type { MonitorPass } from '../../../src/feedback-factory/monitor/parityMonitor.js';

/** In-memory persistence so the monitor logic is testable without disk. */
class MemPersistence implements PassPersistence {
  constructor(public rows: MonitorPass[] = []) {}
  load(): MonitorPass[] {
    return [...this.rows];
  }
  append(pass: MonitorPass): void {
    this.rows.push(pass);
  }
}

const clean = (at: string): MonitorPass => ({ at, clustersCompared: 10, divergences: 0, divergent: false });
const policy = { requiredCleanPasses: 3, minWindowMs: 60_000, minClustersObserved: 5 };

describe('DurableParityMonitor — restart survival', () => {
  it('reloads persisted passes on construction so the window survives a "restart"', () => {
    const store = new MemPersistence();
    // Instance A records a full clean window, then "the process dies".
    const a = new DurableParityMonitor(store, policy);
    a.record(clean('2026-06-05T00:00:00Z'));
    a.record(clean('2026-06-05T00:30:00Z'));
    a.record(clean('2026-06-05T01:00:00Z'));
    expect(a.gate('2026-06-05T01:30:00Z').cleared).toBe(true);

    // Instance B is a fresh construction over the SAME persistence (the restart).
    const b = new DurableParityMonitor(store, policy);
    expect(b.passes).toHaveLength(3);
    expect(b.gate('2026-06-05T01:30:00Z').cleared).toBe(true); // window survived
  });

  it('record() both persists and feeds the live monitor', () => {
    const store = new MemPersistence();
    const m = new DurableParityMonitor(store, policy);
    m.record(clean('2026-06-05T00:00:00Z'));
    expect(store.rows).toHaveLength(1); // persisted
    expect(m.passes).toHaveLength(1); // in-memory
  });

  it('a divergence persisted before a restart still resets the post-restart streak', () => {
    const store = new MemPersistence();
    const a = new DurableParityMonitor(store, policy);
    a.record(clean('2026-06-05T00:00:00Z'));
    a.record({ at: '2026-06-05T00:30:00Z', clustersCompared: 10, divergences: 1, divergent: true });
    // restart
    const b = new DurableParityMonitor(store, policy);
    b.record(clean('2026-06-05T01:00:00Z'));
    const g = b.gate('2026-06-05T02:00:00Z');
    expect(g.cleared).toBe(false); // only 1 clean pass since the persisted divergence
    expect(g.lastDivergentAt).toBe('2026-06-05T00:30:00Z');
  });
});

describe('JsonlPassPersistence', () => {
  const mkPath = () => join(mkdtempSync(join(tmpdir(), 'parity-')), 'passes.jsonl');

  it('round-trips passes through the JSONL file', () => {
    const p = mkPath();
    const persistence = new JsonlPassPersistence(p);
    persistence.append(clean('2026-06-05T00:00:00Z'));
    persistence.append({ at: '2026-06-05T00:30:00Z', clustersCompared: 5, divergences: 2, divergent: true });
    const loaded = new JsonlPassPersistence(p).load();
    expect(loaded).toHaveLength(2);
    expect(loaded[1].divergences).toBe(2);
  });

  it('returns [] for a missing file', () => {
    expect(new JsonlPassPersistence(join(tmpdir(), 'does-not-exist-parity.jsonl')).load()).toEqual([]);
  });

  it('skips a torn final line (crash mid-append) without losing prior passes', () => {
    const p = mkPath();
    writeFileSync(p, JSON.stringify(clean('2026-06-05T00:00:00Z')) + '\n' + '{"at":"2026-06-05T00:30:00Z","clusters'); // truncated
    const loaded = new JsonlPassPersistence(p).load();
    expect(loaded).toHaveLength(1); // the good line survives; the torn one is dropped
    expect(loaded[0].at).toBe('2026-06-05T00:00:00Z');
  });

  it('end-to-end: a DurableParityMonitor over a real JSONL survives restart', () => {
    const p = mkPath();
    const a = new DurableParityMonitor(new JsonlPassPersistence(p), policy);
    a.record(clean('2026-06-05T00:00:00Z'));
    a.record(clean('2026-06-05T00:30:00Z'));
    a.record(clean('2026-06-05T01:00:00Z'));
    // fresh monitor over the same on-disk file
    const b = new DurableParityMonitor(new JsonlPassPersistence(p), policy);
    expect(b.gate('2026-06-05T01:30:00Z').cleared).toBe(true);
    // the file holds exactly three lines
    expect(readFileSync(p, 'utf8').trim().split('\n')).toHaveLength(3);
  });
});
