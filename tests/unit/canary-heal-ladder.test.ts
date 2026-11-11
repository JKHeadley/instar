// safe-fs-allow: test file — temp dirs via mkdtemp/rm only.
/**
 * The canary's heal ladder by cause (context-budget-layered-summaries §9.1):
 * every rung's cause → action, both sides of each boundary, and the brakes —
 * attempts, backoff, wall clock, dedupe on (machine, session, epoch), the
 * per-session daily cap, the same-cause breaker (one Attention item), the
 * seeded-marker compensation, and pool-shared ownership. Real canary ledger and
 * real SelfHealGate; only sessions, the migration and the injector are stubs.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CompactionCanary, RECOVERY_MARKER } from '../../src/monitoring/compactionCanary.js';
import { CanaryHealLadder, actionForCause, type HealLiveSession } from '../../src/monitoring/canaryHealLadder.js';
import type { HealReinjectOutcome } from '../../src/monitoring/CompactionSentinel.js';
import { InMemorySelfHealEpisodeStore } from '../../src/core/SelfHealGate.js';
import { recordPostCompact } from '../../src/monitoring/PostCompactStore.js';
import type { SeedMarker } from '../../src/monitoring/compactionSeedMarker.js';
import type { AdmissionToken } from '../../src/monitoring/selfaction/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const OP = 'tests/unit/canary-heal-ladder.test.ts';
const SID = 'sess-aaaa';
const MIN = 60_000;

describe('canary heal ladder', () => {
  let stateDir: string; let transcript: string; let now: number;
  let canary: CompactionCanary; let store: InMemorySelfHealEpisodeStore;
  let installed: boolean; let migrations: number; let live: HealLiveSession | null; let owns: boolean | 'unknown';
  let marker: SeedMarker | null; let reinjects: Array<{ epoch: string }>; let reinjectResult: HealReinjectOutcome | 'no-packet';
  let attention: Array<{ id: string; title: string }>; let n: number;

  const ladder = () => new CanaryHealLadder({
    stateDir, machineId: 'm_self', canary, now: () => now, episodeStore: store,
    installCheck: () => ({ installed, missing: installed ? [] : ['session-start.sh'] }),
    rerunMigration: () => { migrations += 1; installed = true; return { ok: true }; },
    liveSession: () => live,
    ownsSession: () => owns,
    readMarker: () => marker,
    reinject: async (t) => { reinjects.push({ epoch: t.epoch }); return reinjectResult; },
    attention: (x) => { attention.push(x); },
    admit: async () => ({ outcome: 'allow' as const, token: { id: 't' } as AdmissionToken, reason: 'admitted' as const }),
    consumeToken: () => ({ proceed: true, valid: true }),
    deliveryWaitMs: 50,
  });

  /** A compaction `ago` ms before now, with the artifacts named. */
  const compaction = (o: { block?: boolean; truncated?: boolean; postCompact?: boolean; ago?: number; sid?: string } = {}): string => {
    const at = now - (o.ago ?? 15 * MIN);
    const uuid = `b${(n += 1)}`;
    const sid = o.sid ?? SID;
    const lines = [JSON.stringify({ type: 'system', subtype: 'compact_boundary', uuid, timestamp: new Date(at).toISOString(), compactMetadata: { trigger: 'auto' }, version: '2.1.321' })];
    if (o.block || o.truncated) {
      const out = o.truncated ? `<persisted-output>\n${RECOVERY_MARKER}\npreview` : `${RECOVERY_MARKER}\nI am Echo.`;
      lines.push(JSON.stringify({ type: 'attachment', attachment: { type: 'hook_success', hookName: 'SessionStart:compact', command: 'bash ".instar/hooks/instar/session-start.sh"', stdout: out, content: out, exitCode: 0 } }));
    }
    const tp = sid === SID ? transcript : path.join(stateDir, `${sid}.jsonl`);
    fs.appendFileSync(tp, lines.join('\n') + '\n');
    if (o.postCompact !== false) recordPostCompact(stateDir, { topicKey: '141133', instarSessionId: 'i1', claudeSessionId: sid, trigger: 'auto', summary: 's', receivedAt: at + 500 });
    canary.scan([{ topicKey: '141133', claudeSessionId: sid, transcriptPath: tp, engine: 'claude-code' }], true);
    return uuid;
  };

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-heal-'));
    transcript = path.join(stateDir, `${SID}.jsonl`); fs.writeFileSync(transcript, '');
    now = Date.parse('2026-11-10T08:00:00Z'); n = 0;
    canary = new CompactionCanary({ stateDir, machineId: 'm_self', now: () => now });
    canary.scan([], true); // the switch turns on: the verification epoch starts here
    now += 60 * MIN;
    store = new InMemorySelfHealEpisodeStore();
    installed = true; migrations = 0; live = { tmuxSession: 'echo-141133', topicKey: '141133', reseedable: true }; owns = true;
    marker = null; reinjects = []; reinjectResult = 'delivered'; attention = [];
  });
  afterEach(() => SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: OP }));

  it('maps every cause to its rung', () => {
    expect(actionForCause('hook-not-installed')).toBe('re-run-migration');
    expect(actionForCause('no-recovery-block')).toBe('re-stage-and-reinject-seed');
    expect(actionForCause('recovery-truncated')).toBe('re-stage-and-reinject-seed');
    for (const c of ['post-compact-missing', 'session-gone', 'superseded', 'unhealable-engine', 'not-reseedable', 'press-without-compaction'] as const) expect(actionForCause(c)).toBe('record-only');
  });

  it('hook not installed ⇒ re-runs the migration once, then restarts the verification epoch', async () => {
    installed = false;
    compaction({ block: false });
    const before = canary.report(true).epochStartedAt;
    await ladder().tick();
    expect(migrations).toBe(1);
    expect(reinjects).toHaveLength(0);
    expect(canary.report(true).epochStartedAt).toBeGreaterThan(before);
    expect(canary.report(true).groups[0].state).toBe('uninitialized'); // the historical divergence left the epoch
  });

  it('installed but no recovery block ⇒ re-injects once on the compaction epoch; a second tick does nothing', async () => {
    const uuid = compaction({ block: false });
    const l = ladder();
    await l.tick();
    expect(reinjects).toEqual([{ epoch: uuid }]);
    expect(l.status().recent[0]).toMatchObject({ cause: 'no-recovery-block', action: 're-stage-and-reinject-seed', terminal: true });
    now += 10 * MIN;
    await l.tick();
    await ladder().tick(); // a restarted process: the ledger and the episode store remember
    expect(reinjects).toHaveLength(1);
  });

  it('a truncated delivery (RF) ⇒ the re-inject rung, settled at once (no grace wait)', async () => {
    compaction({ truncated: true, ago: 1 * MIN });
    const l = ladder();
    await l.tick();
    expect(reinjects).toHaveLength(1);
    expect(l.status().recent[0].cause).toBe('recovery-truncated');
  });

  it('a compaction still inside its artifact grace is not acted on', async () => {
    compaction({ block: false, ago: 2 * MIN });
    await ladder().tick();
    expect(reinjects).toHaveLength(0);
  });

  it('record only: block delivered but no PostCompact record; session gone; a throwaway with no packet; a superseded compaction', async () => {
    const cause = (l: CanaryHealLadder, u: string) => l.status().recent.find((r) => r.epoch === u)?.cause;
    const u1 = compaction({ block: true, postCompact: false });
    let l = ladder();
    await l.tick();
    expect(l.status().recent.find((r) => r.epoch === u1)).toMatchObject({ cause: 'post-compact-missing', action: 'record-only', outcome: 'recorded' });

    live = null; const u2 = compaction({ block: false });
    l = ladder(); await l.tick();
    expect(cause(l, u2)).toBe('session-gone');

    live = { tmuxSession: 'echo-cb-press-1', topicKey: 'press-x', reseedable: false }; const u3 = compaction({ block: false });
    l = ladder(); await l.tick();
    expect(cause(l, u3)).toBe('not-reseedable');

    live = { tmuxSession: 'echo-141133', topicKey: '141133', reseedable: true };
    const older = compaction({ block: false, ago: 30 * MIN });
    compaction({ block: true, ago: 20 * MIN });
    l = ladder(); await l.tick();
    expect(cause(l, older)).toBe('superseded');
    expect(reinjects).toHaveLength(0);
    expect(migrations).toBe(0);
  });

  it('a press no boundary followed is a detection without a real compaction ⇒ recorded only', async () => {
    canary.recordSyntheticPress(SID);
    now += 10 * MIN;
    const l = ladder();
    await l.tick();
    expect(l.status().recent[0]).toMatchObject({ cause: 'press-without-compaction', action: 'record-only' });
    expect(reinjects).toHaveLength(0);
  });

  it('compensation: a server-written seeded marker for this epoch ⇒ healed without injecting again', async () => {
    const uuid = compaction({ block: false });
    marker = { seededAt: now - 5 * MIN, epoch: uuid, source: 'server-fallback' };
    const l = ladder(); await l.tick();
    expect(reinjects).toHaveLength(0);
    expect(l.status().recent[0].outcome).toBe('healed:already-healthy');
  });

  it('a hook marker (source compact) is NOT compensation: the block never reached the model', async () => {
    const uuid = compaction({ block: false });
    marker = { seededAt: now - 15 * MIN, epoch: '', source: 'compact' };
    await ladder().tick();
    expect(reinjects).toEqual([{ epoch: uuid }]);
  });

  it('brakes: backoff 10 min then 1 h, a 30-minute wall clock, then exhausted with ONE Attention item', async () => {
    reinjectResult = 'failed';
    compaction({ block: false });
    const l = ladder();
    await l.tick(); expect(reinjects).toHaveLength(1);
    now += 5 * MIN; await l.tick(); expect(reinjects).toHaveLength(1); // backoff (10 min)
    now += 5 * MIN; await l.tick(); expect(reinjects).toHaveLength(2);
    now += 15 * MIN; await l.tick(); expect(reinjects).toHaveLength(2); // backoff (1 h)
    now += 10 * MIN; await l.tick(); // past the 30-minute wall clock ⇒ exhausted
    await l.tick(); await l.tick();
    expect(reinjects).toHaveLength(2);
    expect(attention).toHaveLength(1);
    expect(attention[0].title).toMatch(/did not get its context back/);
    expect(l.status().recent[0].outcome).toMatch(/^exhausted/);
  });

  it('per-session daily cap: a 4th run for the same session in 24 h is refused', async () => {
    const causes: Array<() => void> = [
      () => { installed = false; compaction({ block: false }); },
      () => { compaction({ block: false }); },
      () => { compaction({ truncated: true }); },
    ];
    for (const c of causes) { c(); await ladder().tick(); now += 20 * MIN; }
    expect(migrations + reinjects.length).toBe(3);
    compaction({ block: false });
    await ladder().tick();
    expect(reinjects.length).toBe(2); // refused by the cap: no 4th run
  });

  it('breaker: 3 heals of the same cause in 24 h ⇒ that cause turns record-only and ONE Attention item', async () => {
    for (let i = 0; i < 3; i++) { compaction({ block: false }); await ladder().tick(); now += 20 * MIN; }
    expect(reinjects).toHaveLength(3);
    expect(attention.filter((a) => /keeps failing the same way/.test(a.title))).toHaveLength(1);
    compaction({ block: false });
    const l = ladder(); await l.tick();
    expect(reinjects).toHaveLength(3);
    expect(l.status().recent[0].outcome).toBe('breaker-open');
    expect(l.status().breakerOpen).toContain('no-recovery-block');
    compaction({ block: false }); await ladder().tick();
    expect(attention.filter((a) => /keeps failing the same way/.test(a.title))).toHaveLength(1); // raised once
  });

  it('two sessions diverged at once: both are served (one per tick) before the epoch restarts', async () => {
    const a = compaction({ block: false });
    const b = compaction({ block: false, sid: 'sess-bbbb' });
    const l = ladder();
    const before = canary.report(true).epochStartedAt;
    await l.tick();
    expect(reinjects).toHaveLength(1);
    expect(canary.report(true).epochStartedAt).toBe(before); // not yet: the other divergence is unserved
    now += 5 * MIN; await l.tick();
    expect(reinjects.map((r) => r.epoch).sort()).toEqual([a, b].sort());
    expect(canary.report(true).epochStartedAt).toBeGreaterThan(before);
  });

  it('a second same-cause exhaustion in 24 h raises no second notice', async () => {
    reinjectResult = 'failed';
    const exhaust = async (sid: string) => {
      compaction({ block: false, sid });
      const l = ladder();
      for (let i = 0; i < 6; i++) { await l.tick(); now += 10 * MIN; }
    };
    await exhaust(SID);
    await exhaust('sess-cccc');
    expect(attention.filter((x) => /did not get its context back/.test(x.title))).toHaveLength(1);
  });

  it('a capped session opens no episode, so it never pages about tries it never made', async () => {
    reinjectResult = 'failed';
    for (let i = 0; i < 3; i++) { compaction({ block: false }); const l = ladder(); await l.tick(); now += 11 * MIN; await l.tick(); now += 25 * MIN; await l.tick(); now += 5 * MIN; await l.tick(); }
    const runsBefore = reinjects.length;
    attention = [];
    compaction({ block: false });
    const l = ladder();
    for (let i = 0; i < 8; i++) { await l.tick(); now += 10 * MIN; }
    expect(reinjects.length).toBe(runsBefore);
    expect(l.status().recent[0].outcome).toBe('capped');
    expect(attention.filter((x) => /did not get its context back/.test(x.title))).toHaveLength(0);
  });

  it('not ready (the injector is not built yet) ⇒ waits, spending no attempt', async () => {
    compaction({ block: false });
    const l = new CanaryHealLadder({
      stateDir, machineId: 'm_self', canary, now: () => now, episodeStore: store, ready: () => false,
      installCheck: () => ({ installed: true, missing: [] }), rerunMigration: () => ({ ok: true }),
      liveSession: () => live, ownsSession: () => true, readMarker: () => null,
      reinject: async (t) => { reinjects.push({ epoch: t.epoch }); return 'delivered'; },
      attention: () => {}, admit: async () => ({ outcome: 'allow' as const, token: { id: 't' } as AdmissionToken, reason: 'admitted' as const }), consumeToken: () => ({ proceed: true, valid: true }),
    });
    await l.tick();
    expect(reinjects).toHaveLength(0);
    await ladder().tick();
    expect(reinjects).toHaveLength(1);
  });

  it('not ready does not hold back the migration rung (it needs no injector)', async () => {
    installed = false;
    compaction({ block: false });
    const l = new CanaryHealLadder({
      stateDir, machineId: 'm_self', canary, now: () => now, episodeStore: store, ready: () => false,
      installCheck: () => ({ installed, missing: [] }), rerunMigration: () => { migrations += 1; installed = true; return { ok: true }; },
      liveSession: () => live, ownsSession: () => true, readMarker: () => null,
      reinject: async (t) => { reinjects.push({ epoch: t.epoch }); return 'delivered'; },
      attention: () => {}, admit: async () => ({ outcome: 'allow' as const, token: { id: 't' } as AdmissionToken, reason: 'admitted' as const }), consumeToken: () => ({ proceed: true, valid: true }),
    });
    await l.tick();
    expect(migrations).toBe(1);
  });

  it('pool-shared: a machine that does not own the session never acts (false or unknown)', async () => {
    compaction({ block: false });
    for (const o of [false, 'unknown'] as const) { owns = o; await ladder().tick(); }
    expect(reinjects).toHaveLength(0);
    owns = true; await ladder().tick();
    expect(reinjects).toHaveLength(1);
  });

  it('a delivery still waiting for an idle prompt is re-checked on the next attempt, not re-sent', async () => {
    let resolveIt: (o: HealReinjectOutcome) => void = () => {};
    const uuid = compaction({ block: false });
    const l = new CanaryHealLadder({
      stateDir, machineId: 'm_self', canary, now: () => now, episodeStore: store, deliveryWaitMs: 20,
      installCheck: () => ({ installed: true, missing: [] }), rerunMigration: () => ({ ok: true }),
      liveSession: () => live, ownsSession: () => true, readMarker: () => marker,
      reinject: (t) => { reinjects.push({ epoch: t.epoch }); return new Promise((r) => { resolveIt = r; }); },
      attention: (x) => { attention.push(x); },
      admit: async () => ({ outcome: 'allow' as const, token: { id: 't' } as AdmissionToken, reason: 'admitted' as const }), consumeToken: () => ({ proceed: true, valid: true }),
    });
    await l.tick();
    expect(reinjects).toHaveLength(1);
    // Delivered later at an idle prompt: the CompactionSentinel wrote the server marker for the epoch.
    resolveIt('delivered');
    marker = { seededAt: now, epoch: uuid, source: 'heal' };
    now += 10 * MIN; await l.tick();
    expect(reinjects).toHaveLength(1);
    expect(l.status().recent[0].outcome).toBe('healed:already-healthy');
  });
});
