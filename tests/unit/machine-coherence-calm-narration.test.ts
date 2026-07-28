/**
 * calm-transient-episode-alerting M-P2 — narration semantics + the effects
 * executor pass-through (wiring-integrity tier).
 *
 * Covers the spec's semantic boundaries: calm vs loud class selection, silent
 * vs notifying mode (interacted / untouched / escalated close), calm copy
 * carries NO fix prompt, derived raises are NON-silent (safety-critical: with
 * transients at zero buzz they are the guard's only buzz path), resolve-note
 * bounding, wave backstop, orphan self-closeout (status on every close reason
 * regardless of speaks()), and the executor's NORMAL pass-through (the original
 * hardcoded-HIGH site).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { MachineCoherenceEpisodeManager, type EpisodeEffect, type EpisodeReconcileInput } from '../../src/monitoring/machineCoherenceEpisodeManager.js';
import { resolveMachineCoherenceConfig } from '../../src/monitoring/MachineCoherenceSentinel.js';
import { executeMachineCoherenceEffects, type EffectsTelegram } from '../../src/monitoring/machineCoherenceEffectsExecutor.js';
import type { SkewRow } from '../../src/monitoring/machineCoherenceEvaluate.js';

const TICK = 30_000;
let dir: string;
let NOW = 1_751_500_000_000;

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-calm-')); NOW = 1_751_500_000_000; });
afterEach(() => { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/machine-coherence-calm-narration.test.ts:cleanup' }); });

function versionRow(vA = '1.3.800', vB = '1.3.810'): SkewRow {
  return {
    identity: `version|instarVersion|m1=${vA.replace(/\./g, '-')},m2=${vB.replace(/\./g, '-')}`,
    dimension: 'version', key: 'instarVersion', participants: ['m1', 'm2'],
    valueClasses: { m1: vA.replace(/\./g, '-'), m2: vB.replace(/\./g, '-') },
    versionSeverity: 'patch-only',
  };
}

function mgr(over: Record<string, unknown> = {}) {
  return new MachineCoherenceEpisodeManager(dir, resolveMachineCoherenceConfig({
    developmentAgent: true,
    monitoring: { machineCoherence: { dryRun: false, resolveTicks: 1, ...over } },
  }));
}

function input(over: Partial<EpisodeReconcileInput> = {}): EpisodeReconcileInput {
  return {
    confirmedRows: [versionRow()],
    comparedMachineIds: new Set(['m1', 'm2']),
    onlineMachineIds: new Set(['m1', 'm2']),
    selfMachineId: 'm1',
    raiserMachineId: 'm1',
    leaseHolderMachineId: 'm1',
    nicknameOf: (m) => (m === 'm1' ? 'Mini' : 'Laptop'),
    now: NOW,
    rawRows: over.confirmedRows === undefined ? [versionRow()] : (over.confirmedRows as SkewRow[]),
    versionsByMachine: { m1: '1.3.800', m2: '1.3.810' },
    tickMs: TICK,
    ...over,
  };
}

/** Drive anchor accumulation: N ticks of raw skew BEFORE any confirmation. */
function warmAnchors(m: MachineCoherenceEpisodeManager, ticks: number, versions = { m1: '1.3.800', m2: '1.3.810' }) {
  for (let i = 0; i < ticks; i++) {
    NOW += TICK;
    m.reconcile(input({ confirmedRows: [], rawRows: [versionRow(versions.m1, versions.m2)], versionsByMachine: versions }));
  }
}

