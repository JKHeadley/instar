/**
 * Unit tests for placeResumeTranscript (docs/specs/resume-follows-account.md §3.1).
 *
 * Hermetic: a temp home directory with fake Claude login folders; no real
 * claude binary. Covers both sides of each placement decision, and the
 * no-loss rule (a copy is never deleted or truncated).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  placeResumeTranscript,
  lastRecordTimestamp,
  firstCwdRecordEntrypoint,
  claudeConfigHomes,
} from '../../src/core/claudeResumeTranscript.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const UUID = '56f6396f-85ff-4e3a-8003-9ed6c3bf5ca2';
const SLUG = '-Users-justin-Documents-Projects-sagemind';

/** Real interactive transcript head shape: header records carry no cwd; the first cwd record is an attachment with entrypoint. */
function record(type: string, ts: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type, timestamp: ts, sessionId: UUID, ...extra });
}
function interactiveTranscript(turns: string[]): string {
  const head = [
    JSON.stringify({ type: 'last-prompt', lastPrompt: 'x', sessionId: UUID }),
    JSON.stringify({ type: 'mode', mode: 'default', sessionId: UUID }),
    record('attachment', '2026-09-12T00:00:00.000Z', { cwd: '/Users/justin/Documents/Projects/sagemind', entrypoint: 'cli' }),
  ];
  return [...head, ...turns].join('\n') + '\n';
}

