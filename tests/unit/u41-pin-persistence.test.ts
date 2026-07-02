/**
 * U4.1 — Pin Persistence (docs/specs/u4-1-pin-persistence.md §4, Tier 1).
 *
 * The spec-named unit tests for the graduated+hardened WS1.3 pin machinery:
 *  - unpin-emits-tombstone (§2B — buildTopicPinTombstone finally has a caller)
 *  - pin-mutation-stamps-one-hlc-on-both-local-set-and-journal-emit (R-r2)
 *  - stale-replicated-pin-never-resurrects-after-unpin (defect 2)
 *  - hlc-orders-pin-vs-tombstone (skew-proof, never wall-clock)
 *  - future-skewed-pin-hlc-is-quarantined-never-merged-never-immortal (R-r2-1)
 *  - skew-quarantine-is-sticky-across-clock-advance (R-r3-2 / R-r4-1, both arms)
 *  - fold-byte-guard-truncates-newest-first-and-escalates-loudly (R-r3-3)
 *  - corrupt-pin-store-quarantines-loudly-never-wipes (defect 3)
 *  - pinnedBy-resolves-operator-binding-else-agent-kind (§2F storage half)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { TopicPlacementPinStore } from '../../src/core/TopicPlacementPinStore.js';
import { TopicPinSkewQuarantine } from '../../src/core/TopicPinSkewQuarantine.js';
import { TopicPinFoldView, poolReferenceFromCapacities, type PinFoldReader } from '../../src/core/TopicPinFoldView.js';
import { setPinWithOneHlc, clearPinWithTombstone, type PinMutationEmitter } from '../../src/core/TopicPinMutation.js';
import { compareHlc, buildTopicPinPut, buildTopicPinTombstone, TOPIC_PIN_KIND_REGISTRATION, TOPIC_PIN_RECORD_KIND } from '../../src/core/TopicPinReplicatedStore.js';
import { LeaseAcquisitionTrigger } from '../../src/core/LeaseAcquisitionTrigger.js';
import { JournalSyncApplier } from '../../src/core/JournalSyncApplier.js';
import { ReplicatedKindRegistry } from '../../src/core/ReplicatedRecordEnvelope.js';
import { GUARD_MANIFEST } from '../../src/monitoring/guardManifest.js';
import type { JournalEntry } from '../../src/core/CoherenceJournal.js';
import type { HlcTimestamp } from '../../src/core/HybridLogicalClock.js';
import type { PinFoldResult } from '../../src/core/CoherenceJournalReader.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'u41-pin-')); });
afterEach(() => { try { SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/unit/u41-pin-persistence.test.ts cleanup' }); } catch { /* best-effort */ } });

const NOW = 1_700_000_000_000;

/** A fake emitter mirroring ReplicatedRecordEmitter's contract (synchronous
 *  build with a ticked HLC; dark gate short-circuits before the build). */
function fakeEmitter(opts: { dark?: boolean; node?: string } = {}) {
  let logical = 0;
  const emitted: Array<{ store: string; recordKey: string; data: Record<string, unknown> }> = [];
  const emitter: PinMutationEmitter = {
    emit(store, recordKey, build) {
      if (opts.dark) return; // store disabled → build never runs (no HLC minted)
      if (typeof recordKey !== 'string' || !recordKey) return;
      const hlc: HlcTimestamp = { physical: NOW, logical: logical++, node: opts.node ?? 'm_a' };
      const data = build(hlc, opts.node ?? 'm_a', undefined);
      if (data) emitted.push({ store, recordKey, data });
    },
  };
  return { emitter, emitted };
}

/** A pin-record envelope datum as the fold reads it off the journal. */
function pinPut(topic: number, machine: string, hlc: HlcTimestamp, origin = hlc.node): Record<string, unknown> {
  return { topic, preferredMachine: machine, pinned: true, recordKey: String(topic), hlc, op: 'put', origin };
}
function pinTombstone(topic: number, hlc: HlcTimestamp, origin = hlc.node): Record<string, unknown> {
  return { deletedAt: new Date(hlc.physical).toISOString(), recordKey: String(topic), hlc, op: 'delete', origin };
}

/** A scripted fold reader: each call to foldPinRecords returns the next batch. */
function scriptedReader(batches: Array<Partial<PinFoldResult> & { entries: PinFoldResult['entries'] }>): PinFoldReader {
  let i = 0;
  return {
    foldPinRecords() {
      const b = batches[Math.min(i, batches.length - 1)];
      i++;
      return {
        entries: b.entries,
        offsets: b.offsets ?? {},
        scannedBytes: b.scannedBytes ?? 0,
        skippedCorrupt: b.skippedCorrupt ?? 0,
        truncated: b.truncated ?? false,
        unfolded: b.unfolded ?? [],
      };
    },
  };
}

