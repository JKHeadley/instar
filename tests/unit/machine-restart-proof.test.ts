/**
 * Restart record and post-restart proof (machine-self-maintenance Part D, CMT-1199 first slice).
 *
 * Both sides of each boundary: the host ledger writes one row per OS boot (never two for
 * jitter, never one for a server restart); the first boot ever seen proves nothing; a new
 * boot after a baseline is proven against that baseline, so breakage that predates the
 * restart does not fail it; an unread row is never a pass; five attempts bound the proof.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { HostMaintenanceStore } from '../../src/monitoring/machineMaintenance/HostMaintenanceStore.js';
import {
  BASELINE_EVERY_MS, PROOF_ATTEMPT_GAP_MS, PostRestartProof, runChecks, serverHealthFromResponse, type Baseline, type ProofReaders, type RestartProofRecord,
} from '../../src/monitoring/machineMaintenance/PostRestartProof.js';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

function healthyReaders(over: Partial<ProofReaders> = {}, state: { lifelineAt: number | null } = { lifelineAt: null }): ProofReaders {
  return {
    serverHealth: async () => ({ state: 'pass', reason: 'health-200' }),
    lifelineProofAt: () => state.lifelineAt,
    relay: async () => ({ state: 'pass', reason: 'relay-connected', connected: true }),
    tunnel: async () => ({ state: 'pass', reason: 'tunnel-200', configured: true }),
    desktop: async () => ({ ready: true, screenPermission: true }),
    signedOutLogins: async () => 0,
    coResidentAgents: async () => [{ name: 'sagemind', healthy: true }],
    ...over,
  };
}

describe('host restart ledger', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-ledger-')); });
  afterEach(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/machine-restart-proof.test.ts' }));

  it('first boot is first-seen; a later boot is unattributed with its predecessor; the same boot (jitter) is not written twice', () => {
    const store = new HostMaintenanceStore({ dir, now: () => 1 });
    const a = store.observeBoot(1_000_000, 'echo')!;
    expect(a).toMatchObject({ added: true, previousBootAt: null, row: { attribution: 'first-seen' } });
    expect(store.observeBoot(1_000_000 + 30_000, 'sagemind')!.added).toBe(false);
    const b = store.observeBoot(1_000_000 + 2 * DAY, 'sagemind')!;
    expect(b).toMatchObject({ added: true, previousBootAt: 1_000_000, row: { attribution: 'unattributed', observedBy: 'sagemind' } });
    expect(store.readRestartRows()).toHaveLength(2);
  });

  it('a torn line is skipped, not fatal', () => {
    const store = new HostMaintenanceStore({ dir, now: () => 1 });
    store.observeBoot(5_000_000, 'echo');
    fs.appendFileSync(path.join(dir, 'restarts.jsonl'), '{"type":"boot-obs');
    expect(store.readRestartRows()).toHaveLength(1);
  });
});

describe('runChecks against the baseline', () => {
  const proof = (over: Partial<RestartProofRecord> = {}): RestartProofRecord => ({
    bootAt: 10 * DAY, previousBootAt: 3 * DAY, attribution: 'unattributed', startedAt: 10 * DAY, finishedAt: null,
    attempts: 0, verdict: 'running', baselineAt: 9 * DAY, checks: {}, ...over,
  });
  const before = (over: Partial<Baseline> = {}): Baseline => ({
    bootAt: 3 * DAY, at: 9 * DAY, desktopReady: true, screenPermission: true, signedOutLogins: 1,
    tunnelConfigured: true, relayConnected: true, coResidentAgents: ['sagemind'], ...over,
  });

  it('all green when everything is back and the lifeline proved itself this boot', async () => {
    const c = await runChecks(healthyReaders({}, { lifelineAt: 10 * DAY + MIN }), proof(), before());
    expect(Object.values(c).every((x) => x.state === 'pass')).toBe(true);
  });

  it('a lifeline proof from before this boot does not count', async () => {
    const c = await runChecks(healthyReaders({}, { lifelineAt: 10 * DAY - MIN }), proof(), before());
    expect(c.lifeline).toMatchObject({ state: 'fail', reason: 'no-lifeline-proof-this-boot' });
  });

  it('desktop: not ready before the restart is not this restart\'s failure; ready before and not after is', async () => {
    const r = healthyReaders({ desktop: async () => ({ ready: false, screenPermission: false }) });
    expect((await runChecks(r, proof(), before({ desktopReady: false }))).desktop).toMatchObject({ state: 'not-applicable' });
    expect((await runChecks(r, proof(), before())).desktop).toMatchObject({ state: 'fail', reason: 'desktop-ready-before-not-after' });
  });

  it('desktop: losing screen permission across the restart fails even if the helper says ready', async () => {
    const r = healthyReaders({ desktop: async () => ({ ready: true, screenPermission: false }) });
    expect((await runChecks(r, proof(), before())).desktop).toMatchObject({ state: 'fail', reason: 'screen-permission-lost' });
  });

  it('logins: no worse than before passes, more signed out fails, unread is unknown', async () => {
    expect((await runChecks(healthyReaders({ signedOutLogins: async () => 1 }), proof(), before())).logins?.state).toBe('pass');
    expect((await runChecks(healthyReaders({ signedOutLogins: async () => 2 }), proof(), before())).logins?.state).toBe('fail');
    expect((await runChecks(healthyReaders({ signedOutLogins: async () => null }), proof(), before())).logins?.state).toBe('unknown');
  });

  it('co-resident agents: one healthy before and missing after fails, naming it', async () => {
    const r = healthyReaders({ coResidentAgents: async () => [{ name: 'sagemind', healthy: false }] });
    expect((await runChecks(r, proof(), before())).coResidentAgents).toMatchObject({ state: 'fail', detail: { missing: 'sagemind' } });
  });

  it('a reader that throws is unknown, never a pass', async () => {
    const r = healthyReaders({ relay: async () => { throw new Error('x'); } });
    expect((await runChecks(r, proof(), before())).relay).toMatchObject({ state: 'unknown' });
  });
});

describe('PostRestartProof lifecycle', () => {
  let dir: string;
  let clock: number;
  let bootAt: number;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-proof-')); clock = 100 * DAY; bootAt = 90 * DAY; });
  afterEach(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/machine-restart-proof.test.ts' }));

  function make(readers: ProofReaders, over: { maintainer?: boolean } = {}): PostRestartProof {
    return new PostRestartProof({
      agentName: 'echo',
      store: new HostMaintenanceStore({ dir: path.join(dir, 'host'), now: () => clock }),
      readBootAt: async () => bootAt,
      isMaintainer: () => over.maintainer ?? true,
      readers,
      baselinePath: path.join(dir, 'state', 'restart-baseline.json'),
      proofPath: path.join(dir, 'state', 'restart-proof.json'),
      logPath: path.join(dir, 'logs', 'mm.jsonl'),
      enabled: () => true,
      now: () => clock,
    });
  }

  it('first boot seen: no proof, then a baseline; after a real reboot the proof passes against it', async () => {
    const lifeline = { lifelineAt: null as number | null };
    const p = make(healthyReaders({}, lifeline));
    await p.tick();
    let st = p.status() as any;
    expect(st.lastProof).toMatchObject({ verdict: 'no-baseline', attribution: 'first-seen' });
    expect(st.baselineAt).toBe(clock);

    // A server restart on the same boot does nothing new.
    const again = make(healthyReaders({}, lifeline));
    await again.tick();
    expect((again.status() as any).lastProof.verdict).toBe('no-baseline');

    // The machine reboots.
    clock += 2 * DAY; bootAt = clock - 3 * MIN; lifeline.lifelineAt = clock - MIN;
    const after = make(healthyReaders({}, lifeline));
    await after.tick();
    st = after.status() as any;
    expect(st.lastProof).toMatchObject({ verdict: 'passed', attribution: 'unattributed', previousBootAt: 90 * DAY, attempts: 1 });
    expect(st.unattributedLast7Days).toBe(1);
    const log = fs.readFileSync(path.join(dir, 'logs', 'mm.jsonl'), 'utf-8');
    expect(log).toMatch(/"type":"boot-observed"/);
    expect(log).toMatch(/"type":"restart-proof".*"verdict":"passed"/);
  });

  it('a check still failing after five attempts fails the proof with its name; a fix before then passes', async () => {
    const p0 = make(healthyReaders());
    await p0.tick();
    clock += 2 * DAY; bootAt = clock;
    let tunnelUp = false;
    const lifeline = { lifelineAt: clock };
    const p = make(healthyReaders({ tunnel: async () => (tunnelUp ? { state: 'pass', reason: 'tunnel-200', configured: true } : { state: 'fail', reason: 'tunnel-unreachable', configured: true }) }, lifeline));
    await p.tick();
    expect((p.status() as any).lastProof).toMatchObject({ verdict: 'running', attempts: 1 });
    clock += PROOF_ATTEMPT_GAP_MS; await p.tick();
    tunnelUp = true;
    clock += PROOF_ATTEMPT_GAP_MS; await p.tick();
    expect((p.status() as any).lastProof).toMatchObject({ verdict: 'passed', attempts: 3 });

    // Next reboot, the tunnel never comes back.
    clock += BASELINE_EVERY_MS; await p.tick();
    clock += 2 * DAY; bootAt = clock; lifeline.lifelineAt = clock; tunnelUp = false;
    for (let i = 0; i < 6; i++) { await p.tick(); clock += PROOF_ATTEMPT_GAP_MS; }
    expect((p.status() as any).lastProof).toMatchObject({ verdict: 'failed', attempts: 5 });
    expect((p.status() as any).lastProof.checks.tunnel.state).toBe('fail');
  });

  it('a non-maintainer agent proves its own parts but writes no host ledger row', async () => {
    const p = make(healthyReaders(), { maintainer: false });
    await p.tick();
    expect(fs.existsSync(path.join(dir, 'host', 'restarts.jsonl'))).toBe(false);
  });

  it('disabled: reads nothing and writes nothing', async () => {
    const p = new PostRestartProof({
      agentName: 'echo', store: new HostMaintenanceStore({ dir: path.join(dir, 'host') }), readBootAt: async () => { throw new Error('must not read'); },
      isMaintainer: () => true, readers: healthyReaders(), baselinePath: path.join(dir, 'b.json'), proofPath: path.join(dir, 'p.json'),
      logPath: path.join(dir, 'l.jsonl'), enabled: () => false,
    });
    await p.tick();
    expect(fs.existsSync(path.join(dir, 'p.json'))).toBe(false);
  });
});

describe('server row: back only when /health says it finished starting', () => {
  const hdr = (v: string | null) => ({ get: (n: string) => (n === 'x-instar-boot-state' ? v : null) });
  it('200 with bootReadiness ready passes', () => {
    expect(serverHealthFromResponse({ status: 200, headers: hdr(null), body: { bootReadiness: { state: 'ready' } } })).toEqual({ state: 'pass', reason: 'health-200-ready' });
  });
  it('the boot beacon 503 and a 200 still starting are unknown, read again next attempt', () => {
    expect(serverHealthFromResponse({ status: 503, headers: hdr('starting'), body: {} })).toEqual({ state: 'unknown', reason: 'server-still-starting' });
    expect(serverHealthFromResponse({ status: 200, headers: hdr(null), body: { bootReadiness: { state: 'starting' } } }).state).toBe('unknown');
    expect(serverHealthFromResponse({ status: 200, headers: hdr(null), body: {} })).toEqual({ state: 'unknown', reason: 'boot-state-unread' });
  });
  it('any other 503, another status or no answer fails', () => {
    expect(serverHealthFromResponse({ status: 503, headers: hdr(null), body: {} })).toEqual({ state: 'fail', reason: 'health-503' });
    expect(serverHealthFromResponse({ status: 500, body: null })).toEqual({ state: 'fail', reason: 'health-500' });
    expect(serverHealthFromResponse(null)).toEqual({ state: 'fail', reason: 'health-unreachable' });
  });
  it('in the proof: still starting keeps it running, ready then passes; still starting at the bound fails', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-proof-boot-'));
    try {
      let clock = 100 * DAY; let bootAt = 90 * DAY; let ready = false;
      const lifeline = { lifelineAt: null as number | null };
      const readers = healthyReaders({ serverHealth: async () => serverHealthFromResponse(ready
        ? { status: 200, headers: hdr(null), body: { bootReadiness: { state: 'ready' } } }
        : { status: 503, headers: hdr('starting'), body: {} }) }, lifeline);
      const p = new PostRestartProof({
        agentName: 'echo', store: new HostMaintenanceStore({ dir: path.join(dir, 'host'), now: () => clock }), readBootAt: async () => bootAt,
        isMaintainer: () => true, readers, baselinePath: path.join(dir, 'b.json'), proofPath: path.join(dir, 'p.json'),
        logPath: path.join(dir, 'l.jsonl'), enabled: () => true, now: () => clock,
      });
      ready = true; await p.tick(); ready = false;
      clock += 2 * DAY; bootAt = clock; lifeline.lifelineAt = clock;
      await p.tick();
      expect((p.status() as any).lastProof).toMatchObject({ verdict: 'running', attempts: 1 });
      expect((p.status() as any).lastProof.checks.server).toEqual({ state: 'unknown', reason: 'server-still-starting' });
      ready = true; clock += PROOF_ATTEMPT_GAP_MS; await p.tick();
      expect((p.status() as any).lastProof).toMatchObject({ verdict: 'passed', attempts: 2 });

      clock += BASELINE_EVERY_MS; await p.tick();
      ready = false; clock += 2 * DAY; bootAt = clock; lifeline.lifelineAt = clock;
      for (let i = 0; i < 6; i++) { await p.tick(); clock += PROOF_ATTEMPT_GAP_MS; }
      expect((p.status() as any).lastProof).toMatchObject({ verdict: 'failed', attempts: 5 });
      expect((p.status() as any).lastProof.checks.server.reason).toBe('server-still-starting');
    } finally { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/machine-restart-proof.test.ts' }); }
  });
});