describe('placeResumeTranscript', () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-place-'));
  });
  afterEach(() => {
    try {
      SafeFsExecutor.safeRmSync(home, { recursive: true, force: true, operation: 'tests/unit/claude-resume-transcript.test.ts:cleanup' });
    } catch { /* @silent-fallback-ok */ }
  });

  function write(login: string, content: string, slug = SLUG): string {
    const dir = path.join(home, login, 'projects', slug);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${UUID}.jsonl`);
    fs.writeFileSync(file, content);
    return file;
  }
  const target = (login: string, slug = SLUG) => path.join(home, login, 'projects', slug, `${UUID}.jsonl`);

  it('copies the conversation into a login that lacks it (the incident shape)', async () => {
    const content = interactiveTranscript([record('user', '2026-09-15T23:34:31.416Z')]);
    write('.claude-followme-sagemind-adriana', content);
    const outcome = await placeResumeTranscript(UUID, path.join(home, '.claude-followme-sagemind-dawn'), home);
    expect(outcome).toBe('copied');
    expect(fs.readFileSync(target('.claude-followme-sagemind-dawn'), 'utf-8')).toBe(content);
    expect(fs.statSync(target('.claude-followme-sagemind-dawn')).mode & 0o777).toBe(0o600);
  });

  it('returns present when the target login already has the freshest copy', async () => {
    const content = interactiveTranscript([record('user', '2026-09-15T23:34:31.416Z')]);
    write('.claude-followme-sagemind-dawn', content);
    write('.claude-followme-sagemind-adriana', interactiveTranscript([record('user', '2026-09-12T05:07:20.118Z')]));
    expect(await placeResumeTranscript(UUID, path.join(home, '.claude-followme-sagemind-dawn'), home)).toBe('present');
  });

  it('chooses the copy with the latest record, not the first one found or the newest mtime', async () => {
    const older = interactiveTranscript([record('user', '2026-09-12T05:07:20.118Z')]);
    const newer = interactiveTranscript([record('user', '2026-09-15T23:34:31.416Z')]);
    const olderFile = write('.claude-followme-sagemind-justin', older);
    write('.claude-followme-sagemind-adriana', newer);
    // The stale copy has the most recent mtime.
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(olderFile, future, future);
    expect(await placeResumeTranscript(UUID, path.join(home, '.claude-followme-sagemind-dawn'), home)).toBe('copied');
    expect(fs.readFileSync(target('.claude-followme-sagemind-dawn'), 'utf-8')).toBe(newer);
  });

  it('replaces an older copy that is a byte-prefix of the freshest one', async () => {
    const base = interactiveTranscript([record('user', '2026-09-12T05:07:20.118Z')]);
    const extended = base + record('assistant', '2026-09-15T23:34:31.416Z') + '\n';
    write('.claude-followme-sagemind-justin', base);
    write('.claude-followme-sagemind-adriana', extended);
    expect(await placeResumeTranscript(UUID, path.join(home, '.claude-followme-sagemind-justin'), home)).toBe('replaced');
    expect(fs.readFileSync(target('.claude-followme-sagemind-justin'), 'utf-8')).toBe(extended);
    const aside = fs.readdirSync(path.dirname(target('.claude-followme-sagemind-justin'))).filter((n) => n.includes('.forked-'));
    expect(aside).toEqual([]);
  });

  it('sets a diverged copy aside instead of overwriting it, keeping every byte', async () => {
    const base = interactiveTranscript([record('user', '2026-09-11T10:00:00.000Z')]);
    const branchA = base + record('assistant', '2026-09-11T15:04:00.000Z', { text: 'only in justin' }) + '\n';
    const branchB = base + record('assistant', '2026-09-15T05:41:28.148Z', { text: 'only in adriana' }) + '\n';
    write('.claude-followme-sagemind-justin', branchA);
    write('.claude-followme-sagemind-adriana', branchB);
    expect(await placeResumeTranscript(UUID, path.join(home, '.claude-followme-sagemind-justin'), home)).toBe('forked');
    const dir = path.dirname(target('.claude-followme-sagemind-justin'));
    expect(fs.readFileSync(target('.claude-followme-sagemind-justin'), 'utf-8')).toBe(branchB);
    const aside = fs.readdirSync(dir).filter((n) => n.startsWith(`${UUID}.jsonl.forked-`));
    expect(aside).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, aside[0]), 'utf-8')).toBe(branchA);
  });

  it('leaves exactly one openable copy when the target login holds a stale copy under another project folder', async () => {
    write('.claude-followme-sagemind-dawn', interactiveTranscript([record('user', '2026-09-10T00:00:00.000Z')]), '-other-slug');
    const fresh = interactiveTranscript([record('user', '2026-09-15T23:34:31.416Z')]);
    write('.claude-followme-sagemind-adriana', fresh);
    expect(await placeResumeTranscript(UUID, path.join(home, '.claude-followme-sagemind-dawn'), home)).toBe('copied');
    const otherDir = path.join(home, '.claude-followme-sagemind-dawn', 'projects', '-other-slug');
    const names = fs.readdirSync(otherDir);
    expect(names.some((n) => n === `${UUID}.jsonl`)).toBe(false);
    expect(names.some((n) => n.startsWith(`${UUID}.jsonl.forked-`))).toBe(true);
  });

  it('copies attachments the target lacks without overwriting existing ones', async () => {
    write('.claude-followme-sagemind-adriana', interactiveTranscript([record('user', '2026-09-15T23:34:31.416Z')]));
    const srcAttach = path.join(home, '.claude-followme-sagemind-adriana', 'projects', SLUG, UUID, 'tool-results');
    fs.mkdirSync(srcAttach, { recursive: true });
    fs.writeFileSync(path.join(srcAttach, 'a.txt'), 'from source');
    fs.writeFileSync(path.join(srcAttach, 'b.txt'), 'from source');
    const dstAttach = path.join(home, '.claude-followme-sagemind-dawn', 'projects', SLUG, UUID, 'tool-results');
    fs.mkdirSync(dstAttach, { recursive: true });
    fs.writeFileSync(path.join(dstAttach, 'b.txt'), 'already here');
    expect(await placeResumeTranscript(UUID, path.join(home, '.claude-followme-sagemind-dawn'), home)).toBe('copied');
    expect(fs.readFileSync(path.join(dstAttach, 'a.txt'), 'utf-8')).toBe('from source');
    expect(fs.readFileSync(path.join(dstAttach, 'b.txt'), 'utf-8')).toBe('already here');
  });

  it('refuses an internal one-shot transcript as a resume target', async () => {
    const oneShot = [
      JSON.stringify({ type: 'queue-operation', operation: 'enqueue', sessionId: UUID }),
      JSON.stringify({ type: 'queue-operation', operation: 'dequeue', sessionId: UUID }),
      record('user', '2026-09-16T17:45:58.937Z', { cwd: '/Users/justin/Documents/Projects/sagemind', entrypoint: 'sdk-cli' }),
    ].join('\n') + '\n';
    write('.claude', oneShot);
    expect(await placeResumeTranscript(UUID, path.join(home, '.claude-followme-sagemind-dawn'), home)).toBe('one-shot');
    expect(fs.existsSync(target('.claude-followme-sagemind-dawn'))).toBe(false);
  });

  it('returns not-found when no login has the conversation', async () => {
    fs.mkdirSync(path.join(home, '.claude', 'projects', SLUG), { recursive: true });
    expect(await placeResumeTranscript(UUID, path.join(home, '.claude-followme-sagemind-dawn'), home)).toBe('not-found');
  });

  it('never builds a path from a non-canonical id', async () => {
    expect(await placeResumeTranscript('../../etc/passwd', path.join(home, '.claude'), home)).toBe('not-found');
  });
});

describe('transcript readers', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-read-')); });
  afterEach(() => {
    try { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/claude-resume-transcript.test.ts:cleanup' }); } catch { /* @silent-fallback-ok */ }
  });

  it('finds the last timestamp past a final line larger than one read chunk', () => {
    const file = path.join(dir, 't.jsonl');
    const big = JSON.stringify({ type: 'tool-result', content: 'é'.repeat(400_000) }); // no timestamp, multi-byte, > 256 KiB
    fs.writeFileSync(file, record('user', '2026-09-15T23:34:31.416Z') + '\n' + big + '\n');
    expect(lastRecordTimestamp(file)).toBe('2026-09-15T23:34:31.416Z');
  });

  it('reads the entrypoint from the first record that carries cwd, skipping header records', () => {
    const file = path.join(dir, 'h.jsonl');
    fs.writeFileSync(file, interactiveTranscript([]));
    expect(firstCwdRecordEntrypoint(file)).toBe('cli');
  });

  it('lists ~/.claude and ~/.claude-* login folders only', () => {
    fs.mkdirSync(path.join(dir, '.claude'));
    fs.mkdirSync(path.join(dir, '.claude-followme-a'));
    fs.mkdirSync(path.join(dir, '.codex'));
    fs.writeFileSync(path.join(dir, '.claude.json'), '{}');
    expect(claudeConfigHomes(dir).map((h) => path.basename(h)).sort()).toEqual(['.claude', '.claude-followme-a']);
  });
});
