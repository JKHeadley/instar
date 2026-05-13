/**
 * Unit tests for IntentJournal — append-only intent declaration log.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { IntentJournal } from '../../src/remediation/IntentJournal.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('IntentJournal', () => {
  let tmpDir: string;
  let journal: IntentJournal;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'intent-journal-'));
    journal = new IntentJournal(tmpDir, { machineId: 'm-test' });
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmpDir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/IntentJournal.test.ts:afterEach',
    });
  });

  it('declareIntent appends to the journal with required fields', async () => {
    const before = Date.now();
    const persisted = await journal.declareIntent({
      attemptId: 'attempt-001',
      runbookId: 'node-abi-mismatch',
      signatureHash: 'sig-abc',
      blastRadius: 'process',
      intent: 'dispatch',
    });
    expect(persisted.intentId).toMatch(/^[0-9a-f-]{36}$/);
    expect(persisted.declaredAt).toBeGreaterThanOrEqual(before);
    expect(typeof persisted.monotonicTs).toBe('bigint');

    const journalPath = path.join(tmpDir, 'remediation', 'intent-journal-m-test.jsonl');
    expect(fs.existsSync(journalPath)).toBe(true);
    const lines = fs.readFileSync(journalPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.attemptId).toBe('attempt-001');
    expect(parsed.runbookId).toBe('node-abi-mismatch');
    expect(parsed.blastRadius).toBe('process');
    expect(parsed.intent).toBe('dispatch');
    // monotonicTs is serialized as decimal string.
    expect(typeof parsed.monotonicTs).toBe('string');
  });

  it('readSince returns entries declared after the cursor', async () => {
    const a = await journal.declareIntent({
      attemptId: 'a',
      runbookId: 'r1',
      signatureHash: 's1',
      blastRadius: 'process',
      intent: 'dispatch',
    });
    // Ensure the next declare lands at a strictly later wall-clock ms.
    await new Promise((r) => setTimeout(r, 5));
    const cursor = Date.now();
    await new Promise((r) => setTimeout(r, 5));
    const c = await journal.declareIntent({
      attemptId: 'c',
      runbookId: 'r3',
      signatureHash: 's3',
      blastRadius: 'fleet',
      intent: 'verify',
    });

    const since = await journal.readSince(cursor);
    expect(since.map((e) => e.attemptId)).toEqual(['c']);
    expect(since[0]?.intentId).toBe(c.intentId);

    const fromZero = await journal.readSince(0);
    expect(fromZero).toHaveLength(2);
    expect(fromZero[0]?.intentId).toBe(a.intentId);
  });

  it('concurrent declarations do not corrupt the file (atomic appends)', async () => {
    const N = 50;
    const promises: Promise<unknown>[] = [];
    for (let i = 0; i < N; i++) {
      promises.push(
        journal.declareIntent({
          attemptId: `attempt-${i}`,
          runbookId: 'rb',
          signatureHash: `sig-${i}`,
          blastRadius: 'process',
          intent: 'dispatch',
        })
      );
    }
    await Promise.all(promises);
    const all = await journal.readSince(0);
    expect(all).toHaveLength(N);
    // Every entry must parse cleanly and carry a distinct intentId.
    const ids = new Set(all.map((e) => e.intentId));
    expect(ids.size).toBe(N);
  });
});
