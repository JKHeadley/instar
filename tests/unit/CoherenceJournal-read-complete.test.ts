/**
 * CoherenceJournal.readKindComplete (conversation-groups-phone §3 step 2): the complete read a "make this group a
 * project" confirm decides "already a project?" from. Unlike readTail (newest 1 MB of the current file only) it
 * reads every archive and the current file in full; it reports `complete:false` for an unreadable file or a corrupt
 * interior line, and ignores only a torn final line of the current file (a write in progress).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CoherenceJournal, sanitizeMachineId } from '../../src/core/CoherenceJournal.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const MACHINE = 'm_read_complete';
const KIND = 'chief-of-staff-record';
let tmpDir: string;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cj-complete-')); });
afterEach(() => { SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/CoherenceJournal-read-complete.test.ts' }); });

const dir = () => path.join(tmpDir, 'state', 'coherence-journal');
const file = (suffix = '') => path.join(dir(), `${sanitizeMachineId(MACHINE)}.${KIND}${suffix}.jsonl`);
const line = (seq: number, extra: Record<string, unknown> = {}) => JSON.stringify({ seq, kind: KIND, data: { n: seq, ...extra } });

function journal(): CoherenceJournal {
  const j = new CoherenceJournal({ stateDir: tmpDir, machineId: MACHINE, flushIntervalMs: 1_000_000, artifactRoots: [tmpDir] });
  j.open();
  return j;
}

describe('CoherenceJournal.readKindComplete', () => {
  it('reads an archive and a current file past the 1 MB tail ceiling, where readTail is cut', () => {
    const j = journal();
    fs.mkdirSync(dir(), { recursive: true });
    fs.writeFileSync(file('.1000'), `${line(1, { binding: 'old' })}\n`);
    const pad = 'x'.repeat(2000);
    const rows: string[] = [];
    for (let i = 2; i < 700; i++) rows.push(line(i, { pad }));
    fs.writeFileSync(file(), `${rows.join('\n')}\n`);
    expect(fs.statSync(file()).size).toBeGreaterThan(1024 * 1024);
    expect(j.readTail(KIND as never, 10_000).truncated).toBe(true);
    const all = j.readKindComplete(KIND as never);
    expect(all.complete).toBe(true);
    expect(all.entries).toHaveLength(699);
    expect((all.entries[0].data as { binding?: string }).binding).toBe('old'); // the archived binding is seen
    j.close();
  });

  it('ignores a torn final line of the current file, and reports a corrupt interior line as incomplete', () => {
    const j = journal();
    fs.mkdirSync(dir(), { recursive: true });
    fs.writeFileSync(file(), `${line(1)}\n${line(2)}\n{"seq":3,"kind`);
    expect(j.readKindComplete(KIND as never)).toMatchObject({ complete: true });
    fs.writeFileSync(file(), `${line(1)}\nnot json\n${line(2)}\n`);
    expect(j.readKindComplete(KIND as never)).toMatchObject({ complete: false });
    j.close();
  });

  it('is incomplete when the whole kind is larger than the cap it may read', () => {
    const j = journal();
    fs.mkdirSync(dir(), { recursive: true });
    fs.writeFileSync(file(), `${line(1)}\n${line(2)}\n`);
    expect(j.readKindComplete(KIND as never, 10)).toMatchObject({ complete: false });
    j.close();
  });
});
