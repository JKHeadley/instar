/**
 * VersionStore — Tier 1 (Testing Integrity Standard).
 *
 * Spec: docs/specs/skill-learning-sentinel.md §3.5 step 5 and the "Multi-machine posture" rules:
 * per-machine append-only files, `(epoch, at)` ordering across machines, `void`/`superseded`
 * tombstones folded at read time, the equal-epoch split-brain, and the post-sync epoch
 * reconciliation (deviation (t)) — including an LLM-merged canonical whose hash matches no row.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { VersionStore, compareVersionRows, scoreOf, versionCounts } from '../../src/monitoring/skillLearning/VersionStore.js';
import type { OutcomeRow } from '../../src/monitoring/skillLearning/types.js';

const NAME = 'ci-health-report';

describe('VersionStore', () => {
  let stateDir: string;
  let a: VersionStore;
  let b: VersionStore;
  let t: number;
  const now = () => t;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-'));
    t = Date.parse('2026-11-06T10:00:00.000Z');
    a = new VersionStore({ stateDir, machineId: 'm_alpha', now });
    b = new VersionStore({ stateDir, machineId: 'm_beta', now });
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'tests/unit/skill-learning-version-store.test.ts' });
  });

  const row = (over: Partial<Parameters<VersionStore['append']>[1]> = {}) => ({
    version: 1, fileHash: 'f1', bodyHash: 'b1', epoch: 1, fence: 'git' as const, op: 'create' as const, state: 'active' as const, ...over,
  });

  it('writes one file per machine under versions/<name>/ and fsyncs every row', () => {
    const fsync = vi.spyOn(fs, 'fsyncSync');
    a.append(NAME, row());
    b.append(NAME, row({ version: 2, fileHash: 'f2', epoch: 2 }));
    expect(fs.existsSync(path.join(stateDir, 'skill-learning/versions', NAME, 'm_alpha.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(stateDir, 'skill-learning/versions', NAME, 'm_beta.jsonl'))).toBe(true);
    expect(fsync).toHaveBeenCalledTimes(2);
    fsync.mockRestore();
  });

  it('orders rows across machines by (epoch, at): a later wall-clock at a LOWER epoch still loses', () => {
    t += 1000; b.append(NAME, row({ version: 2, fileHash: 'late-low-epoch', epoch: 1 }));
    t -= 500; a.append(NAME, row({ version: 1, fileHash: 'early-high-epoch', epoch: 2 }));
    const rows = a.rows(NAME);
    expect(rows.map((r) => r.fileHash)).toEqual(['late-low-epoch', 'early-high-epoch']);
    expect(a.lastRow(NAME)?.fileHash).toBe('early-high-epoch');
    expect(b.expectedPrevHash(NAME)).toBe('early-high-epoch'); // the same answer on every machine
    // Inside one epoch, `at` orders.
    expect(compareVersionRows({ epoch: 3, at: '2026-01-01T00:00:00.000Z', txId: 'a' }, { epoch: 3, at: '2026-01-01T00:00:01.000Z', txId: 'b' })).toBeLessThan(0);
  });

  it('nextVersion counts every non-void row from every machine', () => {
    expect(a.nextVersion(NAME)).toBe(1);
    a.append(NAME, row());
    b.append(NAME, row({ version: 2, fileHash: 'f2', epoch: 2 }));
    expect(a.nextVersion(NAME)).toBe(3);
  });

  it('a void tombstone (from any machine) hides the row from lastRow and nextVersion; a superseded one only from lastRow', () => {
    const r1 = a.append(NAME, row());
    const r2 = a.append(NAME, row({ version: 2, fileHash: 'f2', epoch: 2 }));
    expect(a.lastRow(NAME)?.txId).toBe(r2.txId);
    b.markVoid(NAME, r2.txId, 'never replaced');
    expect(a.lastRow(NAME)?.txId).toBe(r1.txId);
    expect(a.nextVersion(NAME)).toBe(2);
    expect(a.rowByTxId(NAME, r2.txId)?.void).toBe(true);
    a.markSuperseded(NAME, r1.txId);
    expect(a.lastRow(NAME)).toBeNull();
    expect(a.nextVersion(NAME)).toBe(2); // superseded rows still count toward the version number
  });

  it('splitBrain: two machines whose latest live rows share the max epoch with DIFFERENT bodies; identical bodies are benign', () => {
    a.append(NAME, row({ epoch: 5, fileHash: 'A' }));
    b.append(NAME, row({ version: 2, epoch: 5, fileHash: 'B' }));
    const split = a.splitBrain(NAME);
    expect(split.split).toBe(true);
    if (split.split) { expect(split.epoch).toBe(5); expect(split.candidates.map((c) => c.fileHash).sort()).toEqual(['A', 'B']); }
    expect(a.reconcileAfterSync(NAME, 'A').kind).toBe('split-brain');
    // The benign double-apply: same hash at the same epoch.
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'vs2-'));
    try {
      const a2 = new VersionStore({ stateDir: dir2, machineId: 'm_alpha', now });
      const b2 = new VersionStore({ stateDir: dir2, machineId: 'm_beta', now });
      a2.append(NAME, row({ epoch: 5, fileHash: 'A' }));
      b2.append(NAME, row({ version: 2, epoch: 5, fileHash: 'A' }));
      expect(a2.splitBrain(NAME).split).toBe(false);
    } finally {
      SafeFsExecutor.safeRmSync(dir2, { recursive: true, force: true, operation: 'tests/unit/skill-learning-version-store.test.ts' });
    }
    // A lower epoch on the other machine is not a split.
    const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'vs3-'));
    try {
      const a3 = new VersionStore({ stateDir: dir3, machineId: 'm_alpha', now });
      const b3 = new VersionStore({ stateDir: dir3, machineId: 'm_beta', now });
      a3.append(NAME, row({ epoch: 5, fileHash: 'A' }));
      b3.append(NAME, row({ version: 2, epoch: 4, fileHash: 'B' }));
      expect(a3.splitBrain(NAME).split).toBe(false);
    } finally {
      SafeFsExecutor.safeRmSync(dir3, { recursive: true, force: true, operation: 'tests/unit/skill-learning-version-store.test.ts' });
    }
  });

  it('reconcileAfterSync: in-sync when the on-disk hash is the winner; superseded tombstones a lower-epoch loser on disk', () => {
    expect(a.reconcileAfterSync(NAME, 'x').kind).toBe('no-rows');
    const loserRow = b.append(NAME, row({ epoch: 3, fileHash: 'loser' }));
    t += 1000;
    const winnerRow = a.append(NAME, row({ version: 2, epoch: 4, fileHash: 'winner' }));
    expect(a.reconcileAfterSync(NAME, 'winner')).toMatchObject({ kind: 'in-sync', winner: { txId: winnerRow.txId } });
    // The merge put the LOSER's body on disk: the higher epoch wins; the loser's rows are superseded.
    const out = a.reconcileAfterSync(NAME, 'loser');
    expect(out.kind).toBe('superseded');
    if (out.kind === 'superseded') { expect(out.loser.txId).toBe(loserRow.txId); expect(out.winner.txId).toBe(winnerRow.txId); expect(out.tombstoned).toBe(1); }
    expect(b.rowByTxId(NAME, loserRow.txId)?.superseded).toBe(true);
    expect(b.lastRow(NAME)?.txId).toBe(winnerRow.txId); // the next holder never reads the loser's hash as an edit
    expect(b.reconcileAfterSync(NAME, 'loser').kind).toBe('unknown-hash'); // once superseded, that hash is no row's
  });

  it('reconcileAfterSync: an LLM-merged canonical matches no row → unknown-hash (the caller locks operator-owned)', () => {
    a.append(NAME, row({ epoch: 2, fileHash: 'ours' }));
    b.append(NAME, row({ version: 2, epoch: 1, fileHash: 'theirs' }));
    const out = a.reconcileAfterSync(NAME, 'sha-of-a-merged-body');
    expect(out.kind).toBe('unknown-hash');
    if (out.kind === 'unknown-hash') expect(out.winner.fileHash).toBe('ours');
    expect(a.reconcileAfterSync(NAME, null).kind).toBe('unknown-hash'); // missing on disk is not any row either
  });

  it('ignores a torn tail line, non-row JSON and rows missing required fields; refuses an invalid name', () => {
    a.append(NAME, row());
    fs.appendFileSync(a.ownFile(NAME), '{"kind":"version","txId":"x"}\n{"not":"a row"}\n{"kind":"version","txId":"torn", "fileHa');
    expect(a.rows(NAME)).toHaveLength(1);
    expect(() => a.append('Bad Name!', row())).toThrow(/invalid skill name/);
  });
});

// ─── Slice 3A (§3.7): bodies with retention, annotations, reverts, per-version scores ───

describe('VersionStore — slice 3A: bodies (last 20, older content-addressed, never deleted), annotations, reverts, scores', () => {
  let stateDir: string;
  let a: VersionStore;
  let b: VersionStore;
  let t: number;
  const now = () => t;
  const hash = (s: string) => crypto.createHash('sha256').update(s, 'utf-8').digest('hex');

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'vs3a-'));
    t = Date.parse('2026-11-06T10:00:00.000Z');
    a = new VersionStore({ stateDir, machineId: 'm_alpha', now });
    b = new VersionStore({ stateDir, machineId: 'm_beta', now });
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'tests/unit/skill-learning-version-store.test.ts' });
  });

  const row = (over: Partial<Parameters<VersionStore['append']>[1]> = {}) => ({
    version: 1, fileHash: 'f'.repeat(64), bodyHash: 'b'.repeat(64), epoch: 1, fence: 'local' as const, op: 'create' as const, state: 'active' as const, ...over,
  });

  it('annotate() folds into the row at read time on every machine (last write wins per field); citedCorrections default to []', () => {
    const r1 = a.append(NAME, row({ txId: 'tx-1' }));
    t += 1000; a.append(NAME, row({ version: 2, txId: 'tx-2', fileHash: 'g'.repeat(64), bodyHash: 'c'.repeat(64), op: 'patch' }));
    expect(a.rows(NAME).map((r) => r.citedCorrections)).toEqual([[], []]);
    t += 1000; a.annotate(NAME, 'tx-2', { citedCorrections: ['c-1'], reviewerFamily: 'openai' });
    t += 1000; b.annotate(NAME, 'tx-2', { citedCorrections: ['c-1', 'c-2'], rejectedBodyHash: 'r'.repeat(64) });
    const v2 = b.rows(NAME)[1];
    expect(v2).toMatchObject({ txId: 'tx-2', citedCorrections: ['c-1', 'c-2'], reviewerFamily: 'openai', rejectedBodyHash: 'r'.repeat(64), void: false });
    expect(a.rows(NAME)[1]).toEqual(v2);
    expect(a.rowByTxId(NAME, r1.txId)?.citedCorrections).toEqual([]);
    // A row appended WITH the fields carries them directly.
    t += 1000; a.append(NAME, row({ version: 3, txId: 'tx-3', fileHash: 'h'.repeat(64), op: 'revert', revertOf: 'tx-2', rejectedBodyHash: 'c'.repeat(64), uncertainty: { nCorrected: 2, nRuns: 3, prevRate: 0 } }));
    expect(a.rows(NAME)[2]).toMatchObject({ op: 'revert', revertOf: 'tx-2', rejectedBodyHash: 'c'.repeat(64), uncertainty: { nCorrected: 2, nRuns: 3, prevRate: 0 } });
  });

  it('storeBody/readBody: temp+rename, idempotent, readable from the other machine; the 21st body MOVES the oldest to _cas (a rename), nothing is ever deleted; readBody still finds it', () => {
    const rm = vi.spyOn(SafeFsExecutor, 'safeRmSync');
    const unlink = vi.spyOn(SafeFsExecutor, 'safeUnlinkSync');
    const fsRm = vi.spyOn(fs, 'rmSync');
    const fsUnlink = vi.spyOn(fs, 'unlinkSync');
    const rename = vi.spyOn(fs, 'renameSync');
    const bodies: string[] = [];
    for (let i = 1; i <= 21; i++) {
      const raw = `---\nname: ${NAME}\n---\nbody ${i}\n`;
      const fh = hash(raw);
      bodies.push(fh);
      t += 1000;
      a.append(NAME, row({ version: i, txId: `tx-${i}`, fileHash: fh, bodyHash: hash(`body ${i}\n`) }));
      const res = a.storeBody(NAME, fh, raw);
      expect(res.stored).toBe(true);
      if (i < 21) expect(res.movedToCas).toEqual([]);
      else expect(res.movedToCas).toEqual([bodies[0]]);
    }
    const bodiesDir = path.join(stateDir, 'skill-learning', 'versions', NAME, 'bodies');
    expect(fs.readdirSync(bodiesDir).sort()).toEqual(bodies.slice(1).map((h) => `${h}.md`).sort());
    expect(fs.readdirSync(path.join(stateDir, 'skill-learning', 'versions', '_cas'))).toEqual([`${bodies[0]}.md`]);
    expect(b.readBody(NAME, bodies[0])).toBe(`---\nname: ${NAME}\n---\nbody 1\n`);      // from _cas
    expect(b.readBody(NAME, bodies[20])).toBe(`---\nname: ${NAME}\n---\nbody 21\n`);    // from bodies/
    expect(a.readBody(NAME, 'e'.repeat(64))).toBeNull();
    // Idempotent: storing a body already in _cas does not resurrect it under bodies/.
    expect(a.storeBody(NAME, bodies[0], 'anything').stored).toBe(false);
    expect(fs.readdirSync(bodiesDir)).toHaveLength(20);
    // Zero deletes: every removal funnel untouched; only renames (temp → body, body → _cas).
    expect(rm).not.toHaveBeenCalled();
    expect(unlink).not.toHaveBeenCalled();
    expect(fsRm).not.toHaveBeenCalled();
    expect(fsUnlink).not.toHaveBeenCalled();
    expect(rename.mock.calls.some(([from, to]) => String(from).endsWith(`${bodies[0]}.md`) && String(to).includes('_cas'))).toBe(true);
    for (const s of [rm, unlink, fsRm, fsUnlink, rename]) s.mockRestore();
    expect(() => a.storeBody(NAME, 'not-a-hash', 'x')).toThrow(/invalid file hash/);
  });

  it('reverts / revertsSince / rejectedVersions: with the annotation, and without it (the live row right before the revert is N+1)', () => {
    a.append(NAME, row({ txId: 'tx-1', at: '2026-10-01T00:00:00.000Z' }));
    a.append(NAME, row({ version: 2, txId: 'tx-2', fileHash: 'g'.repeat(64), bodyHash: 'c'.repeat(64), op: 'patch', citedCorrections: ['c-9'], at: '2026-10-02T00:00:00.000Z' }));
    a.append(NAME, row({ version: 3, txId: 'tx-3', fileHash: 'h'.repeat(64), bodyHash: 'b'.repeat(64), op: 'revert', at: '2026-10-03T00:00:00.000Z' }));
    expect(a.rejectedVersions(NAME)).toEqual([{ txId: 'tx-2', bodyHash: 'c'.repeat(64), citedCorrections: ['c-9'], revertTxId: 'tx-3', at: '2026-10-03T00:00:00.000Z' }]);
    a.append(NAME, row({ version: 4, txId: 'tx-4', fileHash: 'i'.repeat(64), bodyHash: 'd'.repeat(64), op: 'patch', citedCorrections: ['c-10'], at: '2026-10-20T00:00:00.000Z' }));
    a.append(NAME, row({ version: 5, txId: 'tx-5', fileHash: 'j'.repeat(64), bodyHash: 'b'.repeat(64), op: 'revert', revertOf: 'tx-4', rejectedBodyHash: 'd'.repeat(64), at: '2026-11-05T00:00:00.000Z' }));
    expect(a.reverts(NAME).map((r) => r.txId)).toEqual(['tx-3', 'tx-5']);
    expect(a.revertsSince(NAME, Date.parse('2026-10-10T00:00:00Z')).map((r) => r.txId)).toEqual(['tx-5']);
    expect(a.rejectedVersions(NAME).map((r) => [r.txId, r.citedCorrections])).toEqual([['tx-2', ['c-9']], ['tx-4', ['c-10']]]);
    a.markVoid(NAME, 'tx-5');
    expect(a.reverts(NAME).map((r) => r.txId)).toEqual(['tx-3']);
  });

  it('versionCounts / scoreOf: keyed by body hash; operator-edited and version-uncertain uses excluded; corroborated-measured counts for the revert trigger', () => {
    const o = (label: OutcomeRow['label'], contentHash: string, extra: Partial<NonNullable<OutcomeRow['skillUsed']>> = {}): OutcomeRow => ({
      kind: 'outcome', eventId: crypto.randomUUID(), runId: crypto.randomUUID(), revision: 1, procedureKey: 'k', topicId: '1', label, provisional: false, windowStart: 'x', at: 'y', machineId: 'm',
      skillUsed: { skill: NAME, contentHash, corroborated: true, versionUncertain: false, ...extra },
    });
    const H1 = 'a'.repeat(64); const H2 = 'b'.repeat(64);
    const counts = versionCounts(NAME, [
      o('accepted', H1), o('accepted-inferred', H1), o('corrected', H1), o('unknown', H1), o('weak-positive', H1),
      o('corrected', H1, { corroborated: false }), o('corrected', H1, { operatorEdited: true }), o('accepted', H1, { versionUncertain: true }),
      o('redo', H2), o('corrected', H2), o('accepted', H2), { ...o('accepted', H2), skillUsed: { skill: 'other', contentHash: H2, corroborated: true, versionUncertain: false } },
      o('accepted', 'unknown'),
    ]);
    expect([...counts.keys()].sort()).toEqual([H1, H2]);
    expect(counts.get(H1)).toMatchObject({ uses: 6, accepted: 1, acceptedInferred: 1, corrected: 2, unknown: 1, weakPositive: 1, corroborated: 5, measuredCorroborated: 3, correctedCorroborated: 1 });
    expect(counts.get(H1)!.score).toBeCloseTo((1 + 0.5 + 1) / (1 + 0.5 + 2 + 2));
    expect(counts.get(H2)).toMatchObject({ uses: 3, accepted: 1, corrected: 2, measuredCorroborated: 3, correctedCorroborated: 2 });
    expect(scoreOf({ accepted: 0, acceptedInferred: 0, corrected: 0 })).toBeNull();
    expect(scoreOf({ accepted: 2, acceptedInferred: 0, corrected: 0 })).toBeCloseTo(3 / 4);
  });
});
