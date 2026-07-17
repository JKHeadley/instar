// safe-git-allow: test fixture cleanup uses fs.rmSync on tmp dirs only.
// safe-fs-allow: test fixture cleanup uses fs.rmSync on tmp dirs only.
/**
 * Tier-1 unit tests for WorkingSetPullCoordinator (P2.2b) —
 * WORKING-SET-HANDOFF-SPEC §3.3 (trigger) + §3.4 (staggered drain).
 *
 * Covers: ownership gating (not-owner skip); durable (topic,epoch) op-key
 * dedupe surviving a coordinator "restart" (new instance, same stateDir);
 * prevOwner===self skip; plural bounded nomination (most-recent-first, cap,
 * cappedNominees named, self excluded, replicas nominate); single-flight
 * coalescing; pending-pull filed on unreachable nominee + GENUINE-failure
 * attempt accounting (busy files WITHOUT an attempt); staggered drain
 * (sequential per peer, stale-owner records cleared, superseded records
 * cleared); reflex rate limit + coalescing; pressure defer leaves the op-key
 * unrecorded (re-triggerable).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { WorkingSetPullCoordinator } from '../../src/core/WorkingSetPullCoordinator.js';
import { PendingPullLedger } from '../../src/core/PendingPullLedger.js';
import { CoherenceJournalReader } from '../../src/core/CoherenceJournalReader.js';
import type { JournalEntry } from '../../src/core/CoherenceJournal.js';
import type { PullReport, WorkingSetPuller } from '../../src/core/WorkingSetPull.js';

const SELF = 'm_self';
const PEER_A = 'm_peer_a';
const PEER_B = 'm_peer_b';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsp-coord-test-'));
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

function writeRunStream(scope: 'own' | 'peers', machine: string, entries: JournalEntry[]): void {
  const dir =
    scope === 'own'
      ? path.join(tmpDir, 'state', 'coherence-journal')
      : path.join(tmpDir, 'state', 'coherence-journal', 'peers');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${machine}.autonomous-run.jsonl`),
    entries.map((e) => JSON.stringify(e)).join('\n') + '\n',
  );
}

function runEntry(machine: string, seq: number, topic: number, ts: string): JournalEntry {
  return {
    seq,
    ts,
    machine,
    kind: 'autonomous-run',
    topic,
    data: { action: 'started', runId: `r${seq}`, artifactPaths: [] },
  };
}

function okReport(topic: number): PullReport {
  return { topic, files: [{ relPath: 'x', outcome: 'written' }], assembledBytes: 1, needsPendingPull: false };
}

function pendingReport(topic: number, outcome: 'busyExhausted' | 'liveSourceDeferred'): PullReport {
  return { topic, files: [{ relPath: 'x', outcome }], assembledBytes: 0, needsPendingPull: true };
}

function fakePuller(fn: (topic: number) => Promise<PullReport>): WorkingSetPuller {
  return { pullTopic: fn } as unknown as WorkingSetPuller;
}

interface MakeOpts {
  owner?: string | null;
  epoch?: number | null;
  pull?: (nominee: string, topic: number) => Promise<PullReport> | null;
  pressure?: boolean;
  reflexMinIntervalMs?: number;
}

function makeCoordinator(opts: MakeOpts = {}): { coord: WorkingSetPullCoordinator; ledger: PendingPullLedger; pulls: string[] } {
  const ledger = new PendingPullLedger({ stateDir: tmpDir });
  const pulls: string[] = [];
  const coord = new WorkingSetPullCoordinator({
    stateDir: tmpDir,
    ownMachineId: SELF,
    reader: new CoherenceJournalReader({ stateDir: tmpDir }),
    ledger,
    makePuller: (nominee) => {
      const fn = opts.pull?.(nominee, -1);
      if (fn === null) return null;
      return fakePuller(async (topic) => {
        pulls.push(`${nominee}:${topic}`);
        return opts.pull ? ((await opts.pull(nominee, topic)) as PullReport) : okReport(topic);
      });
    },
    ownerOf: () => ({ owner: opts.owner === undefined ? SELF : opts.owner, epoch: opts.epoch === undefined ? 5 : opts.epoch }),
    underPressure: () => opts.pressure ?? false,
    reflexMinIntervalMs: opts.reflexMinIntervalMs ?? 0,
  });
  return { coord, ledger, pulls };
}

describe('WorkingSetPullCoordinator — trigger gating (§3.3)', () => {
  it('skips when this machine is not the owner', async () => {
    writeRunStream('peers', PEER_A, [runEntry(PEER_A, 1, 10, '2026-06-06T00:00:01.000Z')]);
    const { coord } = makeCoordinator({ owner: PEER_A });
    const out = await coord.fetchWorkingSet(10);
    expect(out.scheduled).toBe(false);
    expect(out.skipReason).toBe('not-owner');
  });

  it('not-owner does not consume the reflex window before ownership converges', async () => {
    writeRunStream('peers', PEER_A, [runEntry(PEER_A, 1, 10, '2026-06-06T00:00:01.000Z')]);
    let owner = PEER_A;
    const ledger = new PendingPullLedger({ stateDir: tmpDir });
    const pulls: number[] = [];
    const coord = new WorkingSetPullCoordinator({
      stateDir: tmpDir,
      ownMachineId: SELF,
      reader: new CoherenceJournalReader({ stateDir: tmpDir }),
      ledger,
      makePuller: () => fakePuller(async (topic) => { pulls.push(topic); return okReport(topic); }),
      ownerOf: () => ({ owner, epoch: 5 }),
      reflexMinIntervalMs: 60_000,
    });

    const before = await coord.fetchWorkingSet(10);
    expect(before.skipReason).toBe('not-owner');
    owner = SELF;
    const after = await coord.fetchWorkingSet(10);
    expect(after.scheduled).toBe(true);
    expect(pulls).toEqual([10]);
  });

  it('(topic,epoch) op-key dedupe is DURABLE — a new coordinator instance still dedupes the move trigger', async () => {
    writeRunStream('peers', PEER_A, [runEntry(PEER_A, 1, 10, '2026-06-06T00:00:01.000Z')]);
    const first = makeCoordinator({});
    first.coord.onTopicAccepted(10);
    await new Promise((r) => setTimeout(r, 50)); // let the async trigger run
    expect(first.pulls).toEqual([`${PEER_A}:10`]);

    // "Restart": a NEW instance over the same stateDir — same (topic, epoch).
    const second = makeCoordinator({});
    second.coord.onTopicAccepted(10);
    await new Promise((r) => setTimeout(r, 50));
    expect(second.pulls).toEqual([]); // deduped from the durable window
  });

  it('pressure defers WITHOUT recording the op-key — the next accept re-triggers', async () => {
    writeRunStream('peers', PEER_A, [runEntry(PEER_A, 1, 10, '2026-06-06T00:00:01.000Z')]);
    const opts: MakeOpts = { pressure: true };
    const { coord, pulls } = makeCoordinator(opts);
    coord.onTopicAccepted(10);
    await new Promise((r) => setTimeout(r, 50));
    expect(pulls).toEqual([]);
    // Pressure clears → the SAME (topic,epoch) fires (op-key was not burned).
    opts.pressure = false;
    coord.onTopicAccepted(10);
    await new Promise((r) => setTimeout(r, 50));
    expect(pulls).toEqual([`${PEER_A}:10`]);
  });

  it('no journal producers → honest no-producers skip', async () => {
    const { coord } = makeCoordinator({});
    const out = await coord.fetchWorkingSet(99);
    expect(out.scheduled).toBe(false);
    expect(out.skipReason).toBe('no-producers');
  });

  it('prevOwner === self (journal placement evidence) skips the move trigger — nothing to fetch from ourselves', async () => {
    writeRunStream('peers', PEER_A, [runEntry(PEER_A, 1, 10, '2026-06-06T00:00:01.000Z')]);
    // Placement history: epoch 5 move with prevOwner = SELF.
    const dir = path.join(tmpDir, 'state', 'coherence-journal');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${SELF}.topic-placement.jsonl`),
      JSON.stringify({
        seq: 1,
        ts: '2026-06-06T00:00:02.000Z',
        machine: SELF,
        kind: 'topic-placement',
        topic: 10,
        data: { owner: SELF, prevOwner: SELF, epoch: 5, reason: 'placed' },
      }) + '\n',
    );
    const { coord, pulls } = makeCoordinator({});
    coord.onTopicAccepted(10);
    await new Promise((r) => setTimeout(r, 50));
    expect(pulls).toEqual([]);
  });
});

describe('WorkingSetPullCoordinator — nomination (§3.3 plural, bounded)', () => {
  it('nominates journal producers most-recent-first, excludes self, names the capped excess', () => {
    writeRunStream('own', SELF, [runEntry(SELF, 1, 10, '2026-06-06T00:00:09.000Z')]);
    writeRunStream('peers', PEER_A, [runEntry(PEER_A, 1, 10, '2026-06-06T00:00:05.000Z')]);
    writeRunStream('peers', PEER_B, [runEntry(PEER_B, 1, 10, '2026-06-06T00:00:07.000Z')]);
    writeRunStream('peers', 'm_peer_c', [runEntry('m_peer_c', 1, 10, '2026-06-06T00:00:03.000Z')]);
    writeRunStream('peers', 'm_peer_d', [runEntry('m_peer_d', 1, 10, '2026-06-06T00:00:01.000Z')]);
    const { coord } = makeCoordinator({});
    const { nominees, capped } = coord.nominate(10);
    expect(nominees).toEqual([PEER_B, PEER_A, 'm_peer_c']); // newest-first, self excluded, cap 3
    expect(capped).toEqual(['m_peer_d']); // named, not silent
  });
});

describe('WorkingSetPullCoordinator — pending-pull accounting (§3.4)', () => {
  it('unreachable nominee files a pending-pull WITH a genuine-failure attempt', async () => {
    writeRunStream('peers', PEER_A, [runEntry(PEER_A, 1, 10, '2026-06-06T00:00:01.000Z')]);
    const { coord, ledger } = makeCoordinator({ pull: () => null }); // makePuller → null
    const out = await coord.fetchWorkingSet(10);
    expect(out.scheduled).toBe(true);
    expect(out.reports?.[0].error).toBe('peer unreachable');
    const records = await ledger.all();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ topic: 10, nominee: PEER_A, attempts: 1 });
  });

  it('busyExhausted files a pending-pull WITHOUT consuming an attempt (retry-without-penalty)', async () => {
    writeRunStream('peers', PEER_A, [runEntry(PEER_A, 1, 10, '2026-06-06T00:00:01.000Z')]);
    const { coord, ledger } = makeCoordinator({ pull: async (_n, topic) => pendingReport(topic, 'busyExhausted') });
    await coord.fetchWorkingSet(10);
    const records = await ledger.all();
    expect(records).toHaveLength(1);
    expect(records[0].attempts).toBe(0); // busy never burns failure budget
    expect(records[0].reason).toBe('busy-exhausted');
  });

  it('liveSource files a live-source record; a successful pull clears its record', async () => {
    writeRunStream('peers', PEER_A, [runEntry(PEER_A, 1, 10, '2026-06-06T00:00:01.000Z')]);
    let live = true;
    const { coord, ledger } = makeCoordinator({
      pull: async (_n, topic) => (live ? pendingReport(topic, 'liveSourceDeferred') : okReport(topic)),
      reflexMinIntervalMs: 0,
    });
    await coord.fetchWorkingSet(10);
    expect((await ledger.all())[0].reason).toBe('live-source');
    live = false;
    await coord.fetchWorkingSet(10);
    expect(await ledger.all()).toHaveLength(0); // cleared on success
  });
});

describe('WorkingSetPullCoordinator — staggered drain (§3.4)', () => {
  it('drains a returning peer sequentially, clears stale-owner records, supersedes old epochs', async () => {
    const order: string[] = [];
    const ledger = new PendingPullLedger({ stateDir: tmpDir });
    await ledger.file_({ topic: 1, epoch: 5, nominee: PEER_A, reason: 'peer-offline' });
    await ledger.file_({ topic: 2, epoch: 3, nominee: PEER_A, reason: 'peer-offline' });
    await ledger.file_({ topic: 3, epoch: 1, nominee: PEER_A, reason: 'peer-offline' }); // we no longer own 3

    const coord = new WorkingSetPullCoordinator({
      stateDir: tmpDir,
      ownMachineId: SELF,
      reader: new CoherenceJournalReader({ stateDir: tmpDir }),
      ledger,
      makePuller: () =>
        fakePuller(async (topic) => {
          order.push(`pull:${topic}`);
          return okReport(topic);
        }),
      ownerOf: (topic) =>
        topic === 3 ? { owner: PEER_B, epoch: 9 } : { owner: SELF, epoch: topic === 1 ? 5 : 3 },
    });

    coord.onPeerRecorded(PEER_A);
    await new Promise((r) => setTimeout(r, 100));
    // Most-recent-epoch-first: topic 1 (epoch 5) before topic 2 (epoch 3);
    // topic 3 cleared (not owner), never pulled.
    expect(order).toEqual(['pull:1', 'pull:2']);
    expect(await ledger.all()).toHaveLength(0); // 1+2 cleared by success, 3 cleared stale-owner
  });

  it('a second onPeerRecorded while a drain is running is a no-op (drain gate)', async () => {
    const ledger = new PendingPullLedger({ stateDir: tmpDir });
    await ledger.file_({ topic: 1, epoch: 1, nominee: PEER_A, reason: 'peer-offline' });
    let pulls = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const coord = new WorkingSetPullCoordinator({
      stateDir: tmpDir,
      ownMachineId: SELF,
      reader: new CoherenceJournalReader({ stateDir: tmpDir }),
      ledger,
      makePuller: () =>
        fakePuller(async (topic) => {
          pulls++;
          await gate;
          return okReport(topic);
        }),
      ownerOf: () => ({ owner: SELF, epoch: 1 }),
    });
    coord.onPeerRecorded(PEER_A);
    await new Promise((r) => setTimeout(r, 20));
    coord.onPeerRecorded(PEER_A); // drain already running → no-op
    await new Promise((r) => setTimeout(r, 20));
    release();
    await new Promise((r) => setTimeout(r, 20));
    expect(pulls).toBe(1);
  });
});

describe('WorkingSetPullCoordinator — reflex (§3.3)', () => {
  it('rate-limits repeat reflex calls per topic; concurrent calls coalesce', async () => {
    writeRunStream('peers', PEER_A, [runEntry(PEER_A, 1, 10, '2026-06-06T00:00:01.000Z')]);
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const ledger = new PendingPullLedger({ stateDir: tmpDir });
    let pulls = 0;
    const coord = new WorkingSetPullCoordinator({
      stateDir: tmpDir,
      ownMachineId: SELF,
      reader: new CoherenceJournalReader({ stateDir: tmpDir }),
      ledger,
      makePuller: () =>
        fakePuller(async (topic) => {
          pulls++;
          await gate;
          return okReport(topic);
        }),
      ownerOf: () => ({ owner: SELF, epoch: 5 }),
      reflexMinIntervalMs: 60_000,
    });
    const p1 = coord.fetchWorkingSet(10);
    await new Promise((r) => setTimeout(r, 20));
    const p2 = coord.fetchWorkingSet(10); // coalesces into p1's single-flight
    release();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(pulls).toBe(1);
    expect(r1.scheduled).toBe(true);
    expect(r2).toEqual(r1); // same coalesced outcome
    // After completion, an immediate re-call hits the rate limit.
    const r3 = await coord.fetchWorkingSet(10);
    expect(r3.skipReason).toBe('rate-limited');
  });
});
