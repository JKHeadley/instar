// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * The Codex rollout lookup must never walk the archive with per-file stats on
 * the main thread (2026-10-13 server-loop freeze: a missing Claude id cost one
 * stat per archived rollout — 286,984 — every minute). Both sides of every
 * boundary:
 *   - a PRESENT rollout is still found (dated id via its partition; undated id
 *     via the bounded scan or the async enumeration);
 *   - a MISSING id costs bounded work on a large archive, with the event loop
 *     responsive while the async remainder runs;
 *   - a miss is remembered briefly and forgotten correctly (new file, explicit
 *     invalidation, TTL).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  ASYNC_YIELD_EVERY_NAMES,
  ROLLOUT_ENUMERATED_MISS_TTL_MS,
  ROLLOUT_MISS_TTL_MS,
  SYNC_SCAN_NAME_BUDGET,
  findRolloutFile,
  findRolloutFileSync,
  invalidateRolloutLookup,
  pendingRolloutLookup,
  resetRolloutLookupState,
  rolloutLookupStats,
  rolloutPartitionHint,
} from '../../src/providers/adapters/openai-codex/observability/sessionPaths.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  buildLargeArchive,
  codexHomeOf,
  localPartitionOf,
  makeFakeHome,
  rolloutDir,
  startEventLoopLagProbe,
  uuidV4Like,
  uuidV7At,
  writeRollout,
} from '../helpers/codexArchiveFixture.js';

describe('rolloutPartitionHint', () => {
  it('maps a UUIDv7 to its local-date partition, then the next and previous day', () => {
    const when = new Date(2026, 8, 26, 8, 17, 14); // 2026-09-26 08:17:14 local
    const uuid = uuidV7At(when, 7);
    expect(rolloutPartitionHint(uuid)).toEqual(['2026/09/26', '2026/09/27', '2026/09/25']);
  });

  it('carries no hint for a v4-shaped (Claude) id or an empty id', () => {
    expect(rolloutPartitionHint(uuidV4Like(3))).toBeNull();
    expect(rolloutPartitionHint('ba7cbe23-6ce3-4eb1-a924-c6b2271bd0d4')).toBeNull();
    expect(rolloutPartitionHint('')).toBeNull();
    expect(rolloutPartitionHint('not-a-uuid')).toBeNull();
  });
});

