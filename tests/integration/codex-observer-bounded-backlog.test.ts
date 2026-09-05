import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CodexDeliveryObserver } from '../../src/core/CodexDeliveryObserver.js';
import { InboundDeliveryStore } from '../../src/core/InboundDeliveryStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('Codex observer bounded backlog integration', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      SafeFsExecutor.safeRmSync(dir, {
        recursive: true,
        force: true,
        operation: 'tests/integration/codex-observer-bounded-backlog.test.ts',
      });
    }
  });

  it('advances valid JSONL prefixes across non-aligned byte budgets without false unknown', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-observer-backlog-'));
    dirs.push(dir);
    const rollout = path.join(dir, 'rollout.jsonl');
    fs.writeFileSync(rollout, JSON.stringify({ type: 'session_meta', payload: { id: 'busy-thread' } }) + '\n');
    const store = InboundDeliveryStore.open(dir);
    const envelope = 'busy-session-message';
    const row = store.prepare({
      conversationId: 'busy', deliveryId: 'd1', incarnation: 'inc', framework: 'codex-cli',
      envelope, hmacKey: 'key', ownerMachineId: 'studio', ownerEpoch: 1,
    });
    store.bindRolloutBaseline('busy', 'd1', rollout, 'busy-thread', fs.statSync(rollout).size);
    store.transition('busy', 'd1', 'prepared', 'dispatch-armed');
    store.transition('busy', 'd1', 'dispatch-armed', 'dispatch-started');
    store.transition('busy', 'd1', 'dispatch-started', 'dispatched');
    const event = (type: string, payload: Record<string, unknown>) => JSON.stringify({ type, payload }) + '\n';
    for (let index = 0; index < 8; index++) {
      fs.appendFileSync(rollout, event('turn_context', { type: 'turn_context', padding: 'x'.repeat(700) }));
    }
    const turnId = 'busy-turn';
    fs.appendFileSync(rollout,
      event('event_msg', { type: 'task_started', turn_id: turnId })
      + event('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: envelope }] })
      + event('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] })
      + event('event_msg', { type: 'task_complete', turn_id: turnId }));
    const observer = new CodexDeliveryObserver({
      store, hmacKey: 'key', resolveRolloutPath: () => rollout, resolveRolloutId: () => 'busy-thread',
      capturePane: () => null, maxBytesPerRow: 1_024, maxAggregateBytesPerSweep: 1_024,
    });
    for (let index = 0; index < 12 && store.get('busy', 'd1')?.transcriptState !== 'responded'; index++) {
      await observer.sweep();
      expect(store.get('busy', 'd1')?.eligibilityState).toBe('open');
    }
    expect(store.get('busy', row.deliveryId)).toMatchObject({
      transportState: 'consumed', transcriptState: 'responded', eligibilityState: 'open',
    });
    store.close();
  });
});