function foldView(reader: PinFoldReader, opts: {
  quarantine?: TopicPinSkewQuarantine;
  now?: () => number;
  onSkew?: (rec: { key: string; hlc: HlcTimestamp; origin: string }) => void;
  onTrunc?: (u: Array<{ file: string; fromByte: number; toByte: number }>) => void;
  onRecovered?: () => void;
} = {}) {
  const quarantine = opts.quarantine ?? new TopicPinSkewQuarantine({ filePath: path.join(tmp, 'quarantine.json') });
  const view = new TopicPinFoldView({
    reader,
    quarantine,
    selfNode: () => 'm_self',
    now: opts.now ?? (() => NOW),
    ...(opts.onSkew ? { onSkewQuarantined: opts.onSkew } : {}),
    ...(opts.onTrunc ? { onFoldTruncated: opts.onTrunc } : {}),
    ...(opts.onRecovered ? { onFoldRecovered: opts.onRecovered } : {}),
  });
  return { view, quarantine };
}

// ── §2B — the one-HLC mutation funnel ────────────────────────────────────────

describe('pin-mutation-stamps-one-hlc-on-both-local-set-and-journal-emit (R-r2)', () => {
  it('setPinWithOneHlc mints ONE HLC: the journal PUT and the local set carry the SAME stamp', () => {
    const store = new TopicPlacementPinStore({ filePath: path.join(tmp, 'pins.json') });
    const { emitter, emitted } = fakeEmitter();
    const r = setPinWithOneHlc({ pinStore: store, emitter }, '13481', 'm_mini', true);
    expect(r.hlc).toBeTruthy();
    expect(emitted).toHaveLength(1);
    expect(emitted[0].data.hlc).toEqual(r.hlc); // journal stamp
    expect(store.get('13481')?.hlc).toEqual(r.hlc); // local stamp — the SAME one
    expect(store.get('13481')?.preferredMachine).toBe('m_mini');
  });

  it('a DARK emitter (ws13PinReplicate off) mints no HLC — local set proceeds exactly as today', () => {
    const store = new TopicPlacementPinStore({ filePath: path.join(tmp, 'pins.json') });
    const { emitter, emitted } = fakeEmitter({ dark: true });
    const r = setPinWithOneHlc({ pinStore: store, emitter }, '700', 'm_a', true);
    expect(r.hlc).toBeUndefined();
    expect(emitted).toHaveLength(0);
    const pin = store.get('700');
    expect(pin?.preferredMachine).toBe('m_a');
    expect(pin?.hlc).toBeUndefined(); // the reconciler's documented updatedAt fallback covers it
  });
});

describe('unpin-emits-tombstone (§2B — the defect-2 fix)', () => {
  it('the tombstone carries the topic recordKey, op:delete, and a fresh HLC ordering after the put', () => {
    const store = new TopicPlacementPinStore({ filePath: path.join(tmp, 'pins.json') });
    const { emitter, emitted } = fakeEmitter();
    setPinWithOneHlc({ pinStore: store, emitter }, '13481', 'm_mini', true);
    const r = clearPinWithTombstone({ pinStore: store, emitter }, '13481');
    expect(r.hadPin).toBe(true);
    expect(store.get('13481')).toBeNull(); // local cleared
    expect(emitted).toHaveLength(2);
    const tomb = emitted[1];
    expect(tomb.data.op).toBe('delete');
    expect(tomb.recordKey).toBe('13481');
    // The tombstone's HLC strictly follows the put's (HLC order, never wall-clock).
    expect(compareHlc(tomb.data.hlc as HlcTimestamp, emitted[0].data.hlc as HlcTimestamp)).toBeGreaterThan(0);
  });

  it('unpin with a dark emitter still clears locally (single-machine no-op posture)', () => {
    const store = new TopicPlacementPinStore({ filePath: path.join(tmp, 'pins.json') });
    const { emitter } = fakeEmitter({ dark: true });
    setPinWithOneHlc({ pinStore: store, emitter }, '9', 'm_a', true);
    const r = clearPinWithTombstone({ pinStore: store, emitter }, '9');
    expect(r.hadPin).toBe(true);
    expect(r.hlc).toBeUndefined();
    expect(store.get('9')).toBeNull();
  });
});

// ── §2C — the fold: tombstone ordering, skew gate, sticky quarantine ─────────

