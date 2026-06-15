/**
 * Unit tests for the C1+C2 external-block staleness governor
 * (PromiseBeacon.sweepExternalBlocks — spec agent-owned-followthrough §4.4).
 *
 * The governor guarantees an owner:'agent', blockedOn:'external' commitment can
 * never park silently forever:
 *   - WINDOW: no dependency-probe within the window → ONE deduped Attention
 *     dead-letter (never auto-closed — CMT-1101 scar).
 *   - CEILING: past the absolute lifetime → dead-letter regardless of probes
 *     (defeats a false-liveness probe loop).
 *   - A fresh probe RESETS the window (re-arms the governor).
 *   - Rollout-gated: off → no-op; dryRun → logs would-deadletter, doesn't raise.
 *   - owner:'user' / blockedOn:'none' are never governed.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CommitmentTracker } from '../../src/monitoring/CommitmentTracker.js';
import { LiveConfig } from '../../src/config/LiveConfig.js';
import { LlmQueue } from '../../src/monitoring/LlmQueue.js';
import { ProxyCoordinator } from '../../src/monitoring/ProxyCoordinator.js';
import { PromiseBeacon } from '../../src/monitoring/PromiseBeacon.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function tmpState() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beacon-extgov-'));
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({}, null, 2));
  return { dir, cleanup: () => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/promise-beacon-external-block-governor.test.ts' }) };
}

describe('PromiseBeacon external-block staleness governor (sweepExternalBlocks)', () => {
  let dir: string;
  let cleanup: () => void;
  let tracker: CommitmentTracker;
  let attention: Array<{ id: string; detail: string }>;
  let featureState: { enabled: boolean; dryRun: boolean };
  let clock: number;
  let beacon: PromiseBeacon;
  let events: Array<{ name: string; id: string }>;

  function build(opts: { windowMs?: number; ceilingMs?: number } = {}) {
    beacon = new PromiseBeacon({
      stateDir: dir,
      commitmentTracker: tracker,
      llmQueue: new LlmQueue({ maxDailyCents: 100 }),
      proxyCoordinator: new ProxyCoordinator(),
      captureSessionOutput: () => '',
      getSessionForTopic: () => null,
      isSessionAlive: () => false,
      sendMessage: async () => {},
      raiseAttention: (id, detail) => { attention.push({ id, detail }); },
      agentOwnedFollowthrough: () => featureState,
      now: () => clock,
      externalBlockWindowMs: opts.windowMs ?? 1000,
      externalBlockCeilingMs: opts.ceilingMs ?? 10_000_000,
    });
    for (const e of ['aoft.deadlettered-external', 'aoft.would-deadletter-external']) {
      beacon.on(e, (p: { id: string }) => events.push({ name: e, id: p.id }));
    }
  }

  beforeEach(() => {
    ({ dir, cleanup } = tmpState());
    tracker = new CommitmentTracker({ stateDir: dir, liveConfig: new LiveConfig(dir) });
    attention = [];
    events = [];
    featureState = { enabled: true, dryRun: false };
    clock = Date.now();
  });
  afterEach(() => cleanup());

  const extBlock = () =>
    tracker.record({ userRequest: 'wait on CI', agentResponse: 'monitoring CI', type: 'one-time-action', owner: 'agent', blockedOn: 'external', topicId: 7 });

  it('window-stale (no probe) → ONE Attention dead-letter, never auto-closed', async () => {
    const c = extBlock();
    clock = Date.now() + 5000; // past the 1s window
    await beacon.sweepExternalBlocks();
    expect(attention).toHaveLength(1);
    expect(attention[0].id).toBe(c.id);
    // NEVER auto-closed — still pending, just dead-lettered + marked.
    const after = tracker.get(c.id);
    expect(after?.status).toBe('pending');
    expect(after?.externalBlockDeadLetteredAt).toBeTruthy();
    expect(events.some(e => e.name === 'aoft.deadlettered-external')).toBe(true);
  });

  it('deduped — a second sweep does not re-fire', async () => {
    extBlock();
    clock = Date.now() + 5000;
    await beacon.sweepExternalBlocks();
    await beacon.sweepExternalBlocks();
    expect(attention).toHaveLength(1);
  });

  it('a fresh probe re-arms the governor (re-stale fires again)', async () => {
    const c = extBlock();
    clock = Date.now() + 5000;
    await beacon.sweepExternalBlocks();
    expect(attention).toHaveLength(1);
    tracker.recordProbe(c.id, { checked: 'CI', readinessSignal: 'green' }); // clears the mark, resets window
    clock = Date.now() + 60_000; // far past the window again
    await beacon.sweepExternalBlocks();
    expect(attention).toHaveLength(2);
  });

  it('within the window (no stale) → no dead-letter', async () => {
    extBlock();
    clock = Date.now() + 100; // < 1s window
    await beacon.sweepExternalBlocks();
    expect(attention).toHaveLength(0);
  });

  it('absolute ceiling fires even with a fresh probe (false-liveness loop defeated)', async () => {
    build({ windowMs: 10_000_000, ceilingMs: 1000 }); // window huge, ceiling tiny
    const c = extBlock();
    tracker.recordProbe(c.id, { checked: 'CI', readinessSignal: 'green' }); // window fresh
    clock = Date.now() + 5000; // past the 1s ceiling
    await beacon.sweepExternalBlocks();
    expect(attention).toHaveLength(1);
    expect(events.find(e => e.id === c.id)).toBeTruthy();
  });

  it('feature off → no-op even when stale', async () => {
    featureState = { enabled: false, dryRun: false };
    extBlock();
    clock = Date.now() + 5000;
    await beacon.sweepExternalBlocks();
    expect(attention).toHaveLength(0);
  });

  it('dryRun → logs would-deadletter, does NOT raise Attention or mark', async () => {
    featureState = { enabled: true, dryRun: true };
    const c = extBlock();
    clock = Date.now() + 5000;
    await beacon.sweepExternalBlocks();
    expect(attention).toHaveLength(0);
    expect(events.some(e => e.name === 'aoft.would-deadletter-external')).toBe(true);
    expect(tracker.get(c.id)?.externalBlockDeadLetteredAt).toBeUndefined();
  });

  it('owner:user and blockedOn:none are never governed', async () => {
    tracker.record({ userRequest: 'a', agentResponse: 'b', type: 'one-time-action', owner: 'user', blockedOn: 'user-input', topicId: 7 });
    tracker.record({ userRequest: 'c', agentResponse: 'd', type: 'one-time-action', owner: 'agent', blockedOn: 'none', topicId: 7 });
    clock = Date.now() + 5_000_000;
    await beacon.sweepExternalBlocks();
    expect(attention).toHaveLength(0);
  });

  beforeEach(() => build());
});
