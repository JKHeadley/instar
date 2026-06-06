// safe-git-allow: test fixture cleanup uses fs.rmSync on tmp dirs only.
// safe-fs-allow: test fixture cleanup uses fs.rmSync on tmp dirs only.
/**
 * Tier-1 unit tests for WorkingSetManifest (P2.1) +
 * CoherenceJournalReader.readOwnAutonomousRuns — WORKING-SET-HANDOFF-SPEC §3.1.
 *
 * Covers (per §6 Unit): convention + journal sources deduped; topic-prefix
 * exactness (134 never matches 13481); jail cases (escape via `..`-shaped
 * journal path, symlink at final component, symlinked parent escape); caps
 * (tooLarge, headline 16MiB exemption, maxFiles truncation keeps the
 * headline); secretFlagged listing (flagged file listed + excluded from
 * transferableBytes — honest refusal, not a silent skip); mtime display-only
 * (an mtime-only change leaves sha256 the decision key); liveSource covering
 * ALL of a live run's entries; goneFromDisk counting; reader own-stream-only
 * + liveRun semantics + artifactPaths union.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  computeWorkingSet,
  DEFAULT_WORKING_SET_CAPS,
  type WorkingSetManifestResult,
} from '../../src/core/WorkingSetManifest.js';
import {
  CoherenceJournalReader,
  type OwnAutonomousRuns,
} from '../../src/core/CoherenceJournalReader.js';
import type { JournalEntry } from '../../src/core/CoherenceJournal.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'working-set-manifest-test-'));
  fs.mkdirSync(path.join(tmpDir, 'autonomous'), { recursive: true });
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

const TOPIC = 134;

function noRuns(over: Partial<OwnAutonomousRuns> = {}): OwnAutonomousRuns {
  return { entries: [], liveRun: false, artifactPaths: [], truncated: false, ...over };
}

function writeConvention(name: string, content: string | Buffer): string {
  const p = path.join(tmpDir, 'autonomous', name);
  fs.writeFileSync(p, content);
  return p;
}

function compute(over: Partial<Parameters<typeof computeWorkingSet>[0]> = {}): WorkingSetManifestResult {
  return computeWorkingSet({ stateDir: tmpDir, topic: TOPIC, runs: noRuns(), ...over });
}

function sha(content: string | Buffer): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

describe('WorkingSetManifest — sources + dedupe', () => {
  it('lists convention files for the topic, with correct bytes/sha256', () => {
    writeConvention(`${TOPIC}.local.md`, 'headline content');
    writeConvention(`${TOPIC}.notes.md`, 'side notes');
    const m = compute();
    expect(m.entries).toHaveLength(2);
    const headline = m.entries[0];
    expect(headline.relPath).toBe(path.join('autonomous', `${TOPIC}.local.md`));
    expect(headline.bytes).toBe(Buffer.byteLength('headline content'));
    expect(headline.sha256).toBe(sha('headline content'));
    expect(m.transferableBytes).toBe(headline.bytes + m.entries[1].bytes);
  });

  it('topic prefix is exact — topic 134 never matches 13481 files', () => {
    writeConvention(`13481.local.md`, 'other topic');
    writeConvention(`${TOPIC}.local.md`, 'mine');
    const m = compute();
    expect(m.entries).toHaveLength(1);
    expect(m.entries[0].relPath).toContain(`${TOPIC}.local.md`);
  });

  it('journal artifactPaths merge in, deduped against convention hits', () => {
    const conv = writeConvention(`${TOPIC}.local.md`, 'headline');
    const extra = path.join(tmpDir, 'analysis.md');
    fs.writeFileSync(extra, 'journal-evidenced artifact');
    const m = compute({ runs: noRuns({ artifactPaths: [conv, extra] }) });
    expect(m.entries).toHaveLength(2); // conv deduped, extra added
    const rels = m.entries.map((e) => e.relPath);
    expect(rels).toContain('analysis.md');
  });

  it('journal path no longer on disk counts goneFromDisk, never errors', () => {
    const m = compute({ runs: noRuns({ artifactPaths: [path.join(tmpDir, 'vanished.md')] }) });
    expect(m.entries).toHaveLength(0);
    expect(m.goneFromDisk).toBe(1);
  });
});

describe('WorkingSetManifest — jail', () => {
  it('rejects a journal path escaping the stateDir', () => {
    const outside = path.join(os.tmpdir(), 'outside-jail.md');
    const m = compute({ runs: noRuns({ artifactPaths: [outside, '../outside-rel.md'] }) });
    expect(m.entries).toHaveLength(0);
    expect(m.jailRejected).toBe(2);
  });

  it('rejects a symlink at the final component even when its target is inside the jail', () => {
    const real = writeConvention(`${TOPIC}.real.md`, 'real');
    const link = path.join(tmpDir, 'autonomous', `${TOPIC}.link.md`);
    fs.symlinkSync(real, link);
    const m = compute();
    expect(m.entries.map((e) => e.relPath)).toEqual([path.join('autonomous', `${TOPIC}.real.md`)]);
    expect(m.jailRejected).toBe(1);
  });

  it('rejects a symlinked-parent escape from a journal path', () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'));
    fs.writeFileSync(path.join(outsideDir, 'secret.md'), 'outside');
    const linkDir = path.join(tmpDir, 'escape');
    fs.symlinkSync(outsideDir, linkDir);
    const m = compute({ runs: noRuns({ artifactPaths: [path.join(linkDir, 'secret.md')] }) });
    expect(m.entries).toHaveLength(0);
    expect(m.jailRejected).toBe(1);
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });
});

describe('WorkingSetManifest — caps', () => {
  it('marks a non-headline file over maxFileBytes tooLarge (listed, hashed, excluded from transferable)', () => {
    const big = Buffer.alloc(64, 'x');
    writeConvention(`${TOPIC}.big.bin`, big);
    const m = compute({ caps: { maxFileBytes: 32 } });
    expect(m.entries).toHaveLength(1);
    expect(m.entries[0].tooLarge).toBe(true);
    expect(m.entries[0].sha256).toBe(sha(big)); // still disclosed
    expect(m.transferableBytes).toBe(0);
  });

  it('headline exemption: <topic>.local.md is allowed past maxFileBytes up to headlineFileBytes', () => {
    writeConvention(`${TOPIC}.local.md`, Buffer.alloc(64, 'h'));
    const m = compute({ caps: { maxFileBytes: 32, headlineFileBytes: 128 } });
    expect(m.entries[0].tooLarge).toBeUndefined();
    const m2 = compute({ caps: { maxFileBytes: 32, headlineFileBytes: 48 } });
    expect(m2.entries[0].tooLarge).toBe(true);
  });

  it('maxFiles truncation is counted, deterministic, and never drops the headline', () => {
    writeConvention(`${TOPIC}.local.md`, 'headline');
    for (let i = 0; i < 5; i++) writeConvention(`${TOPIC}.f${i}.md`, `f${i}`);
    const m = compute({ caps: { maxFiles: 3 } });
    expect(m.entries).toHaveLength(3);
    expect(m.filesTruncated).toBe(3);
    expect(m.entries[0].relPath).toContain('.local.md'); // headline survives
  });
});

describe('WorkingSetManifest — secretFlagged + mtime + liveSource', () => {
  it('flags credential-shaped content, lists it, and excludes it from transferableBytes', () => {
    writeConvention(`${TOPIC}.creds.md`, 'token = "abcdef123456789012345"');
    writeConvention(`${TOPIC}.clean.md`, 'no secrets here');
    const m = compute();
    const flagged = m.entries.find((e) => e.relPath.includes('creds'))!;
    const clean = m.entries.find((e) => e.relPath.includes('clean'))!;
    expect(flagged.secretFlagged).toBe(true); // LISTED — honest refusal, not a silent skip
    expect(clean.secretFlagged).toBeUndefined();
    expect(m.transferableBytes).toBe(clean.bytes);
  });

  it('mtime is display-only: touching a file changes mtime but sha256 stays the decision key', () => {
    const p = writeConvention(`${TOPIC}.stable.md`, 'same content');
    const before = compute().entries[0];
    fs.utimesSync(p, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
    const after = compute().entries[0];
    expect(after.mtime).not.toBe(before.mtime);
    expect(after.sha256).toBe(before.sha256);
  });

  it('liveRun marks EVERY entry liveSource and zeroes transferableBytes', () => {
    writeConvention(`${TOPIC}.local.md`, 'headline');
    writeConvention(`${TOPIC}.notes.md`, 'notes');
    const m = compute({ runs: noRuns({ liveRun: true }) });
    expect(m.liveRun).toBe(true);
    expect(m.entries.every((e) => e.liveSource === true)).toBe(true);
    expect(m.transferableBytes).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// CoherenceJournalReader.readOwnAutonomousRuns
// ---------------------------------------------------------------------------

const OWN = 'm_own';
const PEER = 'm_peer';

function journalDir(): string {
  return path.join(tmpDir, 'state', 'coherence-journal');
}

function writeStream(
  scope: 'own' | 'peers',
  machine: string,
  entries: JournalEntry[],
): void {
  const dir = scope === 'own' ? journalDir() : path.join(journalDir(), 'peers');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${machine}.autonomous-run.jsonl`);
  fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

function runEntry(
  machine: string,
  seq: number,
  topic: number,
  action: 'started' | 'stopped',
  runId: string,
  artifactPaths: string[] = [],
): JournalEntry {
  return {
    seq,
    ts: `2026-06-06T00:00:${String(seq).padStart(2, '0')}.000Z`,
    machine,
    kind: 'autonomous-run',
    topic,
    data: { action, runId, artifactPaths },
  };
}

describe('CoherenceJournalReader.readOwnAutonomousRuns', () => {
  it('reads OWN stream only — a replica with matching machineId never feeds the manifest', () => {
    writeStream('own', OWN, [runEntry(OWN, 1, TOPIC, 'started', 'r1', ['/tmp/own.md'])]);
    writeStream('peers', PEER, [runEntry(PEER, 1, TOPIC, 'started', 'r9', ['/tmp/peer.md'])]);
    const reader = new CoherenceJournalReader({ stateDir: tmpDir });
    const own = reader.readOwnAutonomousRuns(TOPIC, OWN);
    expect(own.entries).toHaveLength(1);
    expect(own.artifactPaths).toEqual(['/tmp/own.md']);
    // The peer's machine id yields nothing from the own dir either:
    const peerAsOwn = reader.readOwnAutonomousRuns(TOPIC, PEER);
    expect(peerAsOwn.entries).toHaveLength(0);
  });

  it('liveRun true when the newest run has started without stopped', () => {
    writeStream('own', OWN, [
      runEntry(OWN, 1, TOPIC, 'started', 'r1'),
      runEntry(OWN, 2, TOPIC, 'stopped', 'r1'),
      runEntry(OWN, 3, TOPIC, 'started', 'r2'),
    ]);
    const reader = new CoherenceJournalReader({ stateDir: tmpDir });
    expect(reader.readOwnAutonomousRuns(TOPIC, OWN).liveRun).toBe(true);
  });

  it('liveRun false when the newest run is stopped (an older crashed run does not resurrect it)', () => {
    writeStream('own', OWN, [
      runEntry(OWN, 1, TOPIC, 'started', 'r0'), // never stopped (crash) — older
      runEntry(OWN, 2, TOPIC, 'started', 'r1'),
      runEntry(OWN, 3, TOPIC, 'stopped', 'r1'),
    ]);
    const reader = new CoherenceJournalReader({ stateDir: tmpDir });
    expect(reader.readOwnAutonomousRuns(TOPIC, OWN).liveRun).toBe(false);
  });

  it('filters by topic and unions artifactPaths deduped, newest-first', () => {
    writeStream('own', OWN, [
      runEntry(OWN, 1, TOPIC, 'started', 'r1', ['/a.md', '/b.md']),
      runEntry(OWN, 2, 999, 'started', 'rX', ['/other-topic.md']),
      runEntry(OWN, 3, TOPIC, 'stopped', 'r1', ['/b.md', '/c.md']),
    ]);
    const reader = new CoherenceJournalReader({ stateDir: tmpDir });
    const own = reader.readOwnAutonomousRuns(TOPIC, OWN);
    expect(own.entries).toHaveLength(2);
    expect(own.artifactPaths).toEqual(['/b.md', '/c.md', '/a.md']); // newest entry's paths first
  });

  it('empty stream set → empty result, liveRun false, no throw', () => {
    const reader = new CoherenceJournalReader({ stateDir: tmpDir });
    const own = reader.readOwnAutonomousRuns(TOPIC, OWN);
    expect(own.entries).toHaveLength(0);
    expect(own.liveRun).toBe(false);
    expect(own.artifactPaths).toEqual([]);
    expect(own.truncated).toBe(false);
  });
});