describe('hlc-orders-pin-vs-tombstone + stale-replicated-pin-never-resurrects-after-unpin', () => {
  it('a NEWER tombstone beats an older PUT: the fold resolves to NO pin (unpin sticks)', () => {
    const put = pinPut(13481, 'm_laptop', { physical: NOW - 60_000, logical: 0, node: 'm_a' });
    const tomb = pinTombstone(13481, { physical: NOW - 30_000, logical: 0, node: 'm_a' });
    const { view } = foldView(scriptedReader([{ entries: [
      { data: put, origin: 'm_a', source: 'replica', machineId: 'm_a' },
      { data: tomb, origin: 'm_a', source: 'replica', machineId: 'm_a' },
    ] }]));
    view.refresh();
    expect(view.pins().size).toBe(0);
  });

  it('a STALE replicated PUT arriving AFTER the tombstone cannot resurrect the pin (order-independent)', () => {
    const put = pinPut(13481, 'm_laptop', { physical: NOW - 60_000, logical: 0, node: 'm_a' });
    const tomb = pinTombstone(13481, { physical: NOW - 30_000, logical: 0, node: 'm_a' });
    const { view } = foldView(scriptedReader([
      { entries: [{ data: tomb, origin: 'm_a', source: 'replica', machineId: 'm_a' }] },
      // The stale PUT lands on a LATER incremental fold (e.g. a late peer replica).
      { entries: [{ data: put, origin: 'm_b', source: 'replica', machineId: 'm_b' }] },
    ]));
    view.refresh();
    expect(view.pins().size).toBe(0);
    view.refresh(); // the stale PUT arrives
    expect(view.pins().size).toBe(0); // tombstone won by HLC — never resurrected
  });

  it('a newer re-pin (same key, higher HLC) supersedes the tombstone — the documented re-pin model', () => {
    const tomb = pinTombstone(700, { physical: NOW - 30_000, logical: 0, node: 'm_a' });
    const rePin = pinPut(700, 'm_mini', { physical: NOW - 10_000, logical: 0, node: 'm_a' });
    const { view } = foldView(scriptedReader([{ entries: [
      { data: tomb, origin: 'm_a', source: 'replica', machineId: 'm_a' },
      { data: rePin, origin: 'm_a', source: 'replica', machineId: 'm_a' },
    ] }]));
    view.refresh();
    expect(view.pins().get(700)?.preferredMachine).toBe('m_mini');
  });
});

describe('future-skewed-pin-hlc-is-quarantined-never-merged-never-immortal (R-r2-1)', () => {
  it('a record past the maxDriftMs clamp is excluded from the fold, quarantined on disk, and raises the deduped item', () => {
    const skewed = pinPut(13481, 'm_evil', { physical: NOW + 10 * 60_000, logical: 0, node: 'm_fast' }); // +10min > 5min clamp
    const honest = pinTombstone(13481, { physical: NOW - 1000, logical: 0, node: 'm_a' });
    const raised: string[] = [];
    const { view, quarantine } = foldView(
      scriptedReader([{ entries: [
        { data: honest, origin: 'm_a', source: 'replica', machineId: 'm_a' },
        { data: skewed, origin: 'm_fast', source: 'replica', machineId: 'm_fast' },
      ] }]),
      { onSkew: (rec) => raised.push(rec.origin) },
    );
    view.refresh();
    // Never merged: the tombstone (honest) is the winner; no pin resolves.
    expect(view.pins().size).toBe(0);
    // Quarantined durably, on disk.
    expect(quarantine.all()).toHaveLength(1);
    expect(quarantine.all()[0].origin).toBe('m_fast');
    expect(raised).toEqual(['m_fast']); // the ONE escalation (per newly-quarantined record)
    // And it cannot beat a tombstone: an operator tombstone minted during
    // quarantine WINS over the quarantined poison record by construction.
    const laterTomb = pinTombstone(13481, { physical: NOW + 1000, logical: 0, node: 'm_a' });
    const view2 = new TopicPinFoldView({
      reader: scriptedReader([{ entries: [
        { data: skewed, origin: 'm_fast', source: 'replica', machineId: 'm_fast' },
        { data: laterTomb, origin: 'm_a', source: 'replica', machineId: 'm_a' },
      ] }]),
      quarantine,
      selfNode: () => 'm_self',
      now: () => NOW,
    });
    view2.refresh();
    expect(view2.pins().size).toBe(0);
  });

  it('a re-read of an already-quarantined record does NOT re-raise (episode dedupe at the record grain)', () => {
    const skewed = pinPut(1, 'm_evil', { physical: NOW + 10 * 60_000, logical: 0, node: 'm_fast' });
    const raised: string[] = [];
    const { view } = foldView(
      scriptedReader([
        { entries: [{ data: skewed, origin: 'm_fast', source: 'replica', machineId: 'm_fast' }] },
        { entries: [{ data: skewed, origin: 'm_fast', source: 'replica', machineId: 'm_fast' }] },
      ]),
      { onSkew: (rec) => raised.push(rec.origin) },
    );
    view.refresh();
    view.refresh();
    expect(raised).toHaveLength(1);
  });
});

