/**
 * native-conversation-any-machine-access §3d — the `session-transcript-pull` verb (serve side), the
 * oversized-row rule, and the transcript audience rule, on both sides of every boundary.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSessionTranscriptPullHandler, sessionConversations, type SessionTranscriptPullResponse } from '../../src/core/sessionTranscriptPull.js';
import { resolveTranscriptAudience, type TranscriptAudienceInput } from '../../src/core/transcriptAudience.js';
import { cutUtf8 } from '../../src/core/oversizedRow.js';
import { redactForDevice } from '../../src/server/mobileSessionTerminalRoutes.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const TOKEN = 'tok-0123456789abcdef-secret';
const PIN = '482913';
const clean = (s: string) => redactForDevice(s, [TOKEN, PIN]);

let dir = '';
afterEach(() => { if (dir) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/sessionTranscriptPull.test.ts' }); dir = ''; });
function write(lines: unknown[]): string {
  const base = process.env.TMPDIR && !process.env.TMPDIR.includes('/.') ? process.env.TMPDIR : os.tmpdir();
  dir = fs.mkdtempSync(path.join(base, 'stp-'));
  const f = path.join(dir, 't.jsonl');
  fs.writeFileSync(f, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return f;
}
const user = (text: string) => ({ type: 'user', timestamp: '2026-11-11T00:00:00Z', message: { role: 'user', content: text } });
/** One record with several entries: text blocks and a tool call. */
const multi = (n: number, texts: string[]) => ({ type: 'assistant', message: { content: [...texts.map((t) => ({ type: 'text', text: `${n}:${t}` })), { type: 'tool_use', name: 'Bash', input: { command: `echo ${n}` } }] } });

type Ok = Extract<SessionTranscriptPullResponse, { ok: true; mode: 'transcript' }>;
function handlerFor(file: string | null, opts: { maxBytes?: number; conversations?: string[] } = {}) {
  return createSessionTranscriptPullHandler({
    clean, maxBytes: opts.maxBytes,
    findSession: (name) => (name === 'echo-s1' ? { filePath: file, conversations: opts.conversations ?? ['telegram:42'] } : null),
  });
}
async function ok(p: Promise<SessionTranscriptPullResponse>): Promise<Ok> {
  const r = await p;
  if (!r.ok || r.mode !== 'transcript') throw new Error(`not ok: ${JSON.stringify(r)}`);
  return r;
}

