/**
 * The executor under a full subscription reroute lane (docs/specs/confined-spawn-subscription-reroute.md,
 * Cap contention): a saturated lane DEFERS a claim (no attempt, no daily start, no clone); a race
 * refusal (`RerouteRefusedError`) stops the attempt as `reroute-capacity`, refunds its start exactly
 * once (capped per day), and never counts against the item. The class decides, never the text.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createExecHarness, type ExecHarness } from '../../fixtures/feedbackExecuteHarness.js';
import { RerouteRefusedError } from '../../../src/core/rerouteRefusedError.js';
import { prepareFailureStep } from '../../../src/feedback-factory/execute/FeedbackExecutorService.js';

let h: ExecHarness;
afterEach(() => h?.cleanup());

describe('reroute capacity', () => {
  it('a saturated lane claims nothing and consumes no daily start; a free lane starts the attempt', async () => {
    h = await createExecHarness();
    await h.workItem('c1');
    h.fixWith({ 'src/thing.ts': 'export const thing = 2;\n' });
    h.admission.rerouteSaturated = true;
    const t = await h.exec.tick();
    expect(t.started).toBe(0);
    expect(t.reason).toBe('admission:reroute-capacity');
    expect(h.execStore.all()).toHaveLength(0);
    expect(h.execStore.startsToday()).toBe(0);
    expect(h.sessions.spawned).toHaveLength(0);
    h.admission.rerouteSaturated = false;
    expect((await h.exec.tick()).started).toBe(1);
  });

  it('a RerouteRefusedError stops the attempt as reroute-capacity, refunds the start once, and never holds the item', async () => {
    h = await createExecHarness();
    const initiativeId = await h.workItem('c1');
    h.fixWith({ 'src/thing.ts': 'export const thing = 2;\n' });
    h.spawnError.value = new RerouteRefusedError('rerouted-session cap reached (6/6)');
    for (let i = 0; i < 6; i++) {
      await h.exec.tick();
      h.now.value += 31 * 60_000;
    }
    const rows = h.execStore.all();
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.every((r) => r.state === 'stopped' && r.reason === 'reroute-capacity')).toBe(true);
    expect(h.execStore.startsToday()).toBe(0); // every start refunded
    // The item was never held: the next free tick starts it.
    h.spawnError.value = null;
    expect((await h.exec.tick()).started).toBe(1);
    expect(h.execStore.latestFor(initiativeId)?.state).not.toBe('stopped');
    // A duplicate refund for an already-refunded attempt changes nothing.
    expect(h.execStore.stopForRerouteCapacity(1, rows[0].attemptId, 6)).toBe(false);
  });

  it('refunds are capped per claim day: past maxStartsPerDay the refusal keeps its start', async () => {
    h = await createExecHarness({ config: { maxStartsPerDay: 2 } });
    await h.workItem('c1');
    h.fixWith({ 'src/thing.ts': 'export const thing = 2;\n' });
    h.spawnError.value = new RerouteRefusedError('cap');
    for (let i = 0; i < 4; i++) {
      await h.exec.tick();
      h.now.value += 31 * 60_000;
    }
    // Two refunds were allowed; later refusals kept their starts, so the daily budget still bounds attempts.
    expect(h.execStore.startsToday()).toBe(2);
    expect(h.execStore.all().length).toBeLessThanOrEqual(4);
  });

  it('a plain Error with the same message is an ordinary prepare failure (the class decides)', async () => {
    h = await createExecHarness();
    await h.workItem('c1');
    h.fixWith({ 'src/thing.ts': 'export const thing = 2;\n' });
    h.spawnError.value = new Error('Reroute refused (force-mode): cap');
    await h.exec.tick();
    expect(h.execStore.all()[0]).toMatchObject({ state: 'failed', reason: 'prepare-failed' });
  });

  it('a refund reverses the debit of the day the attempt was CLAIMED, even after UTC midnight', async () => {
    h = await createExecHarness();
    await h.workItem('c1');
    h.now.value = Date.parse('2026-10-19T23:59:50Z');
    const row = h.execStore.claim(1, { initiativeId: 'manual-1', clusterId: 'cl-1', needsSpec: false, userFacing: false, leaseMs: 60_000, maxStartsPerDay: 6 })!;
    expect(h.execStore.startsToday(Date.parse('2026-10-19T23:59:55Z'))).toBe(1);
    h.now.value = Date.parse('2026-10-20T00:00:30Z');
    expect(h.execStore.stopForRerouteCapacity(1, row.attemptId, 6)).toBe(true);
    expect(h.execStore.startsToday(Date.parse('2026-10-19T23:59:55Z'))).toBe(0);
    expect(h.execStore.startsToday(Date.parse('2026-10-20T00:00:30Z'))).toBe(0);
  });
});

describe('a failed preparation stops the tick (2026-10-23 live: one machine fault failed 8 items in one tick)', () => {
  it('claims no further candidate after the first prepare-failed, and keeps the readable reason in status', async () => {
    h = await createExecHarness({ config: { maxConcurrent: 6 } });
    await h.workItem('c1');
    await h.workItem('c2');
    await h.workItem('c3');
    h.fixWith({ 'src/thing.ts': 'export const thing = 2;\n' });
    h.spawnError.value = new Error('Command failed: git checkout --detach --quiet abc\nfatal: unable to read tree (abc)');
    await h.exec.tick();
    expect(h.execStore.all()).toHaveLength(1);
    expect(h.execStore.all()[0]).toMatchObject({ state: 'failed', reason: 'prepare-failed' });
    const last = h.exec.summary().lastPrepareFailure as { step: string; detail: string; attemptId: string };
    expect(last.step).toBe('checkout-base');
    expect(last.detail).toContain('unable to read tree');
    expect(last.attemptId).toBe(h.execStore.all()[0].attemptId);
    // The audit keeps only id-shaped values; the step survives there, the sentence does not.
    const audit = fs.readFileSync(path.join(h.dir, 'logs', 'feedback-triage.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(audit.find((r) => r.event === 'execute:prepare-failed')).toMatchObject({ step: 'checkout-base' });
  });

  it('prepareFailureStep names the step from the message', () => {
    expect(prepareFailureStep(null)).toBe('unknown');
    expect(prepareFailureStep('base-sha-unreadable')).toBe('fetch-base');
    expect(prepareFailureStep('fatal: unable to read tree (x)')).toBe('checkout-base');
    expect(prepareFailureStep('clone destination exists: feedback-x-a1')).toBe('clone');
    expect(prepareFailureStep("EEXIST: file already exists, symlink 'a' -> 'b'")).toBe('link-deps');
    expect(prepareFailureStep('something else')).toBe('other');
  });
});