describe('skew-quarantine-is-sticky-across-clock-advance (R-r3-2 / R-r4-1)', () => {
  const skewDelta = 10 * 60_000; // +10min
  const skewedHlc: HlcTimestamp = { physical: NOW + skewDelta, logical: 0, node: 'm_fast' };
  const skewed = pinPut(13481, 'm_evil', skewedHlc);
  // The operator unpins DURING the quarantine window (an honest tombstone with a
  // LOWER hlc than the poison — the exact record the resurrection would beat).
  const quarantineWindowTombstone = pinTombstone(13481, { physical: NOW + 1000, logical: 0, node: 'm_a' });

  it('the exclusion HOLDS after the clock advances past the skew delta — the poison never un-quarantines', () => {
    let now = NOW;
    const q = new TopicPinSkewQuarantine({ filePath: path.join(tmp, 'q.json') });
    const batches = scriptedReader([
      { entries: [
        { data: skewed, origin: 'm_fast', source: 'replica', machineId: 'm_fast' },
        { data: quarantineWindowTombstone, origin: 'm_a', source: 'replica', machineId: 'm_a' },
      ] },
      // Later folds re-surface the SAME poison record (e.g. a full re-fold after restart).
      { entries: [
        { data: skewed, origin: 'm_fast', source: 'replica', machineId: 'm_fast' },
        { data: quarantineWindowTombstone, origin: 'm_a', source: 'replica', machineId: 'm_a' },
      ] },
    ]);
    const view = new TopicPinFoldView({ reader: batches, quarantine: q, selfNode: () => 'm_self', now: () => now });
    view.refresh();
    expect(view.pins().size).toBe(0);
    expect(q.has('13481', skewedHlc)).toBe(true);
    // Wall time advances PAST the skew delta: a fresh point-in-time gate would now
    // ACCEPT the record and it would WIN compareHlc over the tombstone — the exact
    // retroactive resurrection R-r3-2 forbids. A fresh fold view (restart) proves
    // the durable set is what holds, not in-memory state.
    now = NOW + skewDelta + 60_000;
    const restarted = new TopicPinSkewQuarantine({ filePath: path.join(tmp, 'q.json') });
    const view2 = new TopicPinFoldView({ reader: batches, quarantine: restarted, selfNode: () => 'm_self', now: () => now });
    view2.refresh();
    expect(view2.pins().size).toBe(0); // still excluded — the tombstone stands
    expect(restarted.has('13481', skewedHlc)).toBe(true);
  });

  it('the ack-then-clock-advance arm: dismissing the NOTIFICATION clears nothing — the record stays excluded', () => {
    const q = new TopicPinSkewQuarantine({ filePath: path.join(tmp, 'q2.json') });
    q.add({ key: '13481', hlc: skewedHlc, origin: 'm_fast' });
    // "Operator ack" = the attention item closes. There is NO quarantine API on
    // that path by construction — the store still excludes after any amount of
    // clock progress. Only supersession or the explicit re-admit clears.
    expect(q.has('13481', skewedHlc)).toBe(true);
    // Explicit re-admit is its own deliberate action and DOES clear:
    expect(q.readmit('13481', skewedHlc)).toBe(true);
    expect(q.has('13481', skewedHlc)).toBe(false);
    expect(q.readmit('13481', skewedHlc)).toBe(false); // idempotent honesty
  });

  it('honest supersession clears the sticky entry: a NEWER honest record makes it dead by ordering', () => {
    const q = new TopicPinSkewQuarantine({ filePath: path.join(tmp, 'q3.json') });
    q.add({ key: '13481', hlc: skewedHlc, origin: 'm_fast' });
    // A newer honest record BELOW the poison's hlc does NOT prune (the poison would still win the compare)…
    expect(q.pruneSuperseded('13481', { physical: NOW + 2000, logical: 0, node: 'm_a' })).toBe(0);
    expect(q.has('13481', skewedHlc)).toBe(true);
    // …but once an honest record passes the gate ABOVE it (wall time caught up),
    // the quarantined entry is dead by ordering anyway → pruned.
    expect(q.pruneSuperseded('13481', { physical: NOW + skewDelta + 1, logical: 0, node: 'm_a' })).toBe(1);
    expect(q.has('13481', skewedHlc)).toBe(false);
  });
});

