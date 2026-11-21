// safe-fs-allow: test file — temp dirs via mkdtemp/rm only.
/**
 * Integration — probe material from a REAL transcript through the REAL archive
 * (context-budget-layered-summaries §10 items 1–2, §6.5, §9.7; Phase 2 P2-2).
 *
 * A real Claude Code transcript fixture is normalized by the production reader
 * (archiveEntriesFromTranscriptLine), archived and scrubbed by the production
 * TranscriptArchive, read back as span entries (spanEntriesFromArchive), then
 * sampled for probe generation. This pins the seam the shadow runner uses:
 * the entries the generator may cite are exactly archived entry ids, so a
 * question's reference is resolvable in the archived snapshot, and a span
 * re-read from the archive samples exactly as it did the first time.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TranscriptArchive } from '../../src/monitoring/contextLayers/TranscriptArchive.js';
import { archiveEntriesFromTranscriptLine, spanEntriesFromArchive } from '../../src/monitoring/contextLayers/spanSampler.js';
import { selectProbeMaterial, validateProbeQuestions } from '../../src/monitoring/foldProbe.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const OP = 'tests/integration/fold-probe-material.test.ts';
const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'context-budget', 'claude-transcript-compacted.jsonl');
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: OP }); });

function archived() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-int-')); dirs.push(stateDir);
  const archive = new TranscriptArchive({ stateDir, liveSecrets: () => [] });
  const inputs = fs.readFileSync(FIXTURE, 'utf-8').split('\n').filter(Boolean).flatMap((l) => archiveEntriesFromTranscriptLine(l)?.entries ?? []);
  expect(inputs.length).toBeGreaterThan(3);
  const r = archive.archiveSpan('141133', 'span-a', inputs);
  expect(r).toMatchObject({ archived: true });
  const read = archive.readSpan('141133', 'span-a');
  expect(read).not.toBeNull();
  return { archive, entries: spanEntriesFromArchive(read!) };
}

describe('probe material over the real archive', () => {
  it('cites only archived entry ids, and re-reading the archive samples the same way', () => {
    const { archive, entries } = archived();
    const spans = [{ index: 0, outcome: 'fixture work', entries }];
    const a = selectProbeMaterial({ foldId: 'fold-int', spans, floorMessageIds: [], floorEntryIds: [], sampleChars: 2_000 });
    for (const e of [...a.named.entries, ...a.independent]) expect(archive.spanForEntry('141133', e.entryId)).toBe('span-a');
    const again = selectProbeMaterial({ foldId: 'fold-int', spans: [{ index: 0, outcome: 'fixture work', entries: spanEntriesFromArchive(archive.readSpan('141133', 'span-a')!) }], floorMessageIds: [], floorEntryIds: [], sampleChars: 2_000 });
    expect(again.named.entries.map((e) => e.entryId)).toEqual(a.named.entries.map((e) => e.entryId));
    expect(again.independent.map((e) => e.entryId)).toEqual(a.independent.map((e) => e.entryId));
  });

  it('a floor entry is sampled even under a tiny ceiling, and a question citing it validates', () => {
    const { entries } = archived();
    const floor = entries[entries.length - 1].entryId;
    const m = selectProbeMaterial({ foldId: 'fold-int', spans: [{ index: 0, outcome: 'fixture work', entries }], floorMessageIds: [], floorEntryIds: [floor], sampleChars: 50 });
    expect(m.named.entries.map((e) => e.entryId)).toContain(floor);
    const v = validateProbeQuestions(JSON.stringify({ questions: [{ type: 'detail', source: 'span', sourceRef: null, spanIndex: 0, sample: 'named', question: 'What happened last?', expected: 'The fixture work finished.', referenceEntryIds: [floor] }] }), m,
      { ledger: [], stillNeeded: [], openThreads: [], nextStep: '', finished: [{ index: 0, outcome: 'fixture work' }] }, { maxQuestions: 4, foldId: 'fold-int' });
    if ('error' in v) throw new Error(v.error);
    expect(v.questions).toHaveLength(1);
    expect(v.floorGaps).toEqual([]);
  });
});
