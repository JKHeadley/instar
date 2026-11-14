// safe-fs-allow: test file — temp dirs via mkdtemp/rm only.
/**
 * Integration — the SelfHealGate extensions on real SQLite stores
 * (context-budget-layered-summaries §9.4): a pool-shared async ladder in its
 * OWN episode store file, beside the production feedback-defaults consumer's
 * store in the same state directory.
 *  - Filling the ladder's store (ring + cap) never darkens the other consumer.
 *  - Two machines, one owner: only the owner remediates; ownership moving
 *    moves who acts; the non-owner never creates an episode.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SelfHealGate, SqliteSelfHealEpisodeStore, type SelfHealSpec } from '../../src/core/SelfHealGate.js';
import type { AdmissionToken } from '../../src/monitoring/selfaction/types.js';
import { runFeedbackFactoryDefaultsSelfHeal } from '../../src/feedback-factory/drain/FeedbackFactoryDefaultsSelfHeal.js';
import { initSelfActionGovernor } from '../../src/monitoring/selfaction/governor.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'self-heal-gate-pool-ladder cleanup' }); });

type Ctx = { topic: string; incident: string };
const group = (k: string) => k.slice(0, k.lastIndexOf('-'));
function ladder(machine: string, owner: () => string, remediate: (c: Ctx) => Promise<{ outcome: 'healed' | 'not-healed'; evidence: 'repaired' | 'verification-failed' }>): SelfHealSpec<Ctx> {
  return {
    id: 'cb-stage-ladder', controllerResource: 'pool-shared', episodeAuthority: 'durable-machine-local', classId: 'cb',
    severity: () => 'recoverable', dedupeKey: (c) => `${machine}-${c.topic}-stage-${c.incident}`, eligible: () => ({ eligible: true, fence: 'g1' }),
    isOwner: () => owner() === machine, remediationMode: 'async', remediationAsync: remediate, maxRemediationMs: 2_000,
    maxAttempts: 2, maxWallClockMs: 60_000, backoffMs: () => 0, notificationLatencyCeilingMs: 60_000, flap: { maxRecoveries: 10, windowMs: 60_000 },
    remediationActions: { operation: 're-stage', idempotencyGuard: 'fold-record CAS', compensation: 'rollback' },
  };
}
function deps(store: SqliteSelfHealEpisodeStore, notify = vi.fn()) {
  let n = 0;
  return { admit: async () => ({ outcome: 'allow' as const, token: { id: `t${++n}` } as AdmissionToken, reason: 'admitted' as const }), consumeToken: () => ({ proceed: true, valid: true }), notify, audit: () => {}, episodeStore: store, bootId: 'b1' };
}

describe('pool-shared async ladder on real stores', () => {
  it('a full ladder store never darkens the feedback-defaults consumer in the same state directory', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shg-own-store-')); dirs.push(stateDir);
    const own = new SqliteSelfHealEpisodeStore(path.join(stateDir, 'state', 'context-budget-self-heal.db'), { maxRows: 8, ring: { groupOf: group, perGroup: 4 } });
    const gate = new SelfHealGate(ladder('m1', () => 'm1', async () => ({ outcome: 'not-healed', evidence: 'verification-failed' })), deps(own));
    // Fill the ladder's store with live episodes across topics until it refuses.
    for (let t = 0; t < 8; t++) expect((await gate.attempt({ topic: `t${t}`, incident: 'i1' })).outcome).toBe('attempted');
    expect((await gate.attempt({ topic: 't9', incident: 'i1' })).outcome).toBe('state-failure'); // its OWN store is full
    // The production consumer, on its own default store file, still runs.
    initSelfActionGovernor({ stateDir, readEmergencyDisable: () => false, readClassesConfig: () => ({}), now: () => Date.now(), flushIntervalMs: 60_000 });
    const r = await runFeedbackFactoryDefaultsSelfHeal({ stateDir, developmentAgent: true, bootId: 'boot-one', currentFence: () => 'machine-a:1', notify: vi.fn() });
    expect(r.attempted).toBe(true);
    expect(r.outcome).not.toBe('state-failure');
    own.close();
  });

  it('two machines, one owner: only the owner remediates, and moving ownership moves who acts', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shg-two-machines-')); dirs.push(root);
    let owner = 'm1';
    const ran: string[] = [];
    const mk = (m: string) => {
      const store = new SqliteSelfHealEpisodeStore(path.join(root, m, 'context-budget-self-heal.db'), { ring: { groupOf: group, perGroup: 4 } });
      return { store, gate: new SelfHealGate(ladder(m, () => owner, async (c) => { ran.push(`${m}:${c.incident}`); return { outcome: 'healed', evidence: 'repaired' }; }), deps(store)) };
    };
    const A = mk('m1'); const B = mk('m2');
    expect(await B.gate.attempt({ topic: '141133', incident: 'i1' })).toEqual({ outcome: 'governed', reason: 'not-owner' });
    expect(B.store.load('cb-stage-ladder:m2-141133-stage-i1')).toBeNull();
    expect(await A.gate.attempt({ topic: '141133', incident: 'i1' })).toMatchObject({ outcome: 'healed' });
    owner = 'm2';
    expect(await A.gate.attempt({ topic: '141133', incident: 'i2' })).toEqual({ outcome: 'governed', reason: 'not-owner' });
    expect(await B.gate.attempt({ topic: '141133', incident: 'i2' })).toMatchObject({ outcome: 'healed' });
    expect(ran).toEqual(['m1:i1', 'm2:i2']);
    // The next tick prunes the terminal episodes on each machine.
    expect(A.gate.pruneTerminal()).toBe(1); expect(B.gate.pruneTerminal()).toBe(1);
    A.store.close(); B.store.close();
  });
});