// ── §3.4 pool-relative skew reference (fb-1d51e996-0a3) ──────────────────────
// The live-reproduced 2026-07-02 defect: nothing supplied the fold view's
// poolReference dep, so receive()'s reference — max(last.physical,
// poolReference ?? 0), NEVER the bare now() — froze at the fold clock's
// construction seed (server boot) on a quiet stream. Pins are rare operator
// events, so the stream is almost always quiet: every honest record authored
// more than maxDriftMs (5min) after boot was falsely quarantined as
// "skew-ahead", STICKILY. The original suite missed it because every harness
// constructed a fresh clock right next to its records.
describe('pool-relative skew reference — quiet streams accept honest records (fb-1d51e996-0a3)', () => {
  const BOOT = NOW;
  const QUIET = 46 * 60_000; // the live evidence: a 46-min-stale boot reference

  it('an honest record authored 46min after the fold-clock seed, on a QUIET stream, is ACCEPTED (the frozen-reference false quarantine)', () => {
    // Refresh #1 at boot seeds the fold clock (empty stream — quiet). Wall time
    // then advances 46 minutes with NO accepted records, and the Mini's honest
    // unpin-era record arrives. Without the moving now() floor the reference
    // stays frozen at BOOT and this honest record is stickily quarantined —
    // exactly the Laptop-quarantines-the-Mini live evidence.
    let now = BOOT;
    const q = new TopicPinSkewQuarantine({ filePath: path.join(tmp, 'quiet.json') });
    const honest = pinPut(30223, 'm_mini', { physical: BOOT + QUIET - 1000, logical: 0, node: 'm_mini' });
    const view = new TopicPinFoldView({
      reader: scriptedReader([
        { entries: [] }, // boot fold — quiet stream, clock seeds at BOOT
        { entries: [{ data: honest, origin: 'm_mini', source: 'replica', machineId: 'm_mini' }] },
      ]),
      quarantine: q,
      selfNode: () => 'm_self',
      now: () => now,
    });
    view.refresh(); // boot
    now = BOOT + QUIET;
    view.refresh(); // the honest record, 46min later
    expect(view.pins().get(30223)?.preferredMachine).toBe('m_mini'); // ACCEPTED
    expect(q.all()).toHaveLength(0); // never quarantined
  });

  it('author-side: the own fold accepts its OWN fresh record after a quiet period (the Mini-quarantines-its-own-PUT arm)', () => {
    let now = BOOT;
    const q = new TopicPinSkewQuarantine({ filePath: path.join(tmp, 'own.json') });
    const ownPut = pinPut(900, 'm_self', { physical: BOOT + QUIET, logical: 0, node: 'm_self' });
    const view = new TopicPinFoldView({
      reader: scriptedReader([
        { entries: [] },
        { entries: [{ data: ownPut, origin: 'm_self', source: 'own', machineId: 'm_self' }] },
      ]),
      quarantine: q,
      selfNode: () => 'm_self',
      now: () => now,
    });
    view.refresh();
    now = BOOT + QUIET + 5_000;
    view.refresh();
    expect(view.pins().get(900)?.preferredMachine).toBe('m_self');
    expect(q.all()).toHaveLength(0);
  });

  it('a genuinely future-skewed record — beyond maxDriftMs of the MOVING reference — is still REJECTED + stickily quarantined (no regression of the real protection)', () => {
    let now = BOOT;
    const q = new TopicPinSkewQuarantine({ filePath: path.join(tmp, 'poison.json') });
    const raised: string[] = [];
    const poison = pinPut(13481, 'm_evil', { physical: BOOT + QUIET + 10 * 60_000, logical: 0, node: 'm_fast' });
    const view = new TopicPinFoldView({
      reader: scriptedReader([
        { entries: [] },
        { entries: [{ data: poison, origin: 'm_fast', source: 'replica', machineId: 'm_fast' }] },
      ]),
      quarantine: q,
      selfNode: () => 'm_self',
      now: () => now,
      onSkewQuarantined: (rec) => raised.push(rec.origin),
    });
    view.refresh();
    now = BOOT + QUIET; // the reference MOVES to here — the poison is still +10min beyond it
    view.refresh();
    expect(view.pins().size).toBe(0);
    expect(q.has('13481', { physical: BOOT + QUIET + 10 * 60_000, logical: 0, node: 'm_fast' })).toBe(true);
    expect(raised).toEqual(['m_fast']);
  });

  it('the wired poolReference dep raises the floor when the LOCAL clock lags (§3.4 pool-relative: a slow receiver must not quarantine an ahead-but-honest peer)', () => {
    // The receiver's own clock NEVER advances past boot (a lagging local NTP).
    // The pool observed fresher clock-OK peer heartbeat stamps; the dep carries
    // them, so the honest ahead-of-local record is accepted.
    const q = new TopicPinSkewQuarantine({ filePath: path.join(tmp, 'lag.json') });
    const honest = pinPut(30223, 'm_mini', { physical: BOOT + QUIET - 1000, logical: 0, node: 'm_mini' });
    const view = new TopicPinFoldView({
      reader: scriptedReader([
        { entries: [] },
        { entries: [{ data: honest, origin: 'm_mini', source: 'replica', machineId: 'm_mini' }] },
      ]),
      quarantine: q,
      selfNode: () => 'm_self',
      now: () => BOOT, // frozen local clock — the dep is what saves the record
      poolReference: () => BOOT + QUIET,
    });
    view.refresh();
    view.refresh();
    expect(view.pins().get(30223)?.preferredMachine).toBe('m_mini');
    expect(q.all()).toHaveLength(0);
  });

  it('a FAULTY poolReference dep degrades to the moving now() floor — never back to the frozen reference, never a fold fault', () => {
    let now = BOOT;
    const q = new TopicPinSkewQuarantine({ filePath: path.join(tmp, 'faulty.json') });
    const honest = pinPut(30223, 'm_mini', { physical: BOOT + QUIET - 1000, logical: 0, node: 'm_mini' });
    const view = new TopicPinFoldView({
      reader: scriptedReader([
        { entries: [] },
        { entries: [{ data: honest, origin: 'm_mini', source: 'replica', machineId: 'm_mini' }] },
      ]),
      quarantine: q,
      selfNode: () => 'm_self',
      now: () => now,
      poolReference: () => { throw new Error('registry fault'); },
    });
    view.refresh();
    now = BOOT + QUIET;
    view.refresh(); // must not throw; the now() floor stands
    expect(view.pins().get(30223)?.preferredMachine).toBe('m_mini');
    expect(q.all()).toHaveLength(0);
  });

  it('status().skewReference exposes the LIVE gate floor and MOVES with time (frozen-reference diagnosability)', () => {
    let now = BOOT;
    const { view } = foldView(scriptedReader([{ entries: [] }]), { now: () => now });
    expect(view.status().skewReference).toBe(BOOT);
    now = BOOT + QUIET;
    expect(view.status().skewReference).toBe(BOOT + QUIET); // moves — never frozen at a seed
  });

  describe('poolReferenceFromCapacities (the production sourcing helper)', () => {
    it('degenerate case — no peers: now() alone (the pool is self)', () => {
      expect(poolReferenceFromCapacities(NOW, [])).toBe(NOW);
    });

    it('a fresher clock-OK peer heartbeat self-stamp raises the floor above a slow local now()', () => {
      const ahead = NOW + 4 * 60_000;
      expect(poolReferenceFromCapacities(NOW, [
        { clockSkewStatus: 'ok', selfReportedLastSeen: new Date(ahead).toISOString() },
        { clockSkewStatus: 'ok', selfReportedLastSeen: new Date(NOW - 60_000).toISOString() },
      ])).toBe(ahead);
    });

    it('a SUSPECT-clocked peer never raises the floor (the registry skew FSM already distrusts it)', () => {
      const ahead = NOW + 10 * 60_000;
      for (const status of ['suspect-clock-removed', 'divergence-detected-once']) {
        expect(poolReferenceFromCapacities(NOW, [
          { clockSkewStatus: status, selfReportedLastSeen: new Date(ahead).toISOString() },
        ])).toBe(NOW);
      }
    });

    it('an older stamp never LOWERS the floor; malformed/absent stamps are ignored', () => {
      expect(poolReferenceFromCapacities(NOW, [
        { clockSkewStatus: 'ok', selfReportedLastSeen: new Date(NOW - 3_600_000).toISOString() },
        { clockSkewStatus: 'ok', selfReportedLastSeen: 'not-a-date' },
        { clockSkewStatus: 'ok' },
      ])).toBe(NOW);
    });
  });

  it('wiring integrity: the server.ts fold-view construction supplies the poolReference dep from the registry helper', () => {
    // The defect was precisely an UNWIRED dep (the fold view honored it; nothing
    // supplied it) — so the construction site itself is load-bearing. Source-grep
    // pattern per this repo's wiring-integrity precedent.
    const src = fs.readFileSync(path.resolve(__dirname, '../../src/commands/server.ts'), 'utf-8');
    const ctor = src.slice(src.indexOf('const pinFoldView = new TopicPinFoldView({'));
    const block = ctor.slice(0, ctor.indexOf('});') + 3);
    expect(block).toContain('poolReference: () =>');
    expect(block).toContain('poolReferenceFromCapacities(Date.now(), machinePoolRegistry?.getCapacities()');
  });
});

