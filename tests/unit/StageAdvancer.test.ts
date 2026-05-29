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
import { StageAdvancer, type SessionPoolStage } from '../../src/core/StageAdvancer.js';
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

  it('reconcile() at dark (floor) is a no-op', () => {
    stage = 'dark';
    store.recordResult(0, 'red', SHA, 'e');
    expect(advancer.reconcile()).toBe('dark');
    expect(writes).toEqual([]);
  });
});
