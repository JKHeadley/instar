import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { TopicMemory } from '../../src/memory/TopicMemory.js';

describe('TopicMemory forwarded provenance for verified goal sources', () => {
  let dir: string;
  let memory: TopicMemory;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'topic-memory-forwarded-'));
    memory = new TopicMemory(dir);
    await memory.open();
  });

  afterEach(() => {
    memory.close();
    SafeFsExecutor.safeRmSync(dir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/topic-memory-forwarded-provenance.test.ts:cleanup',
    });
  });

  it('round-trips explicit false, true, and legacy unknown through SQLite and restart', async () => {
    memory.insertMessages([
      {
        messageId: 1,
        topicId: 458,
        text: 'genuine operator message',
        fromUser: true,
        timestamp: '2026-07-27T00:00:00.000Z',
        sessionName: null,
        telegramUserId: 10,
        forwarded: false,
      },
      {
        messageId: 2,
        topicId: 458,
        text: 'forwarded content',
        fromUser: true,
        timestamp: '2026-07-27T00:01:00.000Z',
        sessionName: null,
        telegramUserId: 10,
        forwarded: true,
      },
      {
        messageId: 3,
        topicId: 458,
        text: 'legacy provenance unknown',
        fromUser: true,
        timestamp: '2026-07-27T00:02:00.000Z',
        sessionName: null,
        telegramUserId: 10,
      },
    ]);
    memory.close();
    memory = new TopicMemory(dir);
    await memory.open();

    const read = memory.getMessagesSince(458, '2026-07-26T00:00:00.000Z', 10);

    expect(read.complete).toBe(true);
    expect(read.messages.map((row) => row.forwarded)).toEqual([false, true, undefined]);
  });

  it('marks bounded history reads incomplete instead of claiming silent coverage', () => {
    for (let i = 0; i < 3; i++) {
      memory.insertMessage({
        messageId: i + 1,
        topicId: 458,
        text: `message ${i}`,
        fromUser: true,
        timestamp: `2026-07-27T00:0${i}:00.000Z`,
        sessionName: null,
        telegramUserId: 10,
        forwarded: false,
      });
    }

    const read = memory.getMessagesSince(458, '2026-07-26T00:00:00.000Z', 2);

    expect(read.messages).toHaveLength(2);
    expect(read.complete).toBe(false);
  });
});