describe('fold-byte-guard-truncates-newest-first-and-escalates-loudly (R-r3-3)', () => {
  it('a breach raises the item naming the unfolded ranges ONCE per episode; a clean fold closes it', () => {
    const truncs: Array<Array<{ file: string; fromByte: number; toByte: number }>> = [];
    let recovered = 0;
    const unfolded = [{ file: '/j/m_a.topic-pin-record.1.jsonl', fromByte: 0, toByte: 4096 }];
    const { view } = foldView(
      scriptedReader([
        { entries: [], truncated: true, unfolded },
        { entries: [], truncated: true, unfolded }, // same open episode — no re-raise
        { entries: [] }, // full fold within budget — episode closes
        { entries: [], truncated: true, unfolded }, // a NEW breach → a NEW episode
      ]),
      { onTrunc: (u) => truncs.push(u), onRecovered: () => recovered++ },
    );
    view.refresh();
    view.refresh();
    expect(truncs).toHaveLength(1);
    expect(truncs[0]).toEqual(unfolded); // the escalation NAMES the unfolded ranges
    view.refresh();
    expect(recovered).toBe(1);
    view.refresh();
    expect(truncs).toHaveLength(2); // new episode re-raises
  });
});

// ── §2C — corrupt pin store ──────────────────────────────────────────────────

