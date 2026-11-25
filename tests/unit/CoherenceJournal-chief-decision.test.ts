import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CoherenceJournal, type JournalFs } from '../../src/core/CoherenceJournal.js';
import { buildLastTick, CHIEF_OF_STAFF_KIND_REGISTRATION } from '../../src/core/ChiefOfStaffStore.js';
import { ReplicatedKindRegistry } from '../../src/core/ReplicatedRecordEnvelope.js';
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
  let stateDir: string;
  let journal: CoherenceJournal;

  function open(fsImpl?: JournalFs) {
    const next = new CoherenceJournal({ stateDir, machineId: machine, fsImpl });
    const registry = new ReplicatedKindRegistry();
    registry.register(CHIEF_OF_STAFF_KIND_REGISTRATION);
    next.setReplicatedKindRegistry(registry);
    next.open();
    return next;
  }

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chief-journal-'));
    journal = open();
  });
  afterEach(() => {
    journal.close();
    SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'chief-decision-fixture' });
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
    expect(journal.emitReplicatedRecord(kind, candidate(1).data)).toBe('locked-out');
    expect(journal.reconcileChiefDecision(() => false)).toBe(false);
    expect(() => journal.appendChiefDecision(() => true, () => candidate(1)))
      .toThrow('chief-decision-reconciliation-required');
    expect(journal.reconcileChiefDecision(entry => JSON.stringify(entry.data) === JSON.stringify(prepared.data))).toBe(true);
    expect(journal.appendChiefDecision(() => true, () => prepared)).toBe(false);
    expect(journal.readKindComplete(kind).entries).toHaveLength(1);
  });

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
