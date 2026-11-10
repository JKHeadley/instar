// safe-fs-allow: test file — temp dirs via mkdtemp/rm only.
// safe-git-allow: test file — no git calls.
/**
 * The engine checkpoint (context-budget-layered-summaries §9.3 steps 3 and 8,
 * §18): byte-exact even with scrub-triggering and oversize entries; restore
 * resumes or materialises; lifetime follows the fold record.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  takeEngineCheckpoint, readEngineCheckpoint, verifyEngineCheckpoint, restoreEngineCheckpoint,
  engineCheckpointCarrier, pruneSettledCheckpoints, contextArchiveRoot, lastEntryId, CHECKPOINT_GRACE_MS,
} from '../../src/monitoring/engineCheckpoint.js';
import type { FoldState } from '../../src/monitoring/FoldCoordinator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const OP = 'tests/unit/engine-checkpoint.test.ts';
const SID = '11111111-2222-3333-4444-555555555555';
const T = '141133';

describe('engine checkpoint', () => {
  let stateDir: string;
  let engineDir: string;
  let transcript: string;
  const line = (o: object) => JSON.stringify(o);
  const sha = (f: string) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-cp-'));
    engineDir = path.join(stateDir, 'engine-projects');
    fs.mkdirSync(engineDir);
    transcript = path.join(engineDir, `${SID}.jsonl`);
    const oversize = 'x'.repeat(1_200_000); // above the scrubber's 1 MB fail-safe
    fs.writeFileSync(transcript, [
      line({ type: 'user', uuid: 'u1', sessionId: SID, message: { content: 'my key is sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' } }),
      line({ type: 'assistant', uuid: 'u2', sessionId: SID, message: { content: oversize } }),
      line({ type: 'summary', summary: 'no uuid on this line' }),
      '',
    ].join('\n'));
  });
  afterEach(() => SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: OP }));

  const take = (foldId = 'fold1') => {
    const r = takeEngineCheckpoint(stateDir, { topicKey: T, foldId, sessionId: SID, transcriptPath: transcript });
    if (!r.ok) throw new Error(r.reason);
    return r.checkpoint;
  };

  it('is a byte-exact copy (secret-shaped and oversize entries intact), 0600 in 0700 dirs', () => {
    const c = take();
    const copy = path.join(contextArchiveRoot(stateDir), c.file);
    expect(sha(copy)).toBe(sha(transcript));
    expect(c.sha256).toBe(sha(transcript));
    expect(c.lastEntryId).toBe('u2'); // the last line WITH a uuid
    expect(fs.statSync(copy).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(copy)).mode & 0o777).toBe(0o700);
    expect(readEngineCheckpoint(stateDir, T, 'fold1')).toMatchObject({ foldId: 'fold1', sessionId: SID });
    expect(verifyEngineCheckpoint(stateDir, c)).toBe(true);
  });

  it('refuses unsafe ids and a missing transcript', () => {
    expect(takeEngineCheckpoint(stateDir, { topicKey: '../x', foldId: 'f', sessionId: SID, transcriptPath: transcript }).ok).toBe(false);
    expect(takeEngineCheckpoint(stateDir, { topicKey: T, foldId: 'f', sessionId: SID, transcriptPath: transcript + '.nope' })).toEqual({ ok: false, reason: 'no-transcript' });
  });

  it('restore resumes the recorded session when its transcript still ends at the checkpoint entry', () => {
    const c = take();
    expect(restoreEngineCheckpoint(stateDir, c, { currentTranscriptPath: transcript, engineTranscriptDir: engineDir, newSessionId: () => crypto.randomUUID() }))
      .toEqual({ mode: 'resume', sessionId: SID });
  });

  it('restore MATERIALISES a new session transcript when the recorded one moved on (sessionId rewritten, content intact)', () => {
    const c = take();
    fs.appendFileSync(transcript, line({ type: 'user', uuid: 'u3', sessionId: SID, message: { content: 'post-fold turn' } }) + '\n');
    const newId = crypto.randomUUID();
    const r = restoreEngineCheckpoint(stateDir, c, { currentTranscriptPath: transcript, engineTranscriptDir: engineDir, newSessionId: () => newId });
    expect(r).toMatchObject({ mode: 'materialised', sessionId: newId });
    if (r.mode !== 'materialised') throw new Error('expected materialised');
    const orig = fs.readFileSync(path.join(contextArchiveRoot(stateDir), c.file), 'utf-8').split('\n');
    const made = fs.readFileSync(r.transcriptPath, 'utf-8').split('\n');
    expect(made).toHaveLength(orig.length);
    for (let i = 0; i < orig.length; i++) {
      if (!orig[i]) { expect(made[i]).toBe(''); continue; }
      const a = JSON.parse(orig[i]); const b = JSON.parse(made[i]);
      if ('sessionId' in a) { expect(b.sessionId).toBe(newId); a.sessionId = newId; }
      expect(b).toEqual(a);
    }
    expect(lastEntryId(r.transcriptPath)).toBe('u2');
    expect(sha(path.join(contextArchiveRoot(stateDir), c.file))).toBe(c.sha256); // the checkpoint itself is untouched
  });

  it('a tampered checkpoint is never restored (degraded)', () => {
    const c = take();
    fs.appendFileSync(path.join(contextArchiveRoot(stateDir), c.file), 'tamper');
    expect(restoreEngineCheckpoint(stateDir, c, { currentTranscriptPath: null, engineTranscriptDir: engineDir, newSessionId: () => crypto.randomUUID() }))
      .toEqual({ mode: 'degraded', reason: 'checkpoint-unverifiable' });
  });

  describe('second-pass review fixes', () => {
    it('a second take for the same fold never replaces the immutable checkpoint', () => {
      const c = take();
      fs.appendFileSync(transcript, line({ type: 'user', uuid: 'post', sessionId: SID }) + '\n');
      expect(takeEngineCheckpoint(stateDir, { topicKey: T, foldId: 'fold1', sessionId: SID, transcriptPath: transcript })).toEqual({ ok: false, reason: 'checkpoint-exists' });
      expect(readEngineCheckpoint(stateDir, T, 'fold1')?.sha256).toBe(c.sha256);
    });

    it('materialise preserves every byte except the session id token (numbers, escapes, CRLF)', () => {
      const raw = `{"type":"user","uuid":"r1","sessionId":"${SID}","n":1.0,"big":12345678901234567890,"esc":"\\u00e9\\/"}\r\n{"type":"x","uuid":"r2","sessionId":"${SID}"}\n`;
      fs.writeFileSync(transcript, raw);
      const c = take('foldRaw');
      const newId = crypto.randomUUID();
      const r = restoreEngineCheckpoint(stateDir, c, { currentTranscriptPath: null, engineTranscriptDir: engineDir, newSessionId: () => newId });
      if (r.mode !== 'materialised') throw new Error(r.mode);
      expect(fs.readFileSync(r.transcriptPath, 'utf-8')).toBe(raw.split(SID).join(newId));
    });

    it('refuses an existing target and a non-UUID new id', () => {
      const c = take();
      const id = crypto.randomUUID();
      fs.writeFileSync(path.join(engineDir, `${id}.jsonl`), 'x');
      expect(restoreEngineCheckpoint(stateDir, c, { currentTranscriptPath: null, engineTranscriptDir: engineDir, newSessionId: () => id })).toEqual({ mode: 'degraded', reason: 'target-exists' });
      expect(restoreEngineCheckpoint(stateDir, c, { currentTranscriptPath: null, engineTranscriptDir: engineDir, newSessionId: () => '../evil' })).toEqual({ mode: 'degraded', reason: 'bad-session-id' });
    });

    it('a materialise that rewrites no session id token is degraded, not silently "materialised"', () => {
      fs.writeFileSync(transcript, `{"type":"user","uuid":"s1","sessionId": "${SID}"}\n`); // non-compact writer
      const c = take('foldSpaced');
      expect(restoreEngineCheckpoint(stateDir, c, { currentTranscriptPath: null, engineTranscriptDir: engineDir, newSessionId: () => crypto.randomUUID() }))
        .toEqual({ mode: 'degraded', reason: 'session-id-not-found' });
    });

    it('a symlinked archive directory is refused and nothing is written at the link target', () => {
      const elsewhere = path.join(stateDir, 'elsewhere');
      fs.mkdirSync(elsewhere);
      fs.mkdirSync(contextArchiveRoot(stateDir), { recursive: true });
      fs.symlinkSync(elsewhere, path.join(contextArchiveRoot(stateDir), T));
      expect(takeEngineCheckpoint(stateDir, { topicKey: T, foldId: 'fl', sessionId: SID, transcriptPath: transcript })).toEqual({ ok: false, reason: 'symlinked-archive-dir' });
      expect(fs.readdirSync(elsewhere)).toEqual([]);
    });

    it('a pre-planted temp link is never written through (another fold\'s copy survives)', () => {
      const other = take('foldOther');
      const dir = path.join(contextArchiveRoot(stateDir), T, 'checkpoints');
      fs.symlinkSync(path.join(dir, 'foldOther.jsonl'), path.join(dir, 'foldNew.jsonl.tmp'));
      fs.appendFileSync(transcript, line({ type: 'user', uuid: 'later', sessionId: SID }) + '\n');
      expect(takeEngineCheckpoint(stateDir, { topicKey: T, foldId: 'foldNew', sessionId: SID, transcriptPath: transcript }).ok).toBe(true);
      expect(sha(path.join(dir, 'foldOther.jsonl'))).toBe(other.sha256);
    });

    it('a stale pointer temp file alone is an orphan the sweep removes', () => {
      const dir = path.join(contextArchiveRoot(stateDir), T, 'checkpoints');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'lone.json.tmp'), '{}');
      const c = engineCheckpointCarrier(stateDir, () => null);
      expect(c.list()).toEqual([{ topicKey: T, foldId: 'lone' }]);
      c.release(T, 'lone');
      expect(fs.readdirSync(dir)).toEqual([]);
    });

    it('a pointer naming any file but its own copy is not a checkpoint', () => {
      const c = take();
      const p = path.join(contextArchiveRoot(stateDir), T, 'checkpoints', 'fold1.json');
      fs.writeFileSync(p, JSON.stringify({ ...c, file: '../../../outside.txt' }));
      expect(readEngineCheckpoint(stateDir, T, 'fold1')).toBeNull();
    });
  });

  describe('lifetime (carrier + grace)', () => {
    let state: Record<string, FoldState | null>;
    let now: number;
    const carrier = () => engineCheckpointCarrier(stateDir, (_t, f) => state[f] ?? null, () => now);
    beforeEach(() => { state = {}; now = 1_000_000; });

    it('a COMMITTED fold deletes its checkpoint at release', () => {
      take(); state.fold1 = 'committed';
      carrier().release(T, 'fold1');
      expect(readEngineCheckpoint(stateDir, T, 'fold1')).toBeNull();
      expect(fs.readdirSync(path.join(contextArchiveRoot(stateDir), T, 'checkpoints'))).toEqual([]);
    });

    it('a rolled-back fold keeps it for the grace period, then the sentinel prunes it', () => {
      take(); state.fold1 = 'rolled-back';
      carrier().release(T, 'fold1');
      expect(readEngineCheckpoint(stateDir, T, 'fold1')?.settledAt).toBe(now);
      expect(carrier().list()).toEqual([]); // settled: no longer offered to the sweep
      expect(pruneSettledCheckpoints(stateDir, now + CHECKPOINT_GRACE_MS - 1)).toEqual([]);
      expect(pruneSettledCheckpoints(stateDir, now + CHECKPOINT_GRACE_MS)).toEqual(['fold1']);
      expect(readEngineCheckpoint(stateDir, T, 'fold1')).toBeNull();
    });

    it('an ABORTED fold (context never replaced) deletes its checkpoint at once', () => {
      take(); state.fold1 = 'aborted';
      carrier().release(T, 'fold1');
      expect(readEngineCheckpoint(stateDir, T, 'fold1')).toBeNull();
    });

    it('a stale pointer temp file is removed with its fold (no permanent orphan)', () => {
      take();
      const dir = path.join(contextArchiveRoot(stateDir), T, 'checkpoints');
      fs.writeFileSync(path.join(dir, 'fold1.json.tmp'), '{}');
      carrier().release(T, 'fold1');
      expect(fs.readdirSync(dir)).toEqual([]);
      expect(carrier().list()).toEqual([]);
    });

    it('a checkpoint with no record is an orphan and is removed', () => {
      take();
      expect(carrier().list()).toEqual([{ topicKey: T, foldId: 'fold1' }]);
      carrier().release(T, 'fold1');
      expect(readEngineCheckpoint(stateDir, T, 'fold1')).toBeNull();
    });
  });
});