describe('corrupt-pin-store-quarantines-loudly-never-wipes (defect 3)', () => {
  it('a corrupt pin file is renamed ASIDE (preserved), reported via onCorrupt, and resolves to unknown', () => {
    const file = path.join(tmp, 'pins.json');
    fs.writeFileSync(file, '{ this is not json');
    const reports: Array<{ aside: string; error: string }> = [];
    const store = new TopicPlacementPinStore({
      filePath: file,
      onCorrupt: (aside, error) => reports.push({ aside, error }),
    });
    expect(store.all()).toEqual({}); // resolve-to-unknown
    expect(reports).toHaveLength(1);
    expect(fs.existsSync(reports[0].aside)).toBe(true); // PRESERVED aside…
    expect(fs.readFileSync(reports[0].aside, 'utf-8')).toBe('{ this is not json'); // …byte-for-byte
    expect(fs.existsSync(file)).toBe(false); // canonical path vacated, not overwritten
    // A later persist writes fresh WITHOUT destroying the evidence.
    store.set('1', 'm_a');
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.readFileSync(reports[0].aside, 'utf-8')).toBe('{ this is not json');
  });

  it('the quarantine store itself quarantines ITS corrupt file aside too (same posture)', () => {
    const file = path.join(tmp, 'q.json');
    fs.writeFileSync(file, 'garbage');
    const reports: string[] = [];
    const q = new TopicPinSkewQuarantine({ filePath: file, onCorrupt: (aside) => reports.push(aside) });
    expect(q.all()).toEqual([]);
    expect(reports).toHaveLength(1);
    expect(fs.existsSync(reports[0])).toBe(true);
  });
});

// ── §2F — pinnedBy provenance (storage half) ─────────────────────────────────

describe('pinnedBy-resolves-operator-binding-else-agent-kind (§2F storage)', () => {
  it('the funnel persists operator provenance locally and NEVER onto the replicated record', () => {
    const store = new TopicPlacementPinStore({ filePath: path.join(tmp, 'pins.json') });
    const { emitter, emitted } = fakeEmitter();
    setPinWithOneHlc({ pinStore: store, emitter }, '13481', 'm_mini', true, { kind: 'operator', platform: 'telegram', uid: '12345' });
    expect(store.get('13481')?.pinnedBy).toEqual({ kind: 'operator', platform: 'telegram', uid: '12345' });
    // The replicated record stays deliberately non-PII: no pinnedBy field ever rides it.
    expect(Object.keys(emitted[0].data)).not.toContain('pinnedBy');
  });

  it('agent provenance is a legitimate pin author (Bearer-authed surface)', () => {
    const store = new TopicPlacementPinStore({ filePath: path.join(tmp, 'pins.json') });
    setPinWithOneHlc({ pinStore: store, emitter: null }, '700', 'm_a', true, { kind: 'agent', sessionRef: 'pool-transfer-api' });
    expect(store.get('700')?.pinnedBy).toEqual({ kind: 'agent', sessionRef: 'pool-transfer-api' });
  });
});

// ── §2C R-r3-1 — the applier ACCEPTS a skewed record (fold-side-only authority) ──

