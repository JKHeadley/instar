import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JournalSyncApplier } from '../../src/core/JournalSyncApplier.js';
import { CoherenceJournal, type JournalFs } from '../../src/core/CoherenceJournal.js';
import { buildLastTick, CHIEF_OF_STAFF_KIND_REGISTRATION } from '../../src/core/ChiefOfStaffStore.js';
import { ReplicatedKindRegistry } from '../../src/core/ReplicatedRecordEnvelope.js';
import { createPhysicalEffectLock, type PhysicalEffectLeaseSync } from '../../src/core/PhysicalEffectLock.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const machine = 'm_studio';
const kind = 'chief-of-staff-record';
const at = '2026-11-25T00:00:00.000Z';

function candidate(logical = 0) {
  const key = `last-tick:${machine}`;
  const data = buildLastTick(machine, at)({ physical: Date.parse(at), logical, node: machine }, machine);
  if (!data) throw new Error('invalid fixture envelope');
  return { key, data };
}

describe('dark chief decision journal append', () => {
  let projectDir: string;
  let stateDir: string;
  let journal: CoherenceJournal;

  let ownsKernelLock: boolean;
  const decisionWriterLock = {
    acquireSync(scope: string): PhysicalEffectLeaseSync {
      if (ownsKernelLock) throw new Error('fixture kernel lock is held');
      ownsKernelLock = true;
      let live = true;
      return {
        scope, ownerId: 'fixture', epoch: 1, acquiredAt: 0, requiresReconciliation: false,
        assertHeld() { if (!live) throw new Error('fixture lock no longer held'); },
        release() { live = false; ownsKernelLock = false; },
      };
    },
  };

  function open(fsImpl?: JournalFs, writerLock: Pick<ReturnType<typeof createPhysicalEffectLock>, 'acquireSync'> = decisionWriterLock) {
    const next = new CoherenceJournal({ stateDir, machineId: machine, fsImpl, decisionWriterLock: writerLock });
    const registry = new ReplicatedKindRegistry();
    registry.register(CHIEF_OF_STAFF_KIND_REGISTRATION);
    next.setReplicatedKindRegistry(registry);
    next.open();
    return next;
  }

  beforeEach(() => {
    ownsKernelLock = false;
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chief-journal-'));
    stateDir = path.join(projectDir, '.instar');
    journal = open();
  });
  afterEach(() => {
    journal.close();
    SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'chief-decision-fixture' });
  });

  it('keeps an advisory-only journal from making exact decisions', () => {
    journal.close();
    journal = new CoherenceJournal({ stateDir, machineId: machine });
    journal.open();
    expect(journal.appendChiefDecision(() => true, () => candidate())).toBe(false);
  });

  it('does not release the winner when a second journal is locked out', () => {
    const contender = open();
    expect(contender.isLockedOut).toBe(true);
    contender.close();
    expect(journal.appendChiefDecision(() => true, () => candidate())).toBe(true);
  });

  it('leaves a stale-looking live strict owner alone, including when the contender closes', () => {
    journal.close();
    const lock = path.join(stateDir, 'state', 'coherence-journal', machine + '.lock');
    const owner = JSON.stringify({ pid: process.ppid, strictDecisionWriter: true });
    fs.writeFileSync(lock, owner);
    fs.utimesSync(lock, new Date(0), new Date(0));
    journal = new CoherenceJournal({ stateDir, machineId: machine });
    journal.open();
    expect(journal.isLockedOut).toBe(true);
    journal.close();
    expect(fs.readFileSync(lock, 'utf8')).toBe(owner);
  });

  it('writes the exact record durably and dedupes the same envelope', () => {
    const prepared = candidate();
    expect(journal.appendChiefDecision(() => true, () => prepared)).toBe(true);
    expect(journal.appendChiefDecision(() => true, () => prepared)).toBe(false);
    journal.close();
    journal = open();
    expect(journal.readKindComplete(kind)).toMatchObject({
      complete: true, entries: [{ data: prepared.data }],
    });
    expect(journal.readKindComplete(kind).entries).toHaveLength(1);
  });

  it('refuses lease loss after prepare and never queues the decision', () => {
    let holds = true;
    expect(journal.appendChiefDecision(() => holds, () => {
      holds = false;
      return candidate();
    })).toBe(false);
    holds = true;
    journal.flush();
    expect(journal.readKindComplete(kind).entries).toEqual([]);
    expect(journal.appendChiefDecision(() => holds, () => candidate())).toBe(true);
  });

  it('fences an uncertain acknowledgement through restart until the exact record is reconciled', () => {
    let checks = 0;
    const prepared = candidate();
    expect(() => journal.appendChiefDecision(() => ++checks <= 3, () => prepared))
      .toThrow('chief-decision-authority-changed-after-write');
    expect(journal.emitReplicatedRecord(kind, candidate(1).data)).toBe('locked-out');
    expect(journal.pendingCount).toBe(0);
    journal.close();
    journal = open();

    expect(journal.readKindComplete(kind)).toEqual({ entries: [], complete: false });
    expect(journal.getOwnAdvert()[kind].lastSeq).toBe(0);
    const applier = new JournalSyncApplier({ stateDir });
    expect(applier.buildServeBatch(kind, 0, machine)).toMatchObject({ entries: [], blockedByPendingDecision: true });
    expect(journal.readTail(kind).entries).toEqual([]);
    const observer = new CoherenceJournal({ stateDir, machineId: machine });
    expect(observer.readTail(kind).entries).toEqual([]);
    expect(observer.readKindComplete(kind)).toEqual({ entries: [], complete: false });
    expect(journal.emitReplicatedRecord(kind, candidate(1).data)).toBe('locked-out');
    expect(journal.reconcileChiefDecision(() => false)).toBe(false);
    expect(() => journal.appendChiefDecision(() => true, () => candidate(1)))
      .toThrow('chief-decision-reconciliation-required');
    expect(journal.reconcileChiefDecision(entry => JSON.stringify(entry.data) === JSON.stringify(prepared.data))).toBe(true);
    expect(journal.appendChiefDecision(() => true, () => prepared)).toBe(false);
    expect(journal.readKindComplete(kind).entries).toHaveLength(1);
    expect(applier.buildServeBatch(kind, 0, machine).entries).toHaveLength(1);
  });

  const legacyInstall = process.env.INSTAR_JOURNAL_FIXTURE_LEGACY_PACKAGE;
  it.skipIf(process.platform !== 'darwin' || !legacyInstall)(
    'excludes the released direct CLI and preserves the uncertain append through successor restart',
    () => {
      journal.close();
      journal = open(undefined, createPhysicalEffectLock(stateDir));
      const prepared = candidate();
      let checks = 0;
      expect(() => journal.appendChiefDecision(() => ++checks <= 3, () => prepared))
        .toThrow('chief-decision-authority-changed-after-write');
      journal.close();

      const fixture = fileURLToPath(new URL('../fixtures/journal-writer/legacy-direct-fixture.py', import.meta.url));
      const proof = execFileSync('python3', [fixture, legacyInstall!, projectDir], {
        encoding: 'utf-8',
        timeout: 35_000,
      });
      expect(proof).toContain('writer locked out');

      journal = open(undefined, createPhysicalEffectLock(stateDir));
      expect(journal.readKindComplete(kind)).toEqual({ entries: [], complete: false });
      expect(() => journal.appendChiefDecision(() => true, () => candidate(1)))
        .toThrow('chief-decision-reconciliation-required');
      expect(journal.reconcileChiefDecision(() => false)).toBe(false);
      expect(journal.reconcileChiefDecision(entry => JSON.stringify(entry.data) === JSON.stringify(prepared.data))).toBe(true);
      expect(journal.readKindComplete(kind).entries).toHaveLength(1);
    },
    40_000,
  );

  it('keeps a partial append fenced after restart even when no complete line exists', () => {
    journal.close();
    const openFiles = new Map<number, string>();
    const openSync: typeof fs.openSync = (file, flags, mode) => {
      const fd = fs.openSync(file, flags, mode);
      openFiles.set(fd, String(file));
      return fd;
    };
    const writeSync = ((fd: number, buffer: Buffer, offset: number, length: number) => {
      if (openFiles.get(fd)?.endsWith('.chief-of-staff-record.jsonl')) {
        return fs.writeSync(fd, buffer, offset, Math.min(15, length));
      }
      return fs.writeSync(fd, buffer, offset, length);
    }) as typeof fs.writeSync;
    journal = open({ ...fs, openSync, writeSync });
    expect(() => journal.appendChiefDecision(() => true, () => candidate()))
      .toThrow('chief-decision-short-write');
    journal.close();
    journal = open();

    expect(journal.reconcileChiefDecision(() => true)).toBe(false);
    expect(() => journal.appendChiefDecision(() => true, () => candidate(1)))
      .toThrow('chief-decision-reconciliation-required');
  });

});
