/**
 * Machine-coherence episode durable state layer (machine-coherence-guard §4.1 +
 * §4.6): episodeId minting, the atomic transition-write, and the read that
 * distinguishes absent / ok / corrupt so the caller can re-baseline without
 * crashing. The state MACHINE (transitions) is a separate unit — this covers
 * only the persistence primitives.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  mintEpisodeId,
  episodeStatePath,
  emptyRecurrence,
  readEpisodeFile,
  writeEpisodeFile,
  type EpisodeFile,
} from '../../src/monitoring/machineCoherenceEpisode.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-episode-'));
});
afterEach(() => {
  SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/machine-coherence-episode.test.ts' });
});

function file(over: Partial<EpisodeFile> = {}): EpisodeFile {
  return { version: 1, episode: null, recurrence: emptyRecurrence(), ...over };
}

describe('mintEpisodeId (§4.1, N4)', () => {
  it('mints mc-<openedAtMs>', () => {
    expect(mintEpisodeId(1_751_500_000_000)).toBe('mc-1751500000000');
  });
});

describe('episodeStatePath (N7 — per-agent state subdir)', () => {
  it('lives under <stateDir>/state/, never a global path', () => {
    expect(episodeStatePath('/agents/echo')).toBe('/agents/echo/state/machine-coherence-episode.json');
  });
});

describe('readEpisodeFile — absent / ok / corrupt (§4.6 re-baseline gate)', () => {
  it('absent file → { status: absent } (never a throw, never a silent {})', () => {
    expect(readEpisodeFile(dir)).toEqual({ status: 'absent' });
  });

  it('round-trips a written file (ok)', () => {
    const f = file({
      episode: {
        episodeId: mintEpisodeId(1000),
        openedAtMs: 1000,
        skewRowIdentities: ['flag|ws13Reconcile|m_a=live,m_b=dark'],
        recurrence: emptyRecurrence(),
      },
    });
    writeEpisodeFile(dir, f);
    const r = readEpisodeFile(dir);
    expect(r.status).toBe('ok');
    if (r.status === 'ok') expect(r.file).toEqual(f);
  });

  it('reads a between-episodes file (episode:null, recurrence persists)', () => {
    const f = file({ recurrence: { newItemTimestamps: [500], recentlyClosed: [{ rowIdentities: ['x'], closedAtMs: 400 }] } });
    writeEpisodeFile(dir, f);
    const r = readEpisodeFile(dir);
    expect(r.status).toBe('ok');
    if (r.status === 'ok') expect(r.file.episode).toBeNull();
  });

  it('invalid JSON → corrupt (invalid-json)', () => {
    fs.mkdirSync(path.dirname(episodeStatePath(dir)), { recursive: true });
    fs.writeFileSync(episodeStatePath(dir), '{not json');
    expect(readEpisodeFile(dir)).toEqual({ status: 'corrupt', reason: 'invalid-json' });
  });

  it('wrong version → corrupt (bad-version)', () => {
    fs.mkdirSync(path.dirname(episodeStatePath(dir)), { recursive: true });
    fs.writeFileSync(episodeStatePath(dir), JSON.stringify({ version: 2, episode: null, recurrence: emptyRecurrence() }));
    expect(readEpisodeFile(dir).status).toBe('corrupt');
  });

  it('missing recurrence → corrupt', () => {
    fs.mkdirSync(path.dirname(episodeStatePath(dir)), { recursive: true });
    fs.writeFileSync(episodeStatePath(dir), JSON.stringify({ version: 1, episode: null }));
    expect(readEpisodeFile(dir)).toEqual({ status: 'corrupt', reason: 'missing-recurrence' });
  });

  it('malformed episode shape → corrupt (episode-shape)', () => {
    fs.mkdirSync(path.dirname(episodeStatePath(dir)), { recursive: true });
    fs.writeFileSync(episodeStatePath(dir), JSON.stringify({ version: 1, episode: { episodeId: 'x' }, recurrence: emptyRecurrence() }));
    expect(readEpisodeFile(dir)).toEqual({ status: 'corrupt', reason: 'episode-shape' });
  });

  it('malformed recurrence shape → corrupt (recurrence-shape)', () => {
    fs.mkdirSync(path.dirname(episodeStatePath(dir)), { recursive: true });
    fs.writeFileSync(episodeStatePath(dir), JSON.stringify({ version: 1, episode: null, recurrence: { newItemTimestamps: 'nope' } }));
    expect(readEpisodeFile(dir).status).toBe('corrupt');
  });
});

describe('writeEpisodeFile — atomic tmp+rename (§4.1)', () => {
  it('creates the state/ subdir when absent and leaves no tmp file behind', () => {
    writeEpisodeFile(dir, file());
    expect(fs.existsSync(episodeStatePath(dir))).toBe(true);
    const leftovers = fs.readdirSync(path.join(dir, 'state')).filter((n) => n.includes('.tmp.'));
    expect(leftovers).toEqual([]);
  });

  it('is repeatable — a second write replaces the first (last-writer-wins)', () => {
    writeEpisodeFile(dir, file({ recurrence: { newItemTimestamps: [1], recentlyClosed: [] } }));
    writeEpisodeFile(dir, file({ recurrence: { newItemTimestamps: [2], recentlyClosed: [] } }));
    const r = readEpisodeFile(dir);
    if (r.status === 'ok') expect(r.file.recurrence.newItemTimestamps).toEqual([2]);
  });
});