describe('session-transcript-pull: serve side', () => {
  it('an unknown session, a malformed name and a path are refused; it serves only recorded sessions', async () => {
    const h = handlerFor(write([user('hi')]));
    expect(await h({ mode: 'transcript', session: 'echo-other' })).toEqual({ ok: false, reason: 'unknown-session' });
    expect(await h({ mode: 'transcript', session: '../../etc/passwd' })).toEqual({ ok: false, reason: 'malformed' });
    expect(await h({ mode: 'transcript', session: '/Users/x/.claude/projects/a.jsonl' })).toEqual({ ok: false, reason: 'malformed' });
    expect(await h({ mode: 'bogus', session: 'echo-s1' })).toEqual({ ok: false, reason: 'malformed' });
    expect(await handlerFor(null)({ mode: 'transcript', session: 'echo-s1' })).toEqual({ ok: false, reason: 'no-transcript', conversations: ['telegram:42'] });
  });

  it('names the conversations the session served on every answer', async () => {
    const r = await ok(handlerFor(write([user('hi')]), { conversations: ['telegram:7', 'app-abc'] })({ mode: 'transcript', session: 'echo-s1' }));
    expect(r.conversations).toEqual(['telegram:7', 'app-abc']);
    expect(sessionConversations({ telegramTopicId: 7, memoryPlaceInput: { memoryPlaceKey: 'app:abc' } })).toEqual(['abc', 'telegram:7']);
    expect(sessionConversations({})).toEqual([]);
  });

  it('removes the token and PIN before anything is clipped', async () => {
    const r = await ok(handlerFor(write([user(`my token is ${TOKEN} and pin ${PIN}`)]))({ mode: 'transcript', session: 'echo-s1' }));
    expect(JSON.stringify(r)).not.toContain(TOKEN);
    expect(JSON.stringify(r)).not.toContain(PIN);
    expect(r.entries[0].text).toContain('[redacted]');
  });

  it('an entry over 4,000 characters is marked clipped, and is whole with full', async () => {
    const long = 'y'.repeat(9000);
    const f = write([user('short'), user(long)]);
    const clipped = await ok(handlerFor(f)({ mode: 'transcript', session: 'echo-s1' }));
    expect(clipped.entries[1].clipped).toBe(true);
    expect(clipped.entries[1].text.length).toBe(4001);
    expect(clipped.entries[0].clipped).toBeUndefined();
    const whole = await ok(handlerFor(f)({ mode: 'transcript', session: 'echo-s1', full: true }));
    expect(whole.entries[1].text).toBe(long);
    expect(whole.entries[1].clipped).toBeUndefined();
  });

  it('truncation keeps the newest entries and returns the cursor', async () => {
    const lines = Array.from({ length: 40 }, (_, i) => user(`message ${i} ${'z'.repeat(300)}`));
    const r = await ok(handlerFor(write(lines), { maxBytes: 4000 })({ mode: 'transcript', session: 'echo-s1' }));
    expect(r.truncated).toBe(true);
    expect(r.entries.length).toBeGreaterThan(0);
    expect(r.entries.length).toBeLessThan(40);
    expect(r.entries[r.entries.length - 1].text).toContain('message 39');
    expect(Buffer.byteLength(JSON.stringify(r))).toBeLessThanOrEqual(4000);
    expect(r.nextBefore).toBe(r.entries[0].offset);
  });

  it('a byte cap that falls inside a multi-entry record: paging with before returns every entry exactly once', async () => {
    const lines: unknown[] = [];
    for (let i = 0; i < 30; i++) lines.push(i % 3 ? multi(i, ['a'.repeat(200), 'b'.repeat(200), 'c'.repeat(200)]) : user(`u${i}`));
    const f = write(lines);
    const h = handlerFor(f, { maxBytes: 2600 });
    const seen: string[] = [];
    let before: number | undefined;
    let beforeIndex: number | undefined;
    let midRecordCut = false;
    for (let guard = 0; guard < 200; guard++) {
      const r = await ok(h({ mode: 'transcript', session: 'echo-s1', ...(before !== undefined ? { before } : {}), ...(beforeIndex ? { beforeIndex } : {}) }));
      seen.unshift(...r.entries.map((e) => `${e.offset}#${e.index}`));
      if (r.nextBeforeIndex) midRecordCut = true;
      if (r.nextBefore === null) break;
      expect([r.nextBefore, r.nextBeforeIndex ?? 0]).not.toEqual([before, beforeIndex ?? 0]);
      before = r.nextBefore;
      beforeIndex = r.nextBeforeIndex;
    }
    expect(midRecordCut).toBe(true);
    // 10 user records × 1 entry + 20 multi records × 4 entries
    expect(seen).toHaveLength(10 + 20 * 4);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('list mode returns this machine\'s own sessions, capped', async () => {
    const h = createSessionTranscriptPullHandler({ clean, findSession: () => null, listSessions: async (q) => [{ tmuxSession: 'a', q }], maxBytes: 4096 });
    expect(await h({ mode: 'list', include: 'all' })).toEqual({ ok: true, mode: 'list', sessions: [{ tmuxSession: 'a', q: { include: 'all' } }] });
    const none = createSessionTranscriptPullHandler({ clean, findSession: () => null });
    expect(await none({ mode: 'list' })).toEqual({ ok: false, reason: 'list-unavailable' });
  });
});

describe('oversized row (transcript)', () => {
  it('one entry larger than the cap between two ordinary entries is returned alone, its continuation reads the rest byte for byte on UTF-8 boundaries, a token across the cut appears in neither piece, and paging reaches the older entry without the remainder', async () => {
    // Multi-byte text so a byte cut could split a character; the token straddles where the first cut would fall.
    const big = `${'é漢'.repeat(3000)}${TOKEN}${'ü'.repeat(4000)}`;
    const f = write([user('older ordinary'), user(big), user('newer ordinary')]);
    const maxBytes = 9 * 1024 + 3000;
    const h = handlerFor(f, { maxBytes });
    // Page 1 holds only the newest ordinary entry; page 2 starts at the big one.
    const p1 = await ok(h({ mode: 'transcript', session: 'echo-s1', full: true, limit: 2 }));
    expect(p1.entries.map((e) => e.text)).toEqual(['newer ordinary']);
    expect(p1.truncated).toBe(true);
    const p2 = await ok(h({ mode: 'transcript', session: 'echo-s1', full: true, before: p1.nextBefore!, ...(p1.nextBeforeIndex ? { beforeIndex: p1.nextBeforeIndex } : {}) }));
    expect(p2.entries).toHaveLength(1);
    const marker = p2.rowTruncated!;
    expect(marker).toBeDefined();
    expect(marker.from).toBe(0);
    expect(Buffer.byteLength(JSON.stringify(p2))).toBeLessThanOrEqual(maxBytes);
    const redacted = clean(big);
    expect(marker.totalBytes).toBe(Buffer.byteLength(redacted));
    const pieces: string[] = [p2.entries[0].text];
    let to = marker.to;
    for (let guard = 0; to < marker.totalBytes && guard < 50; guard++) {
      const c = await ok(h({ mode: 'transcript', session: 'echo-s1', row: marker.row, byteFrom: to }));
      expect(c.rowTruncated!.from).toBe(to);
      expect(c.entries[0].text).not.toContain('�');
      pieces.push(c.entries[0].text);
      to = c.rowTruncated!.to;
    }
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.join('')).toBe(redacted);
    for (const p of pieces) expect(p).not.toContain(TOKEN.slice(0, 12));
    // The page cursor moved past the cut row: the older entry is reached without the remainder.
    const p3 = await ok(h({ mode: 'transcript', session: 'echo-s1', full: true, before: p2.nextBefore!, ...(p2.nextBeforeIndex ? { beforeIndex: p2.nextBeforeIndex } : {}) }));
    expect(p3.entries.map((e) => e.text)).toEqual(['older ordinary']);
    // A continuation that does not line up is refused, never a garbled piece.
    expect(await h({ mode: 'transcript', session: 'echo-s1', row: marker.row, byteFrom: 1 })).toMatchObject({ ok: false, reason: 'bad-byte-range' });
    expect(await h({ mode: 'transcript', session: 'echo-s1', row: { offset: 3, index: 0 }, byteFrom: 0 })).toMatchObject({ ok: false, reason: 'row-gone' });
    expect(await h({ mode: 'transcript', session: 'echo-s1', row: marker.row, byteFrom: marker.totalBytes })).toMatchObject({ ok: false, reason: 'bad-byte-range' });
  });

  it('cutUtf8 never splits a character and always advances', () => {
    const t = '漢'.repeat(10);
    const a = cutUtf8(t, 0, 10)!;
    expect(a.to % 3).toBe(0);
    expect(a.to).toBeGreaterThan(0);
    expect(cutUtf8(t, 1, 10)).toBeNull();
    const tiny = cutUtf8(t, 0, 1)!;
    expect(tiny.piece).toBe('漢');
  });
});

describe('transcript audience (§3d item 2)', () => {
  const base: TranscriptAudienceInput = {
    principal: 'owner', conversations: ['telegram:1'], teamOn: true, teamEver: true,
    confined: new Map(), record: { ownerPersonKey: 'owner-key', grants: new Map() }, gaps: 0, pullerRefusing: false,
  };
  const confinedTo = (ref: string, personKey?: string) => new Map([[ref, { ref, ...(personKey ? { personKey } : {}) }]]);

  it('a session with no conversation is the owner\'s', () => {
    expect(resolveTranscriptAudience({ ...base, conversations: [] })).toEqual({ ok: true });
  });
  it('a device-signed request is refused for a member and for a guest, whatever they have been granted', () => {
    const grants = new Map([['member-key', new Map([['telegram:1', 'read']])], ['guest-key', new Map([['telegram:1', 'read']])]]);
    expect(resolveTranscriptAudience({ ...base, principal: 'device', record: { ownerPersonKey: 'owner-key', grants } })).toEqual({ ok: false, reason: 'not-owner' });
    expect(resolveTranscriptAudience({ ...base, principal: 'device', conversations: [] })).toEqual({ ok: false, reason: 'not-owner' });
  });
  it('with team access on, a team log with a gap refuses the read and so does a refusing team puller; with them clear it is served', () => {
    expect(resolveTranscriptAudience({ ...base, gaps: 1 })).toEqual({ ok: false, reason: 'access-being-checked' });
    expect(resolveTranscriptAudience({ ...base, pullerRefusing: true })).toEqual({ ok: false, reason: 'access-being-checked' });
    expect(resolveTranscriptAudience(base)).toEqual({ ok: true });
  });
  it('a replica whose peers show no sign of being awake does not refuse (the puller is not refusing then)', () => {
    expect(resolveTranscriptAudience({ ...base, pullerRefusing: false, gaps: 0 })).toEqual({ ok: true });
  });
  it('one conversation confined to another person excludes the owner; a shared confined place does not', () => {
    expect(resolveTranscriptAudience({ ...base, confined: confinedTo('telegram:1', 'member-key') })).toEqual({ ok: false, reason: 'private-to-someone-else' });
    expect(resolveTranscriptAudience({ ...base, confined: confinedTo('telegram:1') })).toEqual({ ok: true });
    expect(resolveTranscriptAudience({ ...base, confined: confinedTo('telegram:1', 'owner-key') })).toEqual({ ok: true });
  });
  it('two conversations take the more restrictive', () => {
    const confined = new Map([['telegram:1', { ref: 'telegram:1' }], ['app-x', { ref: 'app-x', personKey: 'member-key' }]]);
    expect(resolveTranscriptAudience({ ...base, conversations: ['telegram:1'], confined })).toEqual({ ok: true });
    expect(resolveTranscriptAudience({ ...base, conversations: ['telegram:1', 'app-x'], confined })).toEqual({ ok: false, reason: 'private-to-someone-else' });
  });
  it('an unreadable list or team record with team access on gives unreadable', () => {
    expect(resolveTranscriptAudience({ ...base, confined: null })).toEqual({ ok: false, reason: 'unreadable' });
    expect(resolveTranscriptAudience({ ...base, record: null })).toEqual({ ok: false, reason: 'unreadable' });
  });
  it('a grant made after the transcript was written admits the owner on the next read, and a revocation refuses it', () => {
    const confined = confinedTo('app-x', 'member-key');
    const input = { ...base, conversations: ['app-x'], confined };
    expect(resolveTranscriptAudience(input)).toEqual({ ok: false, reason: 'private-to-someone-else' });
    const granted = { ...input, record: { ownerPersonKey: 'owner-key', grants: new Map([['owner-key', new Map([['app-x', 'read']])]]) } };
    expect(resolveTranscriptAudience(granted)).toEqual({ ok: true });
    expect(resolveTranscriptAudience({ ...granted, record: { ownerPersonKey: 'owner-key', grants: new Map() } })).toEqual({ ok: false, reason: 'private-to-someone-else' });
  });
  it('an answer with no conversations field is served on a never-team agent and refused with team access on', () => {
    expect(resolveTranscriptAudience({ ...base, conversations: undefined, teamOn: false, teamEver: false })).toEqual({ ok: true });
    expect(resolveTranscriptAudience({ ...base, conversations: undefined })).toEqual({ ok: false, reason: 'older-peer' });
    expect(resolveTranscriptAudience({ ...base, conversations: undefined, teamOn: false, teamEver: true })).toEqual({ ok: false, reason: 'older-peer' });
  });
  it('a never-team agent serves the owner every transcript', () => {
    expect(resolveTranscriptAudience({ ...base, teamOn: false, teamEver: false, record: null })).toEqual({ ok: true });
  });
});
