/**
 * Tier-1 tests for StageAdvancer (§Rollout): the mechanical rollout gate. A stage
 * advances ONLY on a matching `green` prior-stage E2E for the current commit;
 * missing/red/stale-commit/tampered → refused. A live stage that later records `red`
 * mechanically reverts. StageAdvancer is the sole caller of writeStageConfig.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StageAdvancer, MAX_TARGET_REDS_PER_COMMIT, type SessionPoolStage } from '../../src/core/StageAdvancer.js';
import { SessionPoolE2EResultStore } from '../../src/core/SessionPoolE2EResultStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const sign = (c: string) => `sig::${c}`;
const verifySig = (c: string, s: string) => s === `sig::${c}`;
const SHA = 'commit-abc';

describe('StageAdvancer (§Rollout)', () => {
  let dir: string;
  let store: SessionPoolE2EResultStore;
  let stage: SessionPoolStage;
  let writes: SessionPoolStage[];
  let advancer: StageAdvancer;

  function build(commit = SHA) {
    advancer = new StageAdvancer({
      resultStore: store,
      currentCommitSha: () => commit,
      readStage: () => stage,
      writeStageConfig: (s) => { writes.push(s); stage = s; },
    });
  }
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-adv-'));
    store = new SessionPoolE2EResultStore({ filePath: path.join(dir, 'r.json'), sign, verifySig });
    stage = 'dark';
    writes = [];
    build();
  });
  afterEach(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/StageAdvancer.test.ts' }));

  it('REFUSES advance with no prior-stage E2E result (e2e-gate-not-passed / no-result)', () => {
    const r = advancer.advanceTo('shadow');
    expect(r).toMatchObject({ ok: false, reason: 'e2e-gate-not-passed', detail: 'no-result' });
    expect(writes).toEqual([]);
    expect(stage).toBe('dark');
  });

  it('ADVANCES once a matching green prior-stage result exists (writes the new stage)', () => {
    store.recordResult(0, 'green', SHA, 'tests/e2e/dark.test.ts'); // stage 0 = dark
    const r = advancer.advanceTo('shadow');
    expect(r).toEqual({ ok: true, stage: 'shadow' });
    expect(writes).toEqual(['shadow']);
  });

  it('accepts equal unknown identities without weakening stage attribution', () => {
    build('unknown');
    stage = 'live-transfer';
    store.recordResult(2, 'green', 'unknown', 'npm-install-no-git');
    expect(advancer.advanceTo('rebalance')).toEqual({ ok: true, stage: 'rebalance' });
  });

  it('REFUSES a green for a STALE commit', () => {
    store.recordResult(0, 'green', 'old-commit', 'e');
    expect(advancer.advanceTo('shadow')).toMatchObject({ ok: false, detail: 'stale-commit' });
    expect(writes).toEqual([]);
  });

  it('REFUSES when the prior result is red', () => {
    store.recordResult(0, 'red', SHA, 'e');
    expect(advancer.advanceTo('shadow')).toMatchObject({ ok: false, detail: 'result=red' });
  });

  it('REFUSES a tampered (bad-signature) green', () => {
    store.recordResult(0, 'green', SHA, 'e');
    // Corrupt the on-disk signature.
    const p = path.join(dir, 'r.json');
    fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('sig::', 'BAD::'));
    expect(advancer.advanceTo('shadow')).toMatchObject({ ok: false, detail: 'bad-signature' });
  });

  it('REFUSES advancing to a stage at or below the current one', () => {
    stage = 'live-transfer';
    expect(advancer.advanceTo('shadow')).toMatchObject({ ok: false, reason: 'already-at-or-past' });
  });

  it('reconcile() REVERTS to the prior stage when the live stage records red', () => {
    stage = 'shadow';
    store.recordResult(1, 'red', SHA, 'e'); // stage 1 = shadow regressed
    expect(advancer.reconcile()).toBe('dark');
    expect(writes).toEqual(['dark']);
  });

  it('reconcile() does NOT revert on a red recorded for a STALE commit (2026-05-29 review)', () => {
    stage = 'shadow';
    store.recordResult(1, 'red', 'old-commit', 'e'); // red, but from a prior commit — not the running build
    expect(advancer.reconcile()).toBe('shadow');
    expect(writes).toEqual([]);
  });

  it('reconcile() stays put when the live stage is green', () => {
    stage = 'shadow';
    store.recordResult(1, 'green', SHA, 'e');
    expect(advancer.reconcile()).toBe('shadow');
    expect(writes).toEqual([]);
  });

  describe('stale red superseded by a newer prior-stage green (CMT-1117 flap fix)', () => {
    let clock: number;
    beforeEach(() => {
      clock = Date.parse('2026-10-28T16:47:55Z');
      store = new SessionPoolE2EResultStore({ filePath: path.join(dir, 'clocked.json'), sign, verifySig, now: () => clock });
      build();
    });

    it('advance on a fresh green is NOT undone by the older red at the advanced stage (the dark<->shadow flap)', () => {
      stage = 'shadow';
      store.recordResult(1, 'red', SHA, 'red-at-shadow'); // 16:47 — the shadow run that went red
      expect(advancer.reconcile()).toBe('dark');           // a real revert, as before
      clock += 3600_000;
      store.recordResult(0, 'green', SHA, 'green-at-dark'); // 17:47 — a fresh green at dark
      expect(advancer.advanceTo('shadow')).toMatchObject({ ok: true, stage: 'shadow' });
      writes = [];
      expect(advancer.reconcile()).toBe('shadow');         // the old red is superseded
      expect(writes).toEqual([]);
    });

    it('a red recorded AFTER the promoting green still reverts', () => {
      store.recordResult(0, 'green', SHA, 'green-at-dark');
      clock += 1000;
      store.recordResult(1, 'red', SHA, 'red-at-shadow');
      stage = 'shadow';
      expect(advancer.reconcile()).toBe('dark');
      expect(writes).toEqual(['dark']);
    });

    it('a newer prior-stage RED does not supersede (only a green proves recovery)', () => {
      store.recordResult(1, 'red', SHA, 'red-at-shadow');
      clock += 1000;
      store.recordResult(0, 'red', SHA, 'red-at-dark');
      stage = 'shadow';
      expect(advancer.reconcile()).toBe('dark');
    });

    it('a newer prior-stage green for a DIFFERENT commit does not supersede', () => {
      store.recordResult(1, 'red', SHA, 'red-at-shadow');
      clock += 1000;
      store.recordResult(0, 'green', 'other-commit', 'green-other');
      stage = 'shadow';
      expect(advancer.reconcile()).toBe('dark');
    });

    it('re-promotion to a stage is bounded per build: refused after MAX_TARGET_REDS_PER_COMMIT verified reds there', () => {
      for (let i = 0; i < MAX_TARGET_REDS_PER_COMMIT; i++) {
        store.recordResult(1, 'red', SHA, `red-at-shadow-${i}`);
        clock += 1000;
      }
      store.recordResult(0, 'green', SHA, 'green-at-dark');
      stage = 'dark';
      expect(advancer.advanceTo('shadow')).toMatchObject({ ok: false, reason: 'e2e-gate-not-passed', detail: `target-stage-red-limit:${MAX_TARGET_REDS_PER_COMMIT}` });
      expect(writes).toEqual([]);
    });

    it('reds from an OLDER build do not count toward the re-promotion bound', () => {
      for (let i = 0; i < MAX_TARGET_REDS_PER_COMMIT; i++) store.recordResult(1, 'red', 'old-build', `old-${i}`);
      clock += 1000;
      store.recordResult(0, 'green', SHA, 'green-at-dark');
      stage = 'dark';
      expect(advancer.advanceTo('shadow')).toMatchObject({ ok: true, stage: 'shadow' });
    });

    it('a green OLDER than the target stage\'s latest red does not promote (no same-tick re-promotion after a demotion)', () => {
      store.recordResult(0, 'green', SHA, 'green-at-dark');
      clock += 1000;
      store.recordResult(1, 'red', SHA, 'red-at-shadow');
      stage = 'dark';
      expect(advancer.advanceTo('shadow')).toMatchObject({ ok: false, reason: 'e2e-gate-not-passed', detail: 'target-red-newer-than-green' });
      clock += 1000;
      store.recordResult(0, 'green', SHA, 'fresh-green-at-dark');
      expect(advancer.advanceTo('shadow')).toMatchObject({ ok: true, stage: 'shadow' });
    });

    it('currentStage() reads the configured stage back without writing', () => {
      stage = 'live-transfer';
      expect(advancer.currentStage()).toBe('live-transfer');
      expect(writes).toEqual([]);
    });
  });

  it('reconcile() at dark (floor) is a no-op', () => {
    stage = 'dark';
    store.recordResult(0, 'red', SHA, 'e');
    expect(advancer.reconcile()).toBe('dark');
    expect(writes).toEqual([]);
  });
});