describe('findRolloutFileSync — bounded, never a per-file stat walk', () => {
  let home: string;
  let codexHome: string;

  beforeEach(() => {
    home = makeFakeHome();
    codexHome = codexHomeOf(home);
    resetRolloutLookupState();
  });

  afterEach(() => {
    resetRolloutLookupState();
    vi.useRealTimers();
    SafeFsExecutor.safeRmSync(home, { recursive: true, force: true, operation: 'tests/unit/codexRolloutLookup-bounded.test.ts:cleanup' });
  });

  it('finds a present dated rollout through its partition hint — no scan, one confirming stat', () => {
    buildLargeArchive(home, { partitions: 6, perPartition: 50 });
    const when = new Date(2026, 9, 10, 9, 30, 0);
    const uuid = uuidV7At(when, 4242);
    const expected = writeRollout(home, uuid, localPartitionOf(when));

    expect(findRolloutFileSync(uuid, codexHome)).toBe(expected);
    const s = rolloutLookupStats();
    expect(s.hintedPartitionReads).toBeGreaterThanOrEqual(1);
    expect(s.hintedPartitionReads).toBeLessThanOrEqual(3);
    expect(s.syncDirectoryReads).toBe(0);
    expect(s.asyncEnumerations).toBe(0);
    expect(s.statCalls).toBeLessThanOrEqual(2);

    // Second call answers from the exact known path.
    expect(findRolloutFileSync(uuid, codexHome)).toBe(expected);
    expect(rolloutLookupStats().positiveHits).toBe(1);
  });

  it('finds a dated rollout that landed in the neighbouring day partition (midnight edge)', () => {
    const when = new Date(2026, 9, 10, 23, 59, 30);
    const uuid = uuidV7At(when, 99);
    const nextDay = new Date(when);
    nextDay.setDate(nextDay.getDate() + 1);
    const expected = writeRollout(home, uuid, localPartitionOf(nextDay));
    expect(findRolloutFileSync(uuid, codexHome)).toBe(expected);
    expect(rolloutLookupStats().syncDirectoryReads).toBe(0);
  });

  it('a MISSING dated id on a large archive: honest miss, only its own partitions read, async remainder settles the miss', async () => {
    buildLargeArchive(home, { partitions: 12, perPartition: 400 });
    const uuid = uuidV7At(new Date(2026, 9, 5, 12, 0, 0), 1);

    const t0 = performance.now();
    expect(findRolloutFileSync(uuid, codexHome)).toBeNull();
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(500);

    const s = rolloutLookupStats();
    expect(s.hintedPartitionReads).toBeLessThanOrEqual(3);
    expect(s.syncDirectoryReads).toBe(0);
    expect(s.statCalls).toBeLessThanOrEqual(3); // generation stamp only — never per file
    expect(s.syncNamesScanned).toBeLessThanOrEqual(3 * 400);

    const pending = pendingRolloutLookup(uuid, codexHome);
    expect(pending).not.toBeNull();
    expect(await pending).toBeNull();
    expect(rolloutLookupStats().asyncEnumerations).toBe(1);

    // The miss is remembered: a repeat costs no directory scan.
    const before = rolloutLookupStats();
    expect(findRolloutFileSync(uuid, codexHome)).toBeNull();
    const after = rolloutLookupStats();
    expect(after.negativeHits).toBe(before.negativeHits + 1);
    expect(after.hintedPartitionReads).toBe(before.hintedPartitionReads);
    expect(after.syncDirectoryReads).toBe(before.syncDirectoryReads);
    expect(pendingRolloutLookup(uuid, codexHome)).toBeNull();
  });

  it('a MISSING undated (Claude v4) id on an archive beyond the sync budget: bounded sync scan, no per-file stat, bounded async remainder', async () => {
    const perPartition = 1000;
    const partitions = Math.ceil(SYNC_SCAN_NAME_BUDGET / perPartition) + 5; // 25 partitions ≈ 25k names > budget
    buildLargeArchive(home, { partitions, perPartition });
    const uuid = uuidV4Like(77);

    const t0 = performance.now();
    expect(findRolloutFileSync(uuid, codexHome)).toBeNull();
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(1000);

    const s = rolloutLookupStats();
    expect(s.syncBudgetExhausted).toBe(1);
    expect(s.syncNamesScanned).toBeLessThanOrEqual(SYNC_SCAN_NAME_BUDGET + perPartition);
    expect(s.syncDirectoryReads).toBeLessThan(partitions);
    expect(s.statCalls).toBeLessThanOrEqual(3);

    const pending = pendingRolloutLookup(uuid, codexHome);
    expect(pending).not.toBeNull();
    expect(await pending).toBeNull();
    const done = rolloutLookupStats();
    expect(done.asyncEnumerations).toBe(1);
    expect(done.asyncDirectoryReads).toBe(partitions);
    expect(done.asyncNamesScanned).toBeGreaterThanOrEqual(partitions * perPartition);
    expect(done.statCalls).toBeLessThanOrEqual(5);
  });

  it('a PRESENT undated rollout beyond the sync budget: first call is an honest miss, the async enumeration finds it, the next call answers exactly', async () => {
    const perPartition = 1000;
    const partitions = Math.ceil(SYNC_SCAN_NAME_BUDGET / perPartition) + 5;
    const archive = buildLargeArchive(home, { partitions, perPartition });
    const uuid = uuidV4Like(5);
    const expected = writeRollout(home, uuid, archive.partitions[0]); // the OLDEST partition — past the budget

    expect(findRolloutFileSync(uuid, codexHome)).toBeNull();
    const found = await pendingRolloutLookup(uuid, codexHome);
    expect(found).toBe(expected);
    expect(findRolloutFileSync(uuid, codexHome)).toBe(expected);
    expect(rolloutLookupStats().positiveHits).toBe(1);
  });

  it('a PRESENT undated rollout within the sync budget is found synchronously on the first call', () => {
    buildLargeArchive(home, { partitions: 4, perPartition: 100 });
    const uuid = uuidV4Like(11);
    const expected = writeRollout(home, uuid, '2026/04/01');
    expect(findRolloutFileSync(uuid, codexHome)).toBe(expected);
    expect(rolloutLookupStats().asyncEnumerations).toBe(0);
    expect(rolloutLookupStats().syncBudgetExhausted).toBe(0);
  });

  it('the event loop stays responsive while the async enumeration covers a large archive', async () => {
    const perPartition = 1000;
    const partitions = Math.ceil(SYNC_SCAN_NAME_BUDGET / perPartition) + 5;
    buildLargeArchive(home, { partitions, perPartition });
    expect(ASYNC_YIELD_EVERY_NAMES).toBeLessThanOrEqual(5000);
    const uuid = uuidV4Like(123);

    expect(findRolloutFileSync(uuid, codexHome)).toBeNull();
    const probe = startEventLoopLagProbe(5);
    await pendingRolloutLookup(uuid, codexHome);
    const worstLagMs = probe.stop();
    expect(worstLagMs).toBeLessThan(250);
  });

  it('forgets a remembered miss when the rollout appears in the newest partition (generation stamp)', async () => {
    buildLargeArchive(home, { partitions: 3, perPartition: 20, end: new Date(2026, 9, 12, 12, 0, 0) });
    const when = new Date(2026, 9, 12, 13, 0, 0); // same day as the newest partition
    const uuid = uuidV7At(when, 8);
    expect(findRolloutFileSync(uuid, codexHome)).toBeNull();
    await pendingRolloutLookup(uuid, codexHome);
    expect(findRolloutFileSync(uuid, codexHome)).toBeNull(); // cached miss
    expect(rolloutLookupStats().negativeHits).toBe(1);

    // Writing the file bumps the newest partition's mtime → the miss is stale.
    await new Promise((r) => setTimeout(r, 15));
    const expected = writeRollout(home, uuid, localPartitionOf(when), '2026-10-12T13-00-00');
    expect(findRolloutFileSync(uuid, codexHome)).toBe(expected);
  });

  it('forgets a remembered miss on explicit invalidation (a rollout written into an older partition)', async () => {
    buildLargeArchive(home, { partitions: 3, perPartition: 20, end: new Date(2026, 9, 12, 12, 0, 0) });
    const when = new Date(2026, 9, 10, 13, 0, 0); // an OLDER partition — the generation stamp cannot see it
    const uuid = uuidV7At(when, 9);
    expect(findRolloutFileSync(uuid, codexHome)).toBeNull();
    await pendingRolloutLookup(uuid, codexHome);
    const expected = writeRollout(home, uuid, localPartitionOf(when), '2026-10-10T13-00-00');
    expect(findRolloutFileSync(uuid, codexHome)).toBeNull(); // still the cached miss
    invalidateRolloutLookup(uuid, codexHome);
    expect(findRolloutFileSync(uuid, codexHome)).toBe(expected);
  });

  it('forgets a remembered miss after the TTL — a cheap-path miss after 1 minute, a fully enumerated miss after 5', async () => {
    buildLargeArchive(home, { partitions: 2, perPartition: 10, end: new Date(2026, 9, 12, 12, 0, 0) });
    const when = new Date(2026, 9, 11, 9, 0, 0);
    const uuid = uuidV7At(when, 10);
    expect(findRolloutFileSync(uuid, codexHome)).toBeNull();
    await pendingRolloutLookup(uuid, codexHome); // the enumeration covered the archive → the longer TTL
    const expected = writeRollout(home, uuid, localPartitionOf(when), '2026-10-11T09-00-00');
    expect(findRolloutFileSync(uuid, codexHome)).toBeNull();
    expect(ROLLOUT_ENUMERATED_MISS_TTL_MS).toBeGreaterThan(ROLLOUT_MISS_TTL_MS);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + ROLLOUT_MISS_TTL_MS + 1);
    expect(findRolloutFileSync(uuid, codexHome)).toBeNull(); // still inside the enumerated-miss TTL
    vi.setSystemTime(Date.now() + ROLLOUT_ENUMERATED_MISS_TTL_MS + 1);
    expect(findRolloutFileSync(uuid, codexHome)).toBe(expected);
  });

  it('an async lookup joins an enumeration the sync path started instead of repeating its cheap-path miss', async () => {
    const perPartition = 1000;
    const partitions = Math.ceil(SYNC_SCAN_NAME_BUDGET / perPartition) + 5;
    const archive = buildLargeArchive(home, { partitions, perPartition });
    const uuid = uuidV4Like(66);
    const expected = writeRollout(home, uuid, archive.partitions[0]); // past the sync budget
    expect(findRolloutFileSync(uuid, codexHome)).toBeNull(); // cheap-path miss recorded, enumeration started
    expect(await findRolloutFile(uuid, codexHome)).toBe(expected); // joined, not "absent for 60 s"
    expect(rolloutLookupStats().asyncEnumerations).toBe(1);
  });

  it('drops a remembered hit whose file is gone instead of returning a stale path', () => {
    const when = new Date(2026, 9, 9, 9, 0, 0);
    const uuid = uuidV7At(when, 12);
    const file = writeRollout(home, uuid, localPartitionOf(when));
    expect(findRolloutFileSync(uuid, codexHome)).toBe(file);
    SafeFsExecutor.safeUnlinkSync(file, { operation: 'tests/unit/codexRolloutLookup-bounded.test.ts:stale-hit' });
    expect(findRolloutFileSync(uuid, codexHome)).toBeNull();
  });

  it('a flat (non-partitioned) layout still resolves through the bounded Dirent walk', () => {
    const dir = path.join(codexHome, 'sessions', 'misc', 'nested');
    fs.mkdirSync(dir, { recursive: true });
    const uuid = uuidV4Like(21);
    const file = path.join(dir, `rollout-2026-01-01T00-00-00-${uuid}.jsonl`);
    fs.writeFileSync(file, '{}\n');
    expect(findRolloutFileSync(uuid, codexHome)).toBe(file);
    expect(rolloutLookupStats().statCalls).toBeLessThanOrEqual(2);
  });

  it('does not match a non-rollout file that contains the uuid, and ignores a directory named like a rollout', () => {
    const uuid = uuidV4Like(31);
    const dir = rolloutDir(home, '2026/05/30');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `notes-${uuid}.txt`), 'x');
    fs.mkdirSync(path.join(dir, `rollout-2026-05-30T00-00-00-${uuid}.jsonl`));
    expect(findRolloutFileSync(uuid, codexHome)).toBeNull();
  });

  it('returns null fast with no reads when $CODEX_HOME/sessions does not exist (pure Claude agent)', () => {
    expect(findRolloutFileSync(uuidV4Like(1), codexHome)).toBeNull();
    expect(findRolloutFileSync('', codexHome)).toBeNull();
    const s = rolloutLookupStats();
    expect(s.hintedPartitionReads + s.syncDirectoryReads + s.asyncEnumerations).toBe(0);
  });
});

