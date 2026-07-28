// safe-fs-allow: test fixture cleanup uses fs.rmSync on tmp dirs only.
/**
 * Tier-1 tests for the ownership epoch floor (live-matrix finding #7,
 * 2026-06-06): the SessionOwnershipRegistry is in-memory, so a server restart
 * resets epochs to 0 for quiet sessions — and the coherence journal's
 * (topic, epoch) op-key then silently DEDUPES the re-placed session's fresh
 * placement entries as replays, leaving the durable evidence pointing at the
 * WRONG machine (observed live: transfer answered placedOwnership:true while
 * the journal kept naming the previous target).
 *
 * The fix: cas() consults an optional epochFloorOf seam (the newest JOURNALED
 * epoch for the session) so post-restart epochs stay monotonic, and the
 * in-memory store's fast-forward accepts any MONOTONIC advance (like a git
 * fast-forward push, which may advance several commits) rather than exactly +1.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { applyOwnershipAction } from '../../src/core/SessionOwnership.js';
import { SessionOwnershipRegistry, InMemorySessionOwnershipStore } from '../../src/core/SessionOwnershipRegistry.js';
import { CoherenceJournal } from '../../src/core/CoherenceJournal.js';
import { CoherenceJournalReader } from '../../src/core/CoherenceJournalReader.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const MACHINE = 'm_laptop';
const TARGET = 'm_mini';
const TOPIC = 77901;

function makeRegistry(over: Partial<ConstructorParameters<typeof SessionOwnershipRegistry>[0]> = {}) {
  const seen = new Set<string>();
  return new SessionOwnershipRegistry({
    store: new InMemorySessionOwnershipStore(),
    seenNonce: (k) => seen.has(k),
    recordNonce: (k) => seen.add(k),
    ...over,
  });
}

describe('SessionOwnership FSM — epochFloor (finding #7)', () => {
  it('place on a never-seen record starts ABOVE the floor', () => {
    const t = applyOwnershipAction(null, { type: 'place', machineId: TARGET }, { sessionKey: 'k', nonce: 'n', now: 1, epochFloor: 5 });
    expect(t.ok).toBe(true);
    if (t.ok) expect(t.next.ownershipEpoch).toBe(6);
  });

  it('no floor → behavior unchanged (epoch 1)', () => {
    const t = applyOwnershipAction(null, { type: 'place', machineId: TARGET }, { sessionKey: 'k', nonce: 'n', now: 1 });
    expect(t.ok).toBe(true);
    if (t.ok) expect(t.next.ownershipEpoch).toBe(1);
  });

  it('an existing record already past the floor keeps normal +1 sequencing', () => {
    const placed = applyOwnershipAction(null, { type: 'place', machineId: TARGET }, { sessionKey: 'k', nonce: 'n1', now: 1, epochFloor: 3 });
    if (!placed.ok) throw new Error('place failed');
    const claimed = applyOwnershipAction(placed.next, { type: 'claim', machineId: TARGET }, { sessionKey: 'k', nonce: 'n2', now: 2, epochFloor: 3 });
    expect(claimed.ok).toBe(true);
    if (claimed.ok) expect(claimed.next.ownershipEpoch).toBe(5); // 4 → 5, floor no longer binding
  });
});

describe('SessionOwnershipRegistry — epochFloorOf seam (finding #7)', () => {
  it('place+claim land ABOVE the floor through the strict store CAS', () => {
    const reg = makeRegistry({ epochFloorOf: () => 2 });
    const p = reg.cas({ type: 'place', machineId: TARGET }, { sessionKey: String(TOPIC), sender: MACHINE, nonce: 'p1' });
    expect(p.ok).toBe(true);
    if (p.ok) expect(p.record.ownershipEpoch).toBe(3);
    const c = reg.cas({ type: 'claim', machineId: TARGET }, { sessionKey: String(TOPIC), sender: MACHINE, nonce: 'c1' });
    expect(c.ok).toBe(true);
    if (c.ok) expect(c.record.ownershipEpoch).toBe(4);
  });

  it('a THROWING floor reads as 0 — the CAS never blocks on the journal reader', () => {
    const reg = makeRegistry({ epochFloorOf: () => { throw new Error('reader exploded'); } });
    const p = reg.cas({ type: 'place', machineId: TARGET }, { sessionKey: String(TOPIC), sender: MACHINE, nonce: 'p1' });
    expect(p.ok).toBe(true);
    if (p.ok) expect(p.record.ownershipEpoch).toBe(1);
  });
});

describe('finding #7 regression — restart no longer dedupes fresh placement evidence', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'epoch-floor-'));
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/ownership-epoch-floor.test.ts' });
  });

  function streamLines(): Array<{ data: { owner: string; epoch: number } }> {
    const f = path.join(tmpDir, 'state', 'coherence-journal', `${MACHINE}.topic-placement.jsonl`);
    if (!fs.existsSync(f)) return [];
    return fs.readFileSync(f, 'utf-8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  }

  it('pre-restart epochs 1+2 journaled; post-restart place+claim journal 3+4 instead of being deduped away', () => {
    const journal = new CoherenceJournal({
      stateDir: tmpDir,
      machineId: MACHINE,
      flushIntervalMs: 1_000_000, // manual flush
      artifactRoots: [tmpDir],
    });
    journal.open();
    const floorOf = (sk: string): number => {
      const topicNum = Number(sk);
      if (!Number.isFinite(topicNum)) return 0;
      const reader = new CoherenceJournalReader({ stateDir: tmpDir });
      const newest = reader.query({ kind: 'topic-placement', topic: topicNum, limit: 1 }).entries[0];
      const e = (newest?.data as { epoch?: unknown } | undefined)?.epoch;
      return typeof e === 'number' && Number.isFinite(e) ? e : 0;
    };

    // ── Server lifetime 1: quiet-topic transfer lands place+claim, journaled.
    const reg1 = makeRegistry({ epochFloorOf: floorOf });
    for (const [action, nonce] of [[{ type: 'place' as const, machineId: TARGET }, 'p1'], [{ type: 'claim' as const, machineId: TARGET }, 'c1']] as const) {
      const r = reg1.cas(action, { sessionKey: String(TOPIC), sender: MACHINE, nonce });
      if (!r.ok) throw new Error('lifetime-1 CAS failed');
      journal.emitPlacement(TOPIC, { owner: r.record.ownerMachineId, epoch: r.record.ownershipEpoch, reason: 'user-move' });
    }
    journal.flush();
    expect(streamLines().map((l) => l.data.epoch)).toEqual([1, 2]);

    // ── "Restart": fresh registry (in-memory store wiped), SAME journal.
    const reg2 = makeRegistry({ epochFloorOf: floorOf });
    for (const [action, nonce] of [[{ type: 'place' as const, machineId: MACHINE }, 'p2'], [{ type: 'claim' as const, machineId: MACHINE }, 'c2']] as const) {
      const r = reg2.cas(action, { sessionKey: String(TOPIC), sender: MACHINE, nonce });
      if (!r.ok) throw new Error('lifetime-2 CAS failed');
      journal.emitPlacement(TOPIC, { owner: r.record.ownerMachineId, epoch: r.record.ownershipEpoch, reason: 'user-move' });
    }
    journal.flush();

    // The regression: WITHOUT the floor these re-used epochs 1+2 and the
    // journal op-key window silently dropped both entries (evidence kept
    // naming the OLD machine). With it: four entries, newest names MACHINE.
    const lines = streamLines();
    expect(lines.map((l) => l.data.epoch)).toEqual([1, 2, 3, 4]);
    expect(lines[lines.length - 1].data.owner).toBe(MACHINE);
    journal.close();
  });
});