describe('M-P2 calm narration (manager semantics)', () => {
  it('a calm (patch-only version) open raises SILENT at NORMAL with NO fix prompt', () => {
    const m = mgr();
    warmAnchors(m, 2);
    NOW += TICK;
    const effects = m.reconcile(input());
    const raise = effects.find((e): e is Extract<EpisodeEffect, { kind: 'raise' }> => e.kind === 'raise');
    expect(raise).toBeDefined();
    expect(raise!.priority).toBe('NORMAL');
    expect(raise!.silent).toBe(true);
    expect(raise!.description).not.toContain('fix it'); // calm copy: no decision prompt
    expect(raise!.description).toContain('self-heal');
  });

  it('calmRaiseNotify:true restores a buzzing calm raise (rollback lever)', () => {
    const m = mgr({ calmRaiseNotify: true });
    warmAnchors(m, 2);
    NOW += TICK;
    const raise = m.reconcile(input()).find((e): e is Extract<EpisodeEffect, { kind: 'raise' }> => e.kind === 'raise');
    expect(raise!.silent).toBe(false);
    expect(raise!.priority).toBe('NORMAL');
  });

  it('a flag episode stays loud: HIGH, notifying, with the fix prompt machinery', () => {
    const flagRow: SkewRow = {
      identity: 'flag|monitoring.burnDetection.enabled|m1=true,m2=false',
      dimension: 'flag', key: 'monitoring.burnDetection.enabled', participants: ['m1', 'm2'],
      valueClasses: { m1: 'true', m2: 'false' },
    };
    const m = mgr();
    NOW += TICK;
    const raise = m.reconcile(input({ confirmedRows: [flagRow], rawRows: [flagRow] })).find((e): e is Extract<EpisodeEffect, { kind: 'raise' }> => e.kind === 'raise');
    expect(raise).toBeDefined();
    expect(raise!.priority).toBe('HIGH');
    expect(raise!.silent).toBe(false);
  });

  it('an untouched calm episode closes with a SILENT resolve note; derived items and buzz never happen', () => {
    const m = mgr();
    warmAnchors(m, 2);
    NOW += TICK;
    m.reconcile(input()); // open (calm)
    NOW += TICK;
    const effects = m.reconcile(input({ confirmedRows: [], rawRows: [] , versionsByMachine: { m1: '1.3.810', m2: '1.3.810' }})); // heal → close (resolveTicks 1)
    const resolve = effects.find((e): e is Extract<EpisodeEffect, { kind: 'resolve' }> => e.kind === 'resolve');
    expect(resolve).toBeDefined();
    expect(resolve!.silent).toBe(true);
    expect(effects.some((e) => e.kind === 'raise')).toBe(false);
  });

  it('an INTERACTED episode closes NOTIFYING (evidence-carrying ack sets the bit; unverified ack does not)', () => {
    const m = mgr();
    warmAnchors(m, 2);
    NOW += TICK;
    m.reconcile(input()); // open
    m.setOperatorAck(true, { verifiedOperator: true });
    NOW += TICK;
    const effects = m.reconcile(input({ confirmedRows: [], rawRows: [], versionsByMachine: { m1: '1.3.810', m2: '1.3.810' } }));
    const resolve = effects.find((e): e is Extract<EpisodeEffect, { kind: 'resolve' }> => e.kind === 'resolve');
    expect(resolve!.silent).toBe(false);

    // Unverified ack (no evidence) → interacted NOT set → silent close.
    // Fresh state dir: the durable file (recurrence + note bounding) must not
    // carry over from the first manager.
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-calm-2-'));
    const m2 = mgr();
    warmAnchors(m2, 2);
    NOW += TICK;
    m2.reconcile(input());
    m2.setOperatorAck(true); // no verifiedOperator evidence
    NOW += TICK;
    const eff2 = m2.reconcile(input({ confirmedRows: [], rawRows: [], versionsByMachine: { m1: '1.3.810', m2: '1.3.810' } }));
    const r2 = eff2.find((e): e is Extract<EpisodeEffect, { kind: 'resolve' }> => e.kind === 'resolve');
    expect(r2!.silent).toBe(true);
  });

  it('stall ceiling: the derived :stalled raise fires NON-silent at HIGH, once; close resolves base + derived with a notifying withdrawal', () => {
    // Tiny ceiling so the accumulator crosses it fast (clamped keys: use real ms).
    const m = mgr({ versionSkewStallCeilingMs: 4 * TICK, versionSkewGraceMs: 1 });
    warmAnchors(m, 2);
    NOW += TICK;
    m.reconcile(input()); // open (calm — anchor below ceiling at open)
    // Keep the skew active past the ceiling (accumulator credits divergent ticks).
    let stalledRaise: Extract<EpisodeEffect, { kind: 'raise' }> | undefined;
    for (let i = 0; i < 8 && !stalledRaise; i++) {
      NOW += TICK;
      const eff = m.reconcile(input());
      stalledRaise = eff.find((e): e is Extract<EpisodeEffect, { kind: 'raise' }> => e.kind === 'raise' && e.itemId.endsWith(':stalled'));
    }
    expect(stalledRaise).toBeDefined();
    expect(stalledRaise!.priority).toBe('HIGH');
    expect(stalledRaise!.silent).toBe(false); // safety-critical: the only buzz path
    expect(stalledRaise!.description).toContain('began as a calm');
    // No duplicate on further ticks (per-episode derivedItemIds + 24h latch).
    NOW += TICK;
    const again = m.reconcile(input());
    expect(again.some((e) => e.kind === 'raise' && e.itemId.endsWith(':stalled'))).toBe(false);
    // Heal → close: base resolve NOTIFYING (escalated) + derived resolves DONE.
    NOW += TICK;
    const closeEff = m.reconcile(input({ confirmedRows: [], rawRows: [], versionsByMachine: { m1: '1.3.810', m2: '1.3.810' } }));
    const resolve = closeEff.find((e): e is Extract<EpisodeEffect, { kind: 'resolve' }> => e.kind === 'resolve');
    expect(resolve).toBeDefined();
    expect(resolve!.silent).toBe(false); // decision-withdrawal notifies
    expect(resolve!.note).toContain('withdrawn');
    const statuses = closeEff.filter((e) => e.kind === 'resolve-status').map((e) => e.itemId);
    expect(statuses.some((id) => id.endsWith(':stalled'))).toBe(true);
  });

  it('orphan self-closeout: a NON-speaking machine still status-resolves its own items on close', () => {
    const m = mgr();
    warmAnchors(m, 2);
    NOW += TICK;
    m.reconcile(input()); // open as raiser (holds the item)
    NOW += TICK;
    // Raiser role moves away (another machine now speaks) — heal closes the episode.
    const effects = m.reconcile(input({ confirmedRows: [], rawRows: [], raiserMachineId: 'm2', versionsByMachine: { m1: '1.3.810', m2: '1.3.810' } }));
    // The calm close on a non-speaker: silent note or status-only — but NEVER nothing.
    const touched = effects.filter((e) => (e.kind === 'resolve' || e.kind === 'resolve-status'));
    expect(touched.length).toBeGreaterThan(0);
  });

  it('resolve-note bounding: a second close within reopenWindowMs is status-only (suppressed note)', () => {
    const m = mgr({ reopenWindowMs: 3_600_000 });
    warmAnchors(m, 2);
    NOW += TICK;
    m.reconcile(input()); // open
    NOW += TICK;
    const c1 = m.reconcile(input({ confirmedRows: [], rawRows: [], versionsByMachine: { m1: '1.3.810', m2: '1.3.810' } }));
    expect(c1.some((e) => e.kind === 'resolve')).toBe(true);
    // Reopen (same rows) + close again inside the window.
    NOW += TICK;
    m.reconcile(input());
    NOW += TICK;
    const c2 = m.reconcile(input({ confirmedRows: [], rawRows: [], versionsByMachine: { m1: '1.3.810', m2: '1.3.810' } }));
    expect(c2.some((e) => e.kind === 'resolve')).toBe(false);
    expect(c2.some((e) => e.kind === 'resolve-status')).toBe(true);
  });

  it('wave backstop: the 6th NON-reopen calm onset in 24 h fires ONE notifying aggregate', () => {
    const m = mgr({ maxEpisodeItemsPerDay: 100 });
    let waveRaises = 0;
    for (let n = 0; n < 8; n++) {
      warmAnchors(m, 2);
      NOW += TICK;
      const open = m.reconcile(input());
      waveRaises += open.filter((e) => e.kind === 'raise' && e.itemId.startsWith('machine-coherence-wave:')).length;
      NOW += TICK; // heal + close promptly (resolveTicks 1)
      m.reconcile(input({ confirmedRows: [], rawRows: [], versionsByMachine: { m1: '1.3.810', m2: '1.3.810' } }));
      NOW += 2 * 3_600_000; // gap PAST the reopen window — the NEXT onset is a FRESH episode, not a reopen
    }
    expect(waveRaises).toBe(1); // fired once at the threshold, 24h-deduped after
  });
});