describe('findRolloutFile (async) — filename-first, yielding, cache-settling', () => {
  let home: string;
  let codexHome: string;

  beforeEach(() => {
    home = makeFakeHome();
    codexHome = codexHomeOf(home);
    resetRolloutLookupState();
  });

  afterEach(() => {
    resetRolloutLookupState();
    SafeFsExecutor.safeRmSync(home, { recursive: true, force: true, operation: 'tests/unit/codexRolloutLookup-bounded.test.ts:cleanup-async' });
  });

  it('finds a dated rollout via its partition and an undated one via enumeration; a miss is null', async () => {
    const archive = buildLargeArchive(home, { partitions: 5, perPartition: 200 });
    const when = new Date(2026, 9, 10, 9, 30, 0);
    const dated = uuidV7At(when, 55);
    const datedFile = writeRollout(home, dated, localPartitionOf(when));
    const undated = uuidV4Like(56);
    const undatedFile = writeRollout(home, undated, archive.partitions[0]);

    expect(await findRolloutFile(dated, codexHome)).toBe(datedFile);
    expect(rolloutLookupStats().asyncEnumerations).toBe(0);
    expect(await findRolloutFile(undated, codexHome)).toBe(undatedFile);
    expect(rolloutLookupStats().asyncEnumerations).toBe(1);
    expect(await findRolloutFile(uuidV4Like(999), codexHome)).toBeNull();
    expect(await findRolloutFile('', codexHome)).toBeNull();
    // Every lookup statted at most the files it matched (+ generation stamps).
    expect(rolloutLookupStats().statCalls).toBeLessThan(10);
  });

  it('concurrent lookups for the same missing id share one enumeration', async () => {
    buildLargeArchive(home, { partitions: 4, perPartition: 300 });
    const uuid = uuidV4Like(404);
    const results = await Promise.all([findRolloutFile(uuid, codexHome), findRolloutFile(uuid, codexHome), findRolloutFile(uuid, codexHome)]);
    expect(results).toEqual([null, null, null]);
    expect(rolloutLookupStats().asyncEnumerations).toBe(1);
  });

  it('a sync lookup after an async hit answers from the exact known path', async () => {
    const archive = buildLargeArchive(home, { partitions: 3, perPartition: 50 });
    const uuid = uuidV4Like(7);
    const file = writeRollout(home, uuid, archive.partitions[0]);
    expect(await findRolloutFile(uuid, codexHome)).toBe(file);
    const before = rolloutLookupStats();
    expect(findRolloutFileSync(uuid, codexHome)).toBe(file);
    const after = rolloutLookupStats();
    expect(after.positiveHits).toBe(before.positiveHits + 1);
    expect(after.syncDirectoryReads).toBe(before.syncDirectoryReads);
  });
});
