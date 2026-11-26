import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { SessionPoolE2EResultStore } from '../../src/core/SessionPoolE2EResultStore.js';
import { StageAdvancer, type SessionPoolStage } from '../../src/core/StageAdvancer.js';
import { SessionPoolRolloutDriver } from '../../src/core/SessionPoolRolloutDriver.js';
import {
  PAIR_GREEN_HOLD_MS, PAIR_GREEN_MAX_AGE_MS, PAIR_GREEN_RENEW_MS, PairGreenProducer, pairShadowProofState,
} from '../../src/core/sessionPoolPairGreen.js';

let dir: string; let store: SessionPoolE2EResultStore; let now: number; let ready: boolean; let sha: string;
let producer: PairGreenProducer;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pair-green-'));
  now = Date.parse('2026-11-05T01:00:00.000Z'); ready = true; sha = 'build-1';
  store = new SessionPoolE2EResultStore({
    filePath: path.join(dir, 'rows.jsonl'), sign: (c) => `s:${c}`, verifySig: (c, s) => s === `s:${c}`, now: () => now,
  });
  producer = new PairGreenProducer({ store, commitSha: () => sha, ready: () => ready, now: () => now });
});
afterEach(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/session-pool-pair-green.test.ts:cleanup' }));

const holdThenTick = () => { producer.tick(); now += PAIR_GREEN_HOLD_MS; return producer.tick(); };

describe('PairGreenProducer', () => {
  it('records nothing until readiness has held ten minutes', () => {
    expect(producer.tick()).toBe(false);
    now += PAIR_GREEN_HOLD_MS - 1;
    expect(producer.tick()).toBe(false);
    now += 1;
    expect(producer.tick()).toBe(true);
    expect(store.getLatestForStage(0)?.evidenceRef).toMatch(/^readiness:/);
  });
  it('one failed check restarts the wait', () => {
    producer.tick();
    now += PAIR_GREEN_HOLD_MS - 1;
    ready = false; producer.tick(); ready = true;
    now += 1;
    expect(producer.tick()).toBe(false);
  });
  it('never writes over a real failure of this build, at stage 0 or 1', () => {
    for (const stage of [0, 1]) {
      store.recordResult(stage, 'red', sha, 'failover');
      expect(holdThenTick()).toBe(false);
    }
    expect(store.all().every((r) => r.result === 'red')).toBe(true);
  });
  it('a red from an older build does not stop a new one', () => {
    store.recordResult(1, 'red', 'build-0', 'failover');
    expect(holdThenTick()).toBe(true);
  });
  it('renews inside the expiry, and at once for a new build, without growing every tick', () => {
    holdThenTick();
    now += 60_000;
    expect(producer.tick()).toBe(false);
    now += PAIR_GREEN_RENEW_MS;
    expect(producer.tick()).toBe(true);
    sha = 'build-2';
    expect(producer.tick()).toBe(true);
    expect(store.all()).toHaveLength(3);
  });
});

describe('shadow proof', () => {
  const build = (stage: { v: SessionPoolStage }, hasPeer: () => boolean) => new StageAdvancer({
    resultStore: store, currentCommitSha: () => sha, readStage: () => stage.v,
    writeStageConfig: (s) => { stage.v = s; },
    shadowProof: () => pairShadowProofState(store, now, hasPeer()),
  });

  it('a fresh green with a peer earns shadow, and only shadow', () => {
    const stage = { v: 'dark' as SessionPoolStage };
    const driver = new SessionPoolRolloutDriver({ advancer: build(stage, () => true), enabled: () => true, targetCeiling: () => 'shadow' });
    holdThenTick();
    driver.tick(); driver.tick();
    expect(stage.v).toBe('shadow');
  });
  it('an expired green steps down and stays down through the same tick', () => {
    const stage = { v: 'shadow' as SessionPoolStage };
    const driver = new SessionPoolRolloutDriver({ advancer: build(stage, () => true), enabled: () => true, targetCeiling: () => 'shadow' });
    holdThenTick();
    now += PAIR_GREEN_MAX_AGE_MS + 1;
    driver.tick();
    expect(stage.v).toBe('dark');
  });
  it('no peer left steps down', () => {
    const stage = { v: 'shadow' as SessionPoolStage };
    holdThenTick();
    expect(build(stage, () => false).reconcile()).toBe('dark');
  });
  it('a pool without the proof keeps its old behaviour', () => {
    const stage = { v: 'shadow' as SessionPoolStage };
    const plain = new StageAdvancer({
      resultStore: store, currentCommitSha: () => sha, readStage: () => stage.v, writeStageConfig: (s) => { stage.v = s; },
    });
    expect(plain.reconcile()).toBe('shadow');
  });
});
