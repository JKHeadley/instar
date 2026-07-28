/**
 * WS3 one-voice — integration points beyond the SpeakerElection module itself
 * (MULTI-MACHINE-SEAMLESSNESS-SPEC; election decision-table tests live in
 * SpeakerElection.test.ts):
 *
 *  1. CommitmentTracker stamps ownerMachineId at creation (closes F19's
 *     silently-inert gate: the field was caller-supplied-only and never set).
 *  2. PromiseBeacon's gate consults the election with live re-resolution and
 *     the stamp as fallback; silent verdicts re-arm instead of dropping.
 *  3. PresenceProxy's sendProxyMessage is gated (closes F18: it previously
 *     had NO machine-ownership filter at all).
 *  4. PostUpdateMigrator backfills existing open commitments (P3 Migration
 *     Parity — the gate flips from inert to enforcing for deployed agents).
 *  5. Single-machine strict no-op: with no pool, behavior is byte-identical.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CommitmentTracker } from '../../src/monitoring/CommitmentTracker.js';
import { SpeakerElection } from '../../src/monitoring/SpeakerElection.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

function tmpState(): string {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws3-test-'));
  fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ projectName: 'ws3-test' }));
  cleanups.push(() => SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'tests/unit/ws3-one-voice-wiring.test.ts' }));
  return stateDir;
}

describe('WS3.2 — CommitmentTracker stamps ownerMachineId at creation', () => {
  it('defaults ownerMachineId to the creating machine (originMachineId)', () => {
    const stateDir = tmpState();
    const tracker = new CommitmentTracker({ stateDir, originMachineId: 'm_creator' });
    const c = tracker.record({
      userRequest: 'test', agentResponse: 'will do', type: 'one-time-action', topicId: 42,
    });
    expect(c.ownerMachineId).toBe('m_creator');
    expect(c.originMachineId).toBe('m_creator');
  });

  it('an explicit caller-supplied owner still wins', () => {
    const stateDir = tmpState();
    const tracker = new CommitmentTracker({ stateDir, originMachineId: 'm_creator' });
    const c = tracker.record({
      userRequest: 'test', agentResponse: 'will do', type: 'one-time-action', topicId: 42,
      ownerMachineId: 'm_other',
    });
    expect(c.ownerMachineId).toBe('m_other');
  });

  it('no originMachineId configured (single-machine legacy) → field stays absent, gate stays inert', () => {
    const stateDir = tmpState();
    const tracker = new CommitmentTracker({ stateDir });
    const c = tracker.record({
      userRequest: 'test', agentResponse: 'will do', type: 'one-time-action', topicId: 42,
    });
    expect(c.ownerMachineId).toBeUndefined();
  });
});

describe('WS3 — sentinel gate wiring (source-level seams)', () => {
  const beaconSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'monitoring', 'PromiseBeacon.ts'), 'utf-8');
  const proxySrc = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'monitoring', 'PresenceProxy.ts'), 'utf-8');
  const serverSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'commands', 'server.ts'), 'utf-8');

  it('PromiseBeacon consults the election with the stamp as FALLBACK (live re-resolution first)', () => {
    expect(beaconSrc).toMatch(/speakerElection\.decide\(c\.topicId, c\.ownerMachineId \?\? null\)/);
    // Silent verdicts re-arm (schedule), never drop the commitment.
    const gate = beaconSrc.match(/speakerElection\.decide[\s\S]{0,200}/)![0];
    expect(gate).toContain('this.schedule(c)');
  });

  it('PromiseBeacon keeps the legacy static gate when no election is wired (back-compat)', () => {
    expect(beaconSrc).toMatch(/else if \(this\.config\.currentMachineId && c\.ownerMachineId && c\.ownerMachineId !== this\.config\.currentMachineId\)/);
  });

  it('PresenceProxy gates at the single send chokepoint (sendProxyMessage)', () => {
    const fn = proxySrc.match(/private async sendProxyMessage\([\s\S]{0,800}/)![0];
    expect(fn).toContain('speakerElection.decide(topicId)');
    expect(fn).toContain('if (!verdict.speak)');
  });

  it('server wires ONE shared election into BOTH sentinels', () => {
    expect(serverSrc).toMatch(/const speakerElection = new SpeakerElection\(/);
    const proxyCfg = serverSrc.match(/presenceProxy = new PresenceProxy\(\{[\s\S]{0,400}/)![0];
    expect(proxyCfg).toContain('speakerElection');
    const beaconCfg = serverSrc.match(/const promiseBeacon = new PromiseBeacon\(\{[\s\S]{0,500}/)![0];
    expect(beaconCfg).toContain('speakerElection');
  });

  it('the election reads ONLY local replicated state for ownership (no mesh call on the hot path)', () => {
    const bind = serverSrc.match(/ws3PoolDeps = \{[\s\S]{0,900}/)![0];
    expect(bind).toContain('ownReg.read(String(topicId))');
    expect(bind).not.toMatch(/meshRpc|fetch\(/);
  });
});

describe('WS3 — single-machine strict no-op (spec invariant 6)', () => {
  it('beacon-style decide with an unbound pool returns speak (legacy), election machinery not engaged', () => {
    // Mirrors the server boot window before ws3PoolDeps binds AND the
    // permanent state of a single-machine agent.
    const election = new SpeakerElection({
      enabled: () => true,
      currentMachineId: 'm_self',
      poolMachineIds: () => [],
      resolveTopicOwner: () => { throw new Error('must not be called for an empty pool'); },
      leaseHolderId: () => { throw new Error('must not be called for an empty pool'); },
      leaseStable: () => { throw new Error('must not be called for an empty pool'); },
    });
    expect(election.decide(7)).toMatchObject({ speak: true, reason: 'single-machine' });
  });
});

describe('WS3.2 — PostUpdateMigrator commitment owner backfill', () => {
  async function runMigration(stateDir: string) {
    const { PostUpdateMigrator } = await import('../../src/core/PostUpdateMigrator.js');
    const m = new PostUpdateMigrator({ stateDir } as ConstructorParameters<typeof PostUpdateMigrator>[0]);
    return (m as unknown as { migrateCommitmentOwnerBackfill: (r: { upgraded: string[]; skipped: string[]; errors: string[] }) => void });
  }

  function seed(stateDir: string, opts: { identity?: boolean; commitments?: Array<Record<string, unknown>> }) {
    if (opts.identity) {
      fs.mkdirSync(path.join(stateDir, 'machine'), { recursive: true });
      fs.writeFileSync(path.join(stateDir, 'machine', 'identity.json'), JSON.stringify({ machineId: 'm_backfill' }));
    }
    if (opts.commitments) {
      fs.writeFileSync(
        path.join(stateDir, 'state', 'commitments.json'),
        JSON.stringify({ version: 1, commitments: opts.commitments }),
      );
    }
  }

  it('stamps open commitments lacking an owner; leaves terminal + already-stamped records alone; idempotent', async () => {
    const stateDir = tmpState();
    seed(stateDir, {
      identity: true,
      commitments: [
        { id: 'CMT-1', status: 'pending' },
        { id: 'CMT-2', status: 'pending', ownerMachineId: 'm_existing' },
        { id: 'CMT-3', status: 'delivered' },
      ],
    });
    const mig = await runMigration(stateDir);
    const r1 = { upgraded: [], skipped: [], errors: [] };
    mig.migrateCommitmentOwnerBackfill(r1);
    expect(r1.errors).toEqual([]);
    expect(r1.upgraded.join()).toContain('stamped 1');

    const store = JSON.parse(fs.readFileSync(path.join(stateDir, 'state', 'commitments.json'), 'utf-8'));
    const byId = Object.fromEntries(store.commitments.map((c: { id: string }) => [c.id, c]));
    expect(byId['CMT-1'].ownerMachineId).toBe('m_backfill');
    expect(byId['CMT-2'].ownerMachineId).toBe('m_existing');
    expect(byId['CMT-3'].ownerMachineId).toBeUndefined();

    // Second run: marker short-circuits (idempotent).
    const r2 = { upgraded: [], skipped: [], errors: [] };
    mig.migrateCommitmentOwnerBackfill(r2);
    expect(r2.skipped.join()).toContain('already migrated');
    expect(r2.upgraded).toEqual([]);
  });

  it('no machine identity yet → skips WITHOUT marking migrated (retries on a later update)', async () => {
    const stateDir = tmpState();
    seed(stateDir, { identity: false, commitments: [{ id: 'CMT-1', status: 'pending' }] });
    const mig = await runMigration(stateDir);
    const r = { upgraded: [], skipped: [], errors: [] };
    mig.migrateCommitmentOwnerBackfill(r);
    expect(r.skipped.join()).toContain('no machine identity yet');
    const config = JSON.parse(fs.readFileSync(path.join(stateDir, 'config.json'), 'utf-8'));
    expect((config._instar_migrations ?? []).join()).not.toContain('ws3-commitment-owner-backfill');
  });
});
