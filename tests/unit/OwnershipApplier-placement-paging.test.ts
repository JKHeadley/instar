/**
 * Tier-1 tests for the OwnershipApplier placement-PAGING fix.
 *
 * The bug (observed live 2026-09-05, topic 69507, ~4h deadlock): the applier read a
 * SINGLE page of the placement journal. A `topic-placement` query is ordered
 * EPOCH-DESCENDING and paged at the reader's cap (500), so one page is "the 500
 * HIGHEST-EPOCH rows", NOT the 500 most recent. A young topic (epoch 1-2) fell off
 * the bottom of page 1 once the journal accumulated 500 higher-epoch rows, was never
 * materialized on its owner machine, and every drain then refused `not-owner` — so a
 * pinned cross-machine transfer could never land, with no self-heal.
 *
 * The load-bearing test here (`materializes a topic whose epoch is BELOW the first
 * page's floor`) runs against the REAL CoherenceJournalReader over a REAL on-disk
 * journal, not a fake. A fake reader cannot reproduce this bug: the bug lives in the
 * INTERACTION between the reader's epoch-descending order and its limit clamp, so a
 * fake that hands back pages the test author chose would pass vacuously. The test also
 * ASSERTS the fixture is non-vacuous (page 1 genuinely excludes the topic) before
 * asserting the fix, so it fails loudly rather than silently if the reader's cap or
 * ordering ever changes.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { OwnershipApplier, type PlacementReader, type PlacementReaderEntry } from '../../src/core/OwnershipApplier.js';
import { LocalSessionOwnershipStore } from '../../src/core/LocalSessionOwnershipStore.js';
import { CoherenceJournalReader } from '../../src/core/CoherenceJournalReader.js';

const PEER = 'm_peer_studio';
const SELF = 'm_self_mini';

/** The young, low-epoch topic that the single-page read starved. */
const STARVED_TOPIC = 69507;
const STARVED_EPOCH = 2;

/**
 * Write a real placement journal shaped like production: SEVERAL peer stream files
 * (own + one per peer machine), each comfortably under the reader's per-file
 * newest-tail cap (500 entries), together totalling well OVER one page.
 *
 * The multi-file shape is load-bearing, not incidental. With a SINGLE file the
 * reader's per-file tail read (500 newest rows) truncates before the merge step, so
 * the older rows are unreadable no matter how the caller pages — that models a
 * different limit, not this bug. Production has one stream per machine (here: 384 +
 * 383 + 249 rows on 2026-09-05), each under the per-file cap, so every row reaches
 * the merge and the truncation happens at the epoch-ordered PAGE — which is exactly
 * the starvation this fix addresses.
 *
 * Rows are spread over `streams` files: `noisyTopics` topics at HIGH epochs, plus one
 * low-epoch topic owned by SELF written into the LAST stream. Returns the stateDir.
 */
function writeJournal(root: string, noisyTopics: number, rowsPerTopic: number, streams = 4, extraTopic = true): string {
  const stateDir = path.join(root, 'st');
  const jdir = path.join(stateDir, 'state', 'coherence-journal', 'peers');
  fs.mkdirSync(jdir, { recursive: true });

  const byStream: string[][] = Array.from({ length: streams }, () => []);
  let seq = 1;
  for (let t = 0; t < noisyTopics; t++) {
    for (let r = 0; r < rowsPerTopic; r++) {
      const machine = `${PEER}_${t % streams}`;
      // High epochs (>= 10) so every one of these outranks the starved topic.
      byStream[t % streams].push(JSON.stringify({
        seq: seq++,
        ts: new Date(Date.UTC(2026, 5, 1, 0, 0, seq % 60)).toISOString(),
        machine,
        kind: 'topic-placement',
        topic: 10000 + t,
        data: { owner: machine, epoch: 10 + r, reason: 'placed' },
      }));
    }
  }
  // The starved topic: the most RECENT row, but with the LOWEST epoch — exactly the
  // shape of a freshly-placed young conversation. Omitted (`extraTopic: false`) when a
  // test needs an EXACT row count, e.g. an exact multiple of the page size.
  const lastMachine = `${PEER}_${streams - 1}`;
  if (extraTopic) byStream[streams - 1].push(JSON.stringify({
    seq: seq++,
    ts: '2026-09-05T18:28:50.195Z',
    machine: lastMachine,
    kind: 'topic-placement',
    topic: STARVED_TOPIC,
    data: { owner: SELF, epoch: STARVED_EPOCH, reason: 'placed' },
  }));

  byStream.forEach((lines, i) => {
    // Guard the fixture's own premise: a stream over the per-file tail cap would be
    // truncated before the merge, silently changing what this test exercises.
    if (lines.length > 400) throw new Error(`fixture stream ${i} has ${lines.length} rows — over the per-file tail cap; add streams`);
    fs.writeFileSync(path.join(jdir, `${PEER}_${i}.topic-placement.jsonl`), lines.join('\n') + '\n');
  });
  return stateDir;
}