describe('effects executor pass-through (wiring integrity)', () => {
  function recorder() {
    const calls: { create: any[]; sends: Array<{ topicId: number; text: string; silent?: boolean }>; statuses: Array<{ id: string; status: string; silent?: boolean }> } =
      { create: [], sends: [], statuses: [] };
    const tg: EffectsTelegram = {
      createAttentionItem: async (item) => { calls.create.push(item); },
      getAttentionItem: (id) => ({ topicId: 777 }),
      sendToTopic: async (topicId, text, options) => { calls.sends.push({ topicId, text, silent: options?.silent }); },
      updateAttentionStatus: async (id, status, opts) => { calls.statuses.push({ id, status, silent: opts?.silent }); return true; },
    };
    return { calls, tg };
  }
  const flush = () => new Promise((r) => setImmediate(r));

  it('a NORMAL raise reaches createAttentionItem as NORMAL (the hardcoded-HIGH fix) — and legacy raises stay HIGH', async () => {
    const { calls, tg } = recorder();
    executeMachineCoherenceEffects([
      { kind: 'raise', itemId: 'a', title: 't', summary: 's', description: 'd', priority: 'NORMAL', silent: true },
      { kind: 'raise', itemId: 'b', title: 't', summary: 's', description: 'd' }, // legacy shape
    ], { telegram: () => tg });
    await flush();
    expect(calls.create.find((c) => c.id === 'a').priority).toBe('NORMAL');
    expect(calls.create.find((c) => c.id === 'a').silent).toBe(true);
    expect(calls.create.find((c) => c.id === 'b').priority).toBe('HIGH');
    expect(calls.create.find((c) => c.id === 'b').silent).toBe(false);
  });

  it('a silent resolve reaches sendToTopic with silent:true AND status DONE; resolve-status sends NOTHING', async () => {
    const { calls, tg } = recorder();
    executeMachineCoherenceEffects([
      { kind: 'resolve', itemId: 'x', note: 'healed', silent: true },
      { kind: 'resolve-status', itemId: 'y' },
    ], { telegram: () => tg });
    await flush();
    expect(calls.sends).toHaveLength(1);
    expect(calls.sends[0].silent).toBe(true);
    expect(calls.statuses.map((s) => s.id).sort()).toEqual(['x', 'y']);
    expect(calls.statuses.find((s) => s.id === 'y')!.silent).toBe(true);
  });

  it('a null adapter never throws (fail toward silence)', async () => {
    executeMachineCoherenceEffects([{ kind: 'resolve-status', itemId: 'z' }], { telegram: () => null });
    await flush(); // no throw = pass
  });
});
