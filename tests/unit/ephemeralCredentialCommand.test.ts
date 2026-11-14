import { describe, expect, it } from 'vitest';
import { isEphemeralCredentialCommand } from '../../src/lifeline/ephemeralCredentialCommand.js';
import { MessageQueue } from '../../src/lifeline/MessageQueue.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('lifeline ephemeral credential queue guard', () => {
  it('recognizes desktop approvals even with whitespace or a malformed code', () => {
    expect(isEphemeralCredentialCommand('/desktop 3c54c9d1-10f2-4d90-a4da-57a23397ef2b 123456')).toBe(true);
    expect(isEphemeralCredentialCommand('  /desktop bad-code  ')).toBe(true);
    expect(isEphemeralCredentialCommand('/DESKTOP')).toBe(true);
    expect(isEphemeralCredentialCommand('/desktopography')).toBe(false);
    expect(isEphemeralCredentialCommand('please explain remote desktop')).toBe(false);
  });
  it('refuses to persist the approval command at the queue boundary', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-queue-'));
    try {
      const queue = new MessageQueue(dir);
      expect(queue.enqueue({ id: '1', topicId: 131439,
        text: '/desktop 3c54c9d1-10f2-4d90-a4da-57a23397ef2b 123456',
        fromUserId: 7812716706, fromFirstName: 'Operator', timestamp: new Date().toISOString() })).toBe(false);
      expect(queue.length).toBe(0);
      expect(fs.existsSync(path.join(dir, 'lifeline-queue.json'))).toBe(false);
    } finally {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'ephemeralCredentialCommand.test.ts cleanup' });
    }
  });
});