describe('OwnershipApplier — placement paging (low-epoch starvation fix)', () => {
  let root: string;
  let store: LocalSessionOwnershipStore;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'applier-paging-'));
    store = new LocalSessionOwnershipStore({ dir: path.join(root, 'own') });
  });
  afterEach(() => {
    try { SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'live-test-cleanup' }); } catch { /* best-effort */ }
  });

  it('materializes a topic whose epoch is BELOW the first page floor (THE regression)', () => {
    // 120 topics x 6 rows = 720 high-epoch rows — comfortably over the reader's 500 cap.
    const stateDir = writeJournal(root, 120, 6, 4); // 720 rows over 4 streams (180 each)
    const reader = new CoherenceJournalReader({ stateDir });

    // ── Non-vacuity guard ────────────────────────────────────────────────────
    // Prove the fixture actually reproduces the starvation: ONE page must NOT
    // contain the starved topic. If the reader's cap or ordering changes so that
    // page 1 now includes it, this fails HERE — telling us the test below would
    // have started passing for the wrong reason.
    const page1 = reader.query({ kind: 'topic-placement', limit: 1000 });
    expect(page1.entries.length).toBeGreaterThan(0);
    expect(page1.entries.some((e) => e.topic === STARVED_TOPIC)).toBe(false);

    const applier = new OwnershipApplier({ reader, store, selfMachineId: SELF });
    expect(store.read(String(STARVED_TOPIC))).toBeNull(); // the bug's starting state

    const res = applier.tick();

    // The USER-VISIBLE property first: the ownership record now exists. This is the
    // assertion that must break when the fix is removed — the drain reads exactly
    // this record, and its absence is what refused `not-owner` for four hours.
    // (Asserting the page COUNT first would let the test fail on the mechanism
    // instead of the outcome, and a paging walk that materialized nothing would
    // still look like a pass on that line.)
    const rec = store.read(String(STARVED_TOPIC));
    expect(rec?.ownerMachineId).toBe(SELF);
    expect(rec?.ownershipEpoch).toBe(STARVED_EPOCH);
    expect(rec?.status).toBe('active');
    // Then the mechanism that delivered it.
    expect(res.pagesScanned).toBeGreaterThan(1);
    expect(res.pagingUnavailable).toBeUndefined();
  });

  it('sees every topic in the journal, not just the first page worth', () => {
    const stateDir = writeJournal(root, 120, 6, 4); // 720 rows over 4 streams
    const reader = new CoherenceJournalReader({ stateDir });

    const onePageTopics = new Set(
      reader.query({ kind: 'topic-placement', limit: 1000 }).entries.map((e) => String(e.topic)),
    );
    const res = new OwnershipApplier({ reader, store, selfMachineId: SELF }).tick();

    // 120 noisy topics + the starved one.
    expect(res.examined).toBe(121);
    // And that is strictly more than a single page could ever have shown.
    expect(res.examined).toBeGreaterThan(onePageTopics.size);
  });

  it('terminates on a large journal without hitting the page ceiling', () => {
    const stateDir = writeJournal(root, 300, 8, 8); // 2400 rows over 8 streams (300 each)
    const reader = new CoherenceJournalReader({ stateDir });
    const res = new OwnershipApplier({ reader, store, selfMachineId: SELF }).tick();
    expect(res.examined).toBe(301);
    expect(res.pageCeilingHit).toBeUndefined();
    expect(res.pagesScanned).toBeLessThanOrEqual(40);
  });

  it('stops at maxScanPages and reports the ceiling rather than scanning unbounded', () => {
    const stateDir = writeJournal(root, 300, 8, 8);
    const reader = new CoherenceJournalReader({ stateDir });
    const res = new OwnershipApplier({ reader, store, selfMachineId: SELF, maxScanPages: 2 }).tick();
    expect(res.pagesScanned).toBe(2);
    expect(res.pageCeilingHit).toBe(true);
  });

  it('degrades to a single page — loudly — when the reader exposes no cursor', () => {
    // Back-compat: an older caller / narrow fake without cursorFor still works, but the
    // under-scan is REPORTED, never silent (a silent under-scan is the deadlock bug).
    const logs: string[] = [];
    const narrow: PlacementReader = {
      query: () => ({
        entries: [{ topic: 1, machine: PEER, data: { owner: SELF, epoch: 3 } }] as PlacementReaderEntry[],
      }),
    };
    const res = new OwnershipApplier({ reader: narrow, store, selfMachineId: SELF, logger: (m) => logs.push(m) }).tick();
    expect(res.pagesScanned).toBe(1);
    expect(res.pagingUnavailable).toBe(true);
    expect(logs.join('\n')).toMatch(/paging unavailable/i);
    // It still does its job for what it COULD see.
    expect(store.read('1')?.ownerMachineId).toBe(SELF);
  });

  it('does NOT flag the page ceiling when the budget exactly covered the journal', () => {
    // The distinguishing case (reviewer probe B): rows are an EXACT multiple of the page
    // size, so the walk consumes its whole budget AND finishes. Flagging that reports a
    // COMPLETE scan as "INCOMPLETE — some topics may not be materialized" in the very
    // observability surface this change adds.
    //
    // This case is precise on purpose: with any other row count the walk ends on an empty
    // page and never reaches the ceiling check at all, so a laxer fixture would pass no
    // matter how the flag is computed. 1000 rows over 4 streams (250 each, under the
    // per-file cap) = exactly 2 full pages of 500; the budget is 2.
    const stateDir = writeJournal(root, 1000, 1, 4, /* extraTopic */ false);
    const reader = new CoherenceJournalReader({ stateDir });
    const probe = reader.query({ kind: 'topic-placement', limit: 1000 });
    expect(probe.entries.length).toBe(500); // page size is exactly 500

    const res = new OwnershipApplier({ reader, store, selfMachineId: SELF, maxScanPages: 2 }).tick();
    expect(res.pagesScanned).toBe(2);
    expect(res.examined).toBe(1000);      // every topic seen — the scan WAS complete
    expect(res.pageCeilingHit).toBeUndefined(); // ...so it must not claim otherwise
  });

  it('still flags the ceiling when rows genuinely remain unread', () => {
    // The other side of that boundary — the flag must not be defanged into never firing.
    const stateDir = writeJournal(root, 1000, 1, 4, false);
    const reader = new CoherenceJournalReader({ stateDir });
    const res = new OwnershipApplier({ reader, store, selfMachineId: SELF, maxScanPages: 1 }).tick();
    expect(res.pagesScanned).toBe(1);
    expect(res.pageCeilingHit).toBe(true);
  });

  it('never scans zero pages for a non-finite maxScanPages', () => {
    // Reviewer probe C. NOTE ON WHAT THIS PROVES: with the ceiling checked as
    // `pagesScanned >= maxPages` at the TOP of the walk, `NaN` is already benign
    // (`0 >= NaN` is false), so the explicit `Number.isFinite` guard is defence-in-depth
    // rather than the load-bearing fix — removing the guard alone does NOT fail this test,
    // and it would be dishonest to claim otherwise. What this test DOES pin is the
    // observable contract: a bad bound must never silently scan nothing. It fails against
    // the original `for (page = 0; page < maxPages; page++)` form, where `page < NaN` is
    // false and the walk ran zero pages, materialized nothing, and logged nothing.
    const stateDir = writeJournal(root, 20, 2, 2);
    const reader = new CoherenceJournalReader({ stateDir });
    for (const bad of [NaN, undefined, Infinity, -Infinity]) {
      const s = new LocalSessionOwnershipStore({ dir: path.join(root, `own-${String(bad)}`) });
      const res = new OwnershipApplier({
        reader, store: s, selfMachineId: SELF, maxScanPages: bad as unknown as number,
      }).tick();
      expect(res.pagesScanned).toBeGreaterThan(0);
      expect(res.examined).toBeGreaterThan(0);
      expect(s.read(String(STARVED_TOPIC))?.ownerMachineId).toBe(SELF);
    }
    // A finite but nonsensical bound is clamped to at least one page, never zero.
    const s0 = new LocalSessionOwnershipStore({ dir: path.join(root, 'own-zero') });
    const r0 = new OwnershipApplier({ reader, store: s0, selfMachineId: SELF, maxScanPages: 0 }).tick();
    expect(r0.pagesScanned).toBe(1);
  });

  it('stops instead of looping forever when the cursor does not advance', () => {
    const logs: string[] = [];
    const stuck: PlacementReader = {
      query: () => ({
        entries: [{ topic: 2, machine: PEER, data: { owner: SELF, epoch: 4 }, ts: 't', seq: 1 }],
      }),
      cursorFor: () => 'SAME-CURSOR-EVERY-TIME',
    };
    const res = new OwnershipApplier({ reader: stuck, store, selfMachineId: SELF, logger: (m) => logs.push(m) }).tick();
    // First page advances to the cursor; the second page returns the SAME cursor → stop.
    expect(res.pagesScanned).toBeLessThanOrEqual(2);
    expect(logs.join('\n')).toMatch(/cursor did not advance/i);
  });

  it('stops the walk when cursor construction throws', () => {
    const logs: string[] = [];
    const throwing: PlacementReader = {
      query: () => ({
        entries: [{ topic: 3, machine: PEER, data: { owner: SELF, epoch: 4 }, ts: 't', seq: 1 }],
      }),
      cursorFor: () => { throw new Error('bad cursor'); },
    };
    const res = new OwnershipApplier({ reader: throwing, store, selfMachineId: SELF, logger: (m) => logs.push(m) }).tick();
    expect(res.pagesScanned).toBe(1);
    expect(logs.join('\n')).toMatch(/cursor build failed/i);
    // The page it DID read is still applied.
    expect(store.read('3')?.ownerMachineId).toBe(SELF);
  });
});
