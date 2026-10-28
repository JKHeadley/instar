/**
 * CMT-1119 — durable per-run records for two load-bearing dry-run guards, plus
 * synthetic scenarios so a soak can produce evidence on a machine where the
 * real condition never occurs:
 *   - U4.4 lease hand-back: the lease held by a NON-preferred machine
 *     (the case the preferred captain itself never sees).
 *   - Identity divergence monitor: an injected equal-epoch divergence.
 * The records land in a real JSONL file through the real bounded writer.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LeaseHandbackReconciler,
  DEFAULT_LEASE_HANDBACK_CONFIG,
  type LeaseHandbackConfig,
  type LeaseHandbackDeps,
  type LeaseHandbackRunRecord,
} from '../../src/core/LeaseHandbackReconciler.js';
import { IdentityDivergenceMonitor, type IdentityDivergenceRunRecord } from '../../src/core/IdentityDivergenceMonitor.js';
import type { IdentityProjection } from '../../src/core/IdentityStore.js';
import { appendGuardEvidence } from '../../src/core/guardEvidenceLog.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'guard-evidence-records-cmt1119.test:cleanup' });
  }
});
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-evidence-'));
  roots.push(dir);
  return dir;
}
function readJsonl<T>(file: string): T[] {
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as T);
}

function handback(opts: { self: string; preferred: string; holds: boolean; cfg?: Partial<LeaseHandbackConfig>; log: string }) {
  let wall = 1_000_000;
  let mono = 50_000;
  let holds = opts.holds;
  const config: LeaseHandbackConfig = { ...DEFAULT_LEASE_HANDBACK_CONFIG, enabled: true, dryRun: true, healthWindowMs: 60_000, ...opts.cfg };
  const deps: LeaseHandbackDeps = {
    config: () => config,
    selfMachineId: () => opts.self,
    preferredAwakeMachineId: () => opts.preferred,
    holdsLease: () => holds,
    currentEpoch: () => 7,
    preferredHealth: () => ({ heartbeatFresh: true, ropeReachable: true, leaseEligible: true, quotaOk: true }),
    cleanBoundary: () => ({ inFlightForwards: false, queuedInbound: 0, msSinceLastIngress: null }),
    kickInboundDrain: () => {},
    splitBrainActive: () => false,
    churnLatched: () => false,
    recordChurnFlip: () => {},
    operatorLatchUntilMs: () => null,
    mintConsentToken: () => null,
    sendOffer: async () => 'timeout',
    metric: () => {},
    notify: () => {},
    now: () => wall,
    monotonicNow: () => mono,
    record: (row) => { appendGuardEvidence(opts.log, row); },
  };
  const r = new LeaseHandbackReconciler(deps);
  return {
    r,
    advance(ms: number) { wall += ms; mono += ms; },
    setHolds(v: boolean) { holds = v; },
  };
}

describe('CMT-1119 lease hand-back durable records', () => {
  it('synthetic: lease held by a non-preferred machine produces a dated dry-run would-hand-back trail', () => {
    const log = path.join(tmp(), 'logs', 'lease-handback.jsonl');
    const h = handback({ self: 'm_standby', preferred: 'm_captain', holds: true, log });
    h.r.observe(); // window opens
    h.advance(61_000);
    h.r.observe(); // armed → dry-run would-hand-back
    h.advance(5_000);
    h.r.observe(); // unchanged state: no new record (no per-tick noise)
    const rows = readJsonl<LeaseHandbackRunRecord>(log);
    expect(rows.map((r) => r.kind)).toEqual(['transition', 'event', 'transition']);
    expect(rows[0]).toMatchObject({ state: 'window-open', prevState: 'inactive', dryRun: true, self: 'm_standby', preferred: 'm_captain' });
    expect(rows[1]).toMatchObject({ kind: 'event', event: 'would-hand-back' });
    expect(rows[1].lastEpisode?.outcome).toBe('would-hand-back (dry-run)');
    expect(rows[2]).toMatchObject({ state: 'armed', prevState: 'window-open' });
    expect(rows[2].counters['would-hand-back']).toBe(1);
    // Runtime proof of life for GET /guards.
    expect(h.r.guardStatus()).toMatchObject({ enabled: true, dryRun: true });
    expect(h.r.guardStatus().lastTickAt).toBeGreaterThan(0);
  });

  it('the preferred captain itself still leaves a record, then an hourly heartbeat — never one per tick', () => {
    const log = path.join(tmp(), 'lease-handback.jsonl');
    const h = handback({ self: 'm_captain', preferred: 'm_captain', holds: true, log });
    h.r.observe();
    for (let i = 0; i < 100; i++) { h.advance(5_000); h.r.observe(); } // ~8 min
    expect(readJsonl<LeaseHandbackRunRecord>(log)).toHaveLength(1);
    h.advance(3_600_000);
    h.r.observe();
    const rows = readJsonl<LeaseHandbackRunRecord>(log);
    expect(rows.map((r) => [r.kind, r.state])).toEqual([['transition', 'self-is-preferred'], ['heartbeat', 'self-is-preferred']]);
  });

  it('writes nothing while the feature is disabled', () => {
    const log = path.join(tmp(), 'lease-handback.jsonl');
    const h = handback({ self: 'm_standby', preferred: 'm_captain', holds: true, log, cfg: { enabled: false } });
    h.r.observe();
    h.advance(7_200_000);
    h.r.observe();
    expect(fs.existsSync(log)).toBe(false);
    expect(h.r.guardStatus().enabled).toBe(false);
  });

  it('a throwing record sink never changes the lease decision', () => {
    const h = handback({ self: 'm_standby', preferred: 'm_captain', holds: true, log: '/dev/null/x' });
    const r = new LeaseHandbackReconciler({
      ...(h.r as unknown as { d: LeaseHandbackDeps }).d,
      record: () => { throw new Error('disk full'); },
    });
    expect(() => r.observe()).not.toThrow();
    expect(r.status().state).toBe('window-open');
  });
});

function projection(over: Partial<IdentityProjection> = {}): IdentityProjection {
  return {
    machineId: 'target', keyEpoch: 2, signingFingerprint: 'sign-a',
    recoveryEpoch: 1, recoveryFingerprint: 'recover-a', registryStatus: 'active', ...over,
  };
}

describe('CMT-1119 identity divergence monitor durable records', () => {
  it('records every completed check, including clean ones, with sources and machine counts', async () => {
    const dir = tmp();
    const log = path.join(dir, 'logs', 'identity-divergence-monitor.jsonl');
    const monitor = new IdentityDivergenceMonitor({
      stateDir: dir,
      readViews: async () => [
        { sourceMachineId: 'a', projections: [projection(), projection({ machineId: 'other' })] },
        { sourceMachineId: 'b', projections: [projection()] },
      ],
      raise: () => 'dry-run',
      now: () => Date.parse('2026-10-28T12:00:00Z'),
      record: (row) => { appendGuardEvidence(log, row); },
    });
    expect(monitor.guardStatus(true).lastTickAt).toBe(0);
    await monitor.tick();
    const [row] = readJsonl<IdentityDivergenceRunRecord>(log);
    expect(row).toEqual({
      at: '2026-10-28T12:00:00.000Z', sourcesRead: 2, sources: ['a', 'b'], machinesCompared: 2,
      active: [], raised: [], cleared: [],
    });
    expect(monitor.guardStatus(true)).toEqual({ enabled: true, dryRun: true, lastTickAt: Date.parse('2026-10-28T12:00:00Z') });
  });

  it('synthetic: an injected equal-epoch divergence is recorded with its dry-run disposition once, then cleared', async () => {
    const dir = tmp();
    const log = path.join(dir, 'identity-divergence-monitor.jsonl');
    let diverged = true;
    const monitor = new IdentityDivergenceMonitor({
      stateDir: dir,
      readViews: async () => [
        { sourceMachineId: 'a', projections: [projection()] },
        { sourceMachineId: 'b', projections: [projection({ signingFingerprint: diverged ? 'sign-b' : 'sign-a' })] },
      ],
      raise: () => 'dry-run',
      record: (row) => { appendGuardEvidence(log, row); },
    });
    await monitor.tick();
    await monitor.tick();
    diverged = false;
    await monitor.tick();
    const rows = readJsonl<IdentityDivergenceRunRecord>(log);
    const id = 'identity-divergence:signing:target:2';
    expect(rows.map((r) => [r.active, r.raised, r.cleared])).toEqual([
      [[id], [{ id, disposition: 'dry-run' }], []],
      [[id], [], []],
      [[], [], [id]],
    ]);
  });

  it('a raise with no disposition is recorded as raised', async () => {
    const dir = tmp();
    const rows: IdentityDivergenceRunRecord[] = [];
    const monitor = new IdentityDivergenceMonitor({
      stateDir: dir,
      readViews: async () => [
        { sourceMachineId: 'a', projections: [projection()] },
        { sourceMachineId: 'b', projections: [projection({ recoveryFingerprint: 'recover-b' })] },
      ],
      raise: () => {},
      record: (row) => { rows.push(row); },
    });
    await monitor.tick();
    expect(rows[0].raised).toEqual([{ id: 'identity-divergence:recovery:target:1', disposition: 'raised' }]);
  });
});

describe('CMT-1119 bounded evidence writer', () => {
  it('rotates past maxBytes to a single .1 file and never throws on an unwritable path', () => {
    const log = path.join(tmp(), 'x.jsonl');
    for (let i = 0; i < 20; i++) appendGuardEvidence(log, { i, pad: 'x'.repeat(50) }, { maxBytes: 300 });
    expect(fs.statSync(log).size).toBeLessThan(400);
    expect(fs.existsSync(`${log}.1`)).toBe(true);
    const errors: unknown[] = [];
    expect(appendGuardEvidence('/dev/null/nope/x.jsonl', { a: 1 }, { onError: (e) => errors.push(e) })).toBe(false);
    expect(errors).toHaveLength(1);
  });
});

describe('CMT-1119 server wiring', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../src/commands/server.ts'), 'utf8');
  it('the hand-back reconciler gets a durable record sink and a /guards runtime getter', () => {
    expect(src).toMatch(/record: \(row\) => \{\s*appendGuardEvidence\(path\.join\(config\.stateDir, '\.\.', 'logs', 'lease-handback\.jsonl'\), row\);/);
    expect(src).toMatch(/guardRegistry\.register\('multiMachine\.leaseSelfHeal\.preferredCaptainHandback\.enabled', \(\) =>\s*_leaseHandbackReconciler\?\.guardStatus\(\)/);
  });
  it('the identity divergence monitor gets a durable record sink, a dry-run disposition and a /guards runtime getter', () => {
    expect(src).toMatch(/appendGuardEvidence\(path\.join\(config\.stateDir, '\.\.', 'logs', 'identity-divergence-monitor\.jsonl'\), row\)/);
    expect(src).toMatch(/dry-run would raise \$\{event\.id\}`\);\s*return 'dry-run';/);
    expect(src).toMatch(/guardRegistry\.register\('multiMachine\.identityReannounce\.identityDivergenceMonitor', \(\) =>\s*identityDivergenceMonitor\.guardStatus\(/);
  });
});