describe('skewed-pin-record-is-accepted-at-applier-stream-never-suspect-halted (R-r3-1)', () => {
  it('a future-skewed pin record persists at the applier; the stream stays live; the tombstone behind it keeps flowing', () => {
    // The load-bearing negative-space invariant: JournalSyncApplier's ONLY
    // per-entry refusal path marks the peer stream suspect and HALTS the batch
    // at that seq — so refusing one misclocked pin record at the door would
    // permanently wedge the peer's ENTIRE topic-pin-record stream (the
    // quarantine item never fires; every tombstone behind it stops flowing —
    // the defect-2 fix dies). Skew exclusion therefore acts ONLY at the fold.
    const PEER = 'm_fastclock';
    const applier = new JournalSyncApplier({ stateDir: tmp });
    const registry = new ReplicatedKindRegistry();
    registry.register(TOPIC_PIN_KIND_REGISTRATION);
    applier.setReplicatedKindRegistry(registry);

    const skewedHlc: HlcTimestamp = { physical: Date.now() + 10 * 60_000, logical: 0, node: PEER }; // +10min > the 5min drift clamp
    const skewedPut = buildTopicPinPut(13481, 'm_evil', true)(skewedHlc, PEER)!;
    const honestTombstone = buildTopicPinTombstone(13481, new Date().toISOString())(
      { physical: Date.now(), logical: 0, node: PEER }, PEER,
    )!;
    const entry = (seq: number, data: Record<string, unknown>): JournalEntry => ({
      seq, ts: new Date().toISOString(), machine: PEER, kind: TOPIC_PIN_RECORD_KIND as JournalEntry['kind'], data,
    });

    const res = applier.apply(PEER, [{
      kind: TOPIC_PIN_RECORD_KIND as JournalEntry['kind'],
      incarnation: 'inc-1',
      entries: [entry(1, skewedPut), entry(2, honestTombstone)],
    }]);

    expect(res.applied).toBe(2); // BOTH persisted — the skewed record is accepted-and-persisted
    expect(res.invalidEntries).toBe(0);
    expect(res.suspectStreams).toBe(0);
    expect(applier.getStreamStatus()[`${PEER}.${TOPIC_PIN_RECORD_KIND}`]).toBe('current'); // never suspect-halted
    // The replica file holds both — the tombstone BEHIND the skewed record flowed.
    const replica = path.join(tmp, 'state', 'coherence-journal', 'peers', `${PEER}.${TOPIC_PIN_RECORD_KIND}.jsonl`);
    const lines = fs.readFileSync(replica, 'utf-8').trim().split('\n').map((l) => JSON.parse(l) as JournalEntry);
    expect(lines.map((l) => l.seq)).toEqual([1, 2]);
    expect((lines[1].data as Record<string, unknown>).op).toBe('delete');
  });
});

// ── §2A — guard-manifest wiring integrity (R-r2 manifest constants) ─────────

describe('guardManifest wiring integrity — the two ws13 entries (§2A)', () => {
  const reconcile = GUARD_MANIFEST.find((e) => e.key === 'multiMachine.seamlessness.ws13Reconcile');
  const replicate = GUARD_MANIFEST.find((e) => e.key === 'multiMachine.seamlessness.ws13PinReplicate');

  it('both entries exist, load-bearing, with the required manifest constants', () => {
    for (const entry of [reconcile, replicate]) {
      expect(entry).toBeTruthy();
      expect(entry!.loadBearing).toBe(true);
      expect(entry!.criticalPath).toContain('deliberate placement persistence');
      expect(entry!.soakWindowDays).toBe(30);
      expect(typeof entry!.declaredLoadBearingAt).toBe('string');
      expect(Number.isNaN(Date.parse(entry!.declaredLoadBearingAt!))).toBe(false); // valid ISO date
    }
  });

  it('expectRuntime honesty: TRUE only for the reconciler (whose guardStatus() registration is built); FALSE for replication', () => {
    // ws13Reconcile declares a runtime report ONLY because OwnershipReconciler
    // .guardStatus() is registered at boot (server.ts). ws13PinReplicate has no
    // single ticking component — a manifest that expects a runtime report nobody
    // sends is a standing false alarm, so it stays false.
    expect(reconcile!.expectRuntime).toBe(true);
    expect(replicate!.expectRuntime).toBe(false);
  });
});

// ── §2D — lease-acquisition trigger (epoch-fenced) ───────────────────────────

describe('lease-acquisition trigger (§2D — one immediate tick, epoch-fenced)', () => {
  it('fires exactly ONCE per false→true transition (boot-as-holder included)', () => {
    let holder = true;
    let fires = 0;
    const t = new LeaseAcquisitionTrigger({ holdsLease: () => holder, onAcquired: () => fires++ });
    expect(t.poll()).toBe(true); // boot as holder = the acquisition
    expect(t.poll()).toBe(false); // steady holding never re-fires
    holder = false;
    expect(t.poll()).toBe(false);
    holder = true;
    expect(t.poll()).toBe(true); // re-acquisition fires again
    expect(fires).toBe(2);
  });

  it('a stale router (lost the lease before the poll) fires NOTHING — the epoch fence', () => {
    let holder = false;
    let fires = 0;
    const t = new LeaseAcquisitionTrigger({ holdsLease: () => holder, onAcquired: () => fires++ });
    expect(t.poll()).toBe(false); // never held → nothing
    // A lease blip that acquired-and-lost ENTIRELY between polls is observed as
    // still-false → no fire (the trigger only ever fires while STILL holding).
    expect(t.poll()).toBe(false);
    expect(fires).toBe(0);
  });

  it('an unreadable lease fails toward silence (the cadence tick still converges)', () => {
    let fires = 0;
    const t = new LeaseAcquisitionTrigger({ holdsLease: () => { throw new Error('lease store unreadable'); }, onAcquired: () => fires++ });
    expect(t.poll()).toBe(false);
    expect(fires).toBe(0);
  });
});
