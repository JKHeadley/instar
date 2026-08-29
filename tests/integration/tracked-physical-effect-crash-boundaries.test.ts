import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { InboundDeliveryStore } from '../../src/core/InboundDeliveryStore.js';
import { createPhysicalEffectLock } from '../../src/core/PhysicalEffectLock.js';
import { TrackedPhysicalEffectDispatcher } from '../../src/core/TrackedPhysicalEffectDispatcher.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const unix = process.platform === 'darwin' || process.platform === 'linux';
const describeUnix = unix ? describe : describe.skip;
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) SafeFsExecutor.safeRmSync(dir, {
    recursive: true, force: true,
    operation: 'tests/integration/tracked-physical-effect-crash-boundaries.test.ts:cleanup',
  });
});

describeUnix('tracked physical effect crash boundaries', () => {
  it('persists started-before-effect ambiguity and does not replay it after reopen', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracked-effect-crash-'));
    dirs.push(stateDir);
    const store = InboundDeliveryStore.open(stateDir);
    const delivery = store.prepare({ conversationId: 'c', incarnation: 'i', framework: 'codex-cli', envelope: 'body', hmacKey: 'k' });
    let physicalCalls = 0;
    const result = await new TrackedPhysicalEffectDispatcher(createPhysicalEffectLock(stateDir), store).dispatch({
      scope: 'c', conversationId: 'c', deliveryId: delivery.deliveryId, deadlineMs: Date.now() + 2_000,
      effect: () => { physicalCalls++; throw new Error('simulated process boundary after mutation began'); },
    });
    expect(result).toMatchObject({ status: 'effect-unknown' });
    expect(physicalCalls).toBe(1);

    const reopened = InboundDeliveryStore.open(stateDir);
    expect(reopened.get('c', delivery.deliveryId)?.transportState).toBe('effect-unknown');
    const replay = await new TrackedPhysicalEffectDispatcher(createPhysicalEffectLock(stateDir), reopened).dispatch({
      scope: 'c', conversationId: 'c', deliveryId: delivery.deliveryId, deadlineMs: Date.now() + 2_000,
      reconcile: async () => true,
      effect: () => { physicalCalls++; },
    });
    expect(replay).toMatchObject({ ok: false, status: 'refused', reason: 'durable-arm-failed' });
    expect(physicalCalls).toBe(1);
  });
});
