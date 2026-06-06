// safe-git-allow: test fixture cleanup uses fs.rmSync on tmp dirs only.
// safe-fs-allow: test fixture cleanup uses fs.rmSync on tmp dirs only.
/**
 * Tier-1 unit tests for PendingPullLedger (P2.2) — WORKING-SET-HANDOFF-SPEC §3.4.
 *
 * Covers: persist + restart-proof reload; idempotent file_ on
 * (topic,epoch,nominee); supersede clears ALL lower-epoch records across
 * nominees (never strands a sibling); TTL expiry surfaces once via onExpired;
 * breaker (attempt cap) excludes records from pendingForPeer + a NEW epoch is
 * a NEW record; CONCURRENT mutate() drops no record (the single-writer
 * funnel, the topic-flood-#3 lesson); corrupt ledger → quarantined + one
 * onCorrupt notice + fresh — NEVER silently read as empty.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  PendingPullLedger,
  PENDING_PULLS_FILENAME,
  DEFAULT_ATTEMPT_CAP,
} from '../../src/core/PendingPullLedger.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-pull-ledger-test-'));
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

function ledgerFile(): string {
  return path.join(tmpDir, 'state', 'coherence-journal', PENDING_PULLS_FILENAME);
}

describe('PendingPullLedger — durability + idempotency', () => {
  it('persists records and reloads them in a NEW instance (restart-proof)', async () => {
    const a = new PendingPullLedger({ stateDir: tmpDir });
    await a.file_({ topic: 13481, epoch: 3, nominee: 'm_mini', reason: 'peer-offline' });
    const b = new PendingPullLedger({ stateDir: tmpDir });
    const records = await b.all();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ topic: 13481, epoch: 3, nominee: 'm_mini' });
  });

  it('file_ is idempotent on (topic,epoch,nominee) — attempts/createdAt survive a re-file', async () => {
    const l = new PendingPullLedger({ stateDir: tmpDir });
    await l.file_({ topic: 1, epoch: 1, nominee: 'm_a', reason: 'peer-offline' });
    await l.recordAttempt(1, 1, 'm_a');
    await l.file_({ topic: 1, epoch: 1, nominee: 'm_a', reason: 'busy-exhausted' });
    const records = await l.all();
    expect(records).toHaveLength(1);
    expect(records[0].attempts).toBe(1); // survived the re-file
    expect(records[0].reason).toBe('busy-exhausted'); // reason refreshed
  });

  it('clear removes exactly one record', async () => {
    const l = new PendingPullLedger({ stateDir: tmpDir });
    await l.file_({ topic: 1, epoch: 1, nominee: 'm_a', reason: 'peer-offline' });
    await l.file_({ topic: 1, epoch: 1, nominee: 'm_b', reason: 'peer-offline' });
    await l.clear(1, 1, 'm_a');
    const records = await l.all();
    expect(records).toHaveLength(1);
    expect(records[0].nominee).toBe('m_b');
  });
});

describe('PendingPullLedger — supersession + TTL + breaker', () => {
  it('supersede clears ALL lower-epoch records across nominees, never strands a sibling', async () => {
    const l = new PendingPullLedger({ stateDir: tmpDir });
    await l.file_({ topic: 7, epoch: 2, nominee: 'm_a', reason: 'peer-offline' });
    await l.file_({ topic: 7, epoch: 2, nominee: 'm_b', reason: 'peer-offline' }); // sibling, same epoch
    await l.file_({ topic: 7, epoch: 1, nominee: 'm_c', reason: 'peer-offline' }); // older epoch
    await l.file_({ topic: 8, epoch: 1, nominee: 'm_a', reason: 'peer-offline' }); // other topic
    await l.supersede(7, 3);
    const records = await l.all();
    expect(records).toHaveLength(1); // ONLY the other topic survives
    expect(records[0].topic).toBe(8);
  });

  it('TTL sweep expires old records, surfacing each ONCE via onExpired', async () => {
    let nowMs = Date.parse('2026-06-06T00:00:00Z');
    const expired: number[] = [];
    const l = new PendingPullLedger({
      stateDir: tmpDir,
      ttlDays: 7,
      now: () => new Date(nowMs),
      onExpired: (r) => expired.push(r.topic),
    });
    await l.file_({ topic: 1, epoch: 1, nominee: 'm_a', reason: 'peer-offline' });
    nowMs += 8 * 24 * 60 * 60 * 1000; // 8 days
    await l.file_({ topic: 2, epoch: 1, nominee: 'm_a', reason: 'peer-offline' }); // fresh
    const swept = await l.sweepExpired();
    expect(swept.map((r) => r.topic)).toEqual([1]);
    expect(expired).toEqual([1]);
    expect((await l.all()).map((r) => r.topic)).toEqual([2]);
    // A second sweep finds nothing — surfaced once, then gone.
    expect(await l.sweepExpired()).toHaveLength(0);
  });

  it('breaker: a record at the attempt cap is excluded from pendingForPeer; a NEW epoch is a NEW record', async () => {
    const l = new PendingPullLedger({ stateDir: tmpDir, attemptCap: 2 });
    await l.file_({ topic: 1, epoch: 1, nominee: 'm_a', reason: 'peer-offline' });
    await l.recordAttempt(1, 1, 'm_a');
    await l.recordAttempt(1, 1, 'm_a');
    expect(await l.pendingForPeer('m_a')).toHaveLength(0); // exhausted
    // A new epoch files a NEW record — the old breaker never suppresses it.
    await l.file_({ topic: 1, epoch: 2, nominee: 'm_a', reason: 'peer-offline' });
    const pending = await l.pendingForPeer('m_a');
    expect(pending).toHaveLength(1);
    expect(pending[0].epoch).toBe(2);
  });

  it('pendingForPeer orders most-recent-epoch-first (the drain order)', async () => {
    const l = new PendingPullLedger({ stateDir: tmpDir });
    await l.file_({ topic: 1, epoch: 1, nominee: 'm_a', reason: 'peer-offline' });
    await l.file_({ topic: 2, epoch: 5, nominee: 'm_a', reason: 'peer-offline' });
    await l.file_({ topic: 3, epoch: 3, nominee: 'm_a', reason: 'peer-offline' });
    const pending = await l.pendingForPeer('m_a');
    expect(pending.map((r) => r.epoch)).toEqual([5, 3, 1]);
  });
});

describe('PendingPullLedger — the single-writer funnel (topic-flood-#3 lesson)', () => {
  it('CONCURRENT mutate() calls drop no record', async () => {
    const l = new PendingPullLedger({ stateDir: tmpDir });
    const N = 25;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        l.file_({ topic: i, epoch: 1, nominee: `m_${i % 3}`, reason: 'peer-offline' }),
      ),
    );
    const records = await l.all();
    expect(records).toHaveLength(N);
    // Reload from disk in a fresh instance — the PERSISTED state lost nothing.
    const reloaded = await new PendingPullLedger({ stateDir: tmpDir }).all();
    expect(reloaded).toHaveLength(N);
  });

  it('interleaved file_/clear/supersede serialize without losing unrelated records', async () => {
    const l = new PendingPullLedger({ stateDir: tmpDir });
    await Promise.all([
      l.file_({ topic: 1, epoch: 1, nominee: 'm_a', reason: 'peer-offline' }),
      l.file_({ topic: 2, epoch: 1, nominee: 'm_b', reason: 'peer-offline' }),
      l.supersede(1, 2), // races the first file_
      l.file_({ topic: 3, epoch: 1, nominee: 'm_c', reason: 'peer-offline' }),
    ]);
    const topics = (await l.all()).map((r) => r.topic).sort();
    // Whatever the race order, topics 2 and 3 MUST survive.
    expect(topics).toContain(2);
    expect(topics).toContain(3);
  });
});

describe('PendingPullLedger — corrupt-parse posture (never silent-empty)', () => {
  it('a corrupt ledger is quarantined, onCorrupt fires once, a fresh ledger starts', async () => {
    fs.mkdirSync(path.dirname(ledgerFile()), { recursive: true });
    fs.writeFileSync(ledgerFile(), '{ this is not json');
    const corruptCalls: string[] = [];
    const l = new PendingPullLedger({
      stateDir: tmpDir,
      onCorrupt: (p) => corruptCalls.push(p),
    });
    const records = await l.all();
    expect(records).toEqual([]);
    expect(corruptCalls).toHaveLength(1); // surfaced, not silent
    // The corrupt bytes were preserved aside, not destroyed.
    const dir = path.dirname(ledgerFile());
    const quarantined = fs.readdirSync(dir).filter((n) => n.includes('.corrupt-'));
    expect(quarantined).toHaveLength(1);
    // The ledger works after recovery.
    await l.file_({ topic: 1, epoch: 1, nominee: 'm_a', reason: 'peer-offline' });
    expect(await l.all()).toHaveLength(1);
  });

  it('a wrong-shape ledger (valid JSON, wrong schema) also quarantines', async () => {
    fs.mkdirSync(path.dirname(ledgerFile()), { recursive: true });
    fs.writeFileSync(ledgerFile(), JSON.stringify({ version: 99, nope: true }));
    const corruptCalls: string[] = [];
    const l = new PendingPullLedger({ stateDir: tmpDir, onCorrupt: (p) => corruptCalls.push(p) });
    expect(await l.all()).toEqual([]);
    expect(corruptCalls).toHaveLength(1);
  });

  it('an ABSENT ledger is genuinely empty — no quarantine, no notice', async () => {
    const corruptCalls: string[] = [];
    const l = new PendingPullLedger({ stateDir: tmpDir, onCorrupt: (p) => corruptCalls.push(p) });
    expect(await l.all()).toEqual([]);
    expect(corruptCalls).toHaveLength(0);
  });

  it('default attempt cap is exported sanely', () => {
    expect(DEFAULT_ATTEMPT_CAP).toBeGreaterThan(0);
  });
});
