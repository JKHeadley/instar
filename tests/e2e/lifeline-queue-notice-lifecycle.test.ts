import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { MessageQueue } from '../../src/lifeline/MessageQueue.js';
import { buildQueueDeliveryNotices } from '../../src/lifeline/queueDeliveryNotice.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    SafeFsExecutor.safeRmSync(dir, {
      recursive: true,
      force: true,
      operation: 'tests/e2e/lifeline-queue-notice-lifecycle.test.ts',
    });
  }
});

describe('lifeline queued-message notice lifecycle', () => {
  it('persists queue causes and emits truthful replay notices after restart', () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-queue-notice-'));
    dirs.push(stateDir);
    const queue = new MessageQueue(stateDir);
    const base = { topicId: 42, text: 'hello', fromUserId: 7, fromFirstName: 'Justin', timestamp: new Date().toISOString() };
    queue.enqueue({ ...base, id: 'tg-1', queueReason: 'healthy-forward-failed' });
    queue.enqueue({ ...base, id: 'tg-2', queueReason: 'server-unhealthy' });

    const restored = new MessageQueue(stateDir).peek();
    expect(restored.map(message => message.queueReason)).toEqual(['healthy-forward-failed', 'server-unhealthy']);

    const counts = restored.reduce((value, message) => {
      if (message.queueReason === 'server-unhealthy') value.outage++;
      else if (message.queueReason === 'healthy-forward-failed') value.delayedHandoff++;
      else if (message.queueReason === undefined) value.legacyUnknown++;
      return value;
    }, { outage: 0, delayedHandoff: 0, legacyUnknown: 0 });
    expect(buildQueueDeliveryNotices(counts)).toEqual([
      '✓ Server recovered — your queued message has been delivered.',
      '✓ Your delayed message has now been delivered to the session.',
    ]);
  });
});
