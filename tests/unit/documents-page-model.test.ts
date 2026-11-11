/** The document page's pure logic (dashboard/docs/doc-page-model.js; spec §3.6, §3.8, app contract). */
import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import * as m from '../../dashboard/docs/doc-page-model.js';
import { docpageString as serverString, DOCPAGE_OPS } from '../../src/documents/docpageAuth.js';
import { canonicalJson as serverCanonical } from '../../src/documents/chain.js';
import { blobHash } from '../../src/documents/blobs.js';
import { commentKeysHashOf } from '../../src/documents/service.js';
import { renderTree } from '../../src/documents/render.js';
import { projectText } from '../../src/documents/projection.js';

const sha = async (s: string) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const DOC = crypto.randomUUID();
const rid = () => `${Date.now()}-${crypto.randomUUID()}`;

const SAMPLE: Record<string, Record<string, unknown>> = {
  comment: { docId: DOC, commentId: crypto.randomUUID(), onVersion: crypto.randomUUID(), start: 3, end: 12, bodyHash: 'a'.repeat(64) },
  reply: { docId: DOC, commentKey: `owner:${crypto.randomUUID()}`, replyId: crypto.randomUUID(), bodyHash: 'b'.repeat(64) },
  resolve: { docId: DOC, commentKey: 'mara:x' },
  reopen: { docId: DOC, commentKey: 'mara:x' },
  edit: { docId: DOC, commentKey: 'owner:y', bodyHash: 'c'.repeat(64) },
  reanchor: { docId: DOC, commentKey: 'owner:y', onVersion: crypto.randomUUID(), start: 0, end: 5 },
  send: { docId: DOC, batchId: rid(), commentKeysHash: 'd'.repeat(64), primaryRow: 'A:12', messageRequestId: rid() },
  open: { docId: DOC },
};

describe('instar-docpage-v1 string', () => {
  it('matches the server for every op, whatever the field order', async () => {
    for (const op of DOCPAGE_OPS) {
      const fields = SAMPLE[op];
      const payload = m.buildPayload(op, { ...fields, extra: 'ignored' });
      const reversed = Object.fromEntries(Object.entries(payload).reverse());
      const parts = { deviceId: 'dev-1', host: 'Echo.Example.DEV', docId: DOC, op, requestId: rid(), timeMs: String(Date.now()) };
      const mine = await m.docpageString(parts, reversed, sha);
      const theirs = serverString(parts.deviceId, parts.host, DOC, op, parts.requestId, parts.timeMs, payload);
      expect(mine).toBe(theirs);
      expect(m.canonicalJson(reversed)).toBe(serverCanonical(payload));
    }
  });

  it('payloads carry exactly their fields, and refuse a missing one', () => {
    expect(Object.keys(m.buildPayload('resolve', { docId: DOC, commentKey: 'k', bodyHash: 'x' }))).toEqual(['docId', 'commentKey']);
    expect(() => m.buildPayload('send', { docId: DOC, batchId: 'b', primaryRow: 'r', messageRequestId: 'm' })).toThrow(/commentKeysHash/);
    expect(() => m.buildPayload('nope', {})).toThrow();
  });

  it('request ids and send ids have the server formats', () => {
    const id = m.requestIdOf(Date.now(), crypto.randomUUID());
    expect(id).toMatch(m.REQUEST_ID);
    // rows.ts send batchId and MobileChatRequests REQUEST_ID_PATTERN
    expect(id).toMatch(/^\d{13}-[0-9a-f-]{36}$/);
    expect(m.messageRequestIdFor(id)).toMatch(/^(\d{13})-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/);
  });

  it('commentKeysHash matches the server, covering my open comments in any order', async () => {
    const page = { comments: [
      { key: 'owner:b', mine: true, resolved: false, sent: true },
      { key: 'owner:a', mine: true, resolved: false, sent: false },
      { key: 'owner:c', mine: true, resolved: true, sent: false },
      { key: 'mara:d', mine: false, resolved: false, sent: false },
    ] };
    const keys = m.myOpenKeys(page);
    expect(keys.sort()).toEqual(['owner:a', 'owner:b']);
    expect(await sha(m.commentKeysJson(['owner:b', 'owner:a']))).toBe(commentKeysHashOf(['owner:a', 'owner:b']));
    expect(await sha(m.commentKeysJson([]))).toBe(commentKeysHashOf([]));
  });

  it('blob hash input matches the server blob hash', async () => {
    const salt = m.saltHex(crypto.randomBytes(16));
    expect(salt).toMatch(/^[0-9a-f]{32}$/);
    const text = 'Can we make it Thursday? é 😀';
    expect(await sha(m.blobHashInput(salt, text))).toBe(blobHash(salt, text));
  });
});

describe('bodies', () => {
  it('refuses empty and too-long bodies in words', () => {
    expect(m.bodyProblem('  ')).toBe('Write something first.');
    expect(m.bodyProblem('ok')).toBeNull();
    expect(m.bodyProblem('x'.repeat(40_001))).toMatch(/too long/);
    expect(m.bodyProblem('é'.repeat(30_000))).toMatch(/too long/); // fits in chars, not in the 48 KiB blob
    expect(m.bodyProblem('x'.repeat(40_000))).toBeNull();
  });
});

describe('selection → projection offsets', () => {
  const md = '# Plan\n\nWe **ship** the *viewer* on Friday.\n\n- one\n- two `code`\n';
  const blocks = renderTree(md);
  const text = projectText(md).text;

  it('the page projection equals the server projection', () => {
    expect(m.projectionOf(blocks)).toBe(text);
  });

  it('maps a point inside a run', () => {
    const p = blocks[1];
    const lens = p.runs.map((r) => r.text.length);
    // run 1 is "ship"; offset 2 inside it is the "i"
    const o = m.pointOffset(p.start, lens, 1, 2);
    expect(text[o]).toBe('i');
    expect(m.pointOffset(p.start, lens, 0, 0)).toBe(p.start);
    expect(m.pointOffset(p.start, lens, lens.length, 0)).toBe(p.end);
    expect(m.pointOffset(p.start, lens, 0, 999)).toBe(p.start + lens[0]); // clamped
  });

  it('a selection across blocks counts one "\\n" per boundary', () => {
    const a = blocks[1]; const b = blocks[2];
    const from = m.pointOffset(a.start, a.runs.map((r) => r.text.length), a.runs.length - 1, a.runs[a.runs.length - 1].text.length - 7); // "Friday."
    const to = m.pointOffset(b.start, b.runs.map((r) => r.text.length), 0, 3);
    const sel = m.normalizeSelection(to, from, text)!;
    expect(text.slice(sel.start, sel.end)).toBe('Friday.\none');
    const spanAll = m.normalizeSelection(0, text.length, text)!;
    expect(text.slice(spanAll.start, spanAll.end)).toBe(text.trim());
  });

  it('trims whitespace, never splits a surrogate pair, and drops empty selections', () => {
    const t = 'a 😀 b';
    expect(m.normalizeSelection(1, 3, t)).toEqual({ start: 2, end: 4 });
    expect(m.normalizeSelection(3, 6, t)).toEqual({ start: 2, end: 6 });
    expect(m.normalizeSelection(1, 2, t)).toBeNull();
    expect(m.normalizeSelection(4, 4, t)).toBeNull();
  });

  it('segments runs at comment boundaries without changing the text', () => {
    const p = blocks[1];
    const ranges = [{ key: 'k1', start: p.start + 1, end: p.start + 6 }, { key: 'k2', start: p.start + 4, end: p.end + 5 }];
    const pieces = m.segmentBlock(p, ranges);
    expect(pieces.map((x) => x.text).join('')).toBe(m.blockText(p));
    for (const piece of pieces) expect(text.slice(piece.start, piece.start + piece.text.length)).toBe(piece.text);
    const both = pieces.filter((x) => x.keys.length === 2);
    expect(both.map((x) => x.text).join('')).toBe(text.slice(p.start + 4, p.start + 6));
    expect(pieces[0].keys).toEqual([]);
  });

  it('highlights only on the latest version and only placed open comments', () => {
    const comments = [
      { key: 'a', start: 1, end: 3, resolved: false, anchorState: 'ok' },
      { key: 'b', start: 1, end: 3, resolved: true, anchorState: 'ok' },
      { key: 'c', resolved: false, anchorState: 'orphaned' },
      { key: 'd', start: 4, end: 9, resolved: false, anchorState: 'edited' },
    ];
    expect(m.highlightRanges({ version: { latest: true }, comments }).map((r) => r.key)).toEqual(['a', 'd']);
    expect(m.highlightRanges({ version: { latest: false }, comments })).toEqual([]);
  });

  it('numbers ordered items per level', () => {
    const bs = renderTree('1. a\n2. b\n   1. c\n3. d\n\npara\n\n1. e\n');
    expect(m.itemNumbers(bs)).toEqual([1, 2, 1, 3, null, 1]);
  });
});

describe('links, location and words', () => {
  it('keeps only http, https and mailto links', () => {
    expect(m.safeHref('https://a.b/c')).toBe('https://a.b/c');
    expect(m.safeHref('mailto:x@y.z')).toBe('mailto:x@y.z');
    expect(m.safeHref('javascript:alert(1)')).toBeNull();
    expect(m.safeHref('JaVaScRiPt:alert(1)')).toBeNull();
    expect(m.safeHref('data:text/html,hi')).toBeNull();
    expect(m.safeHref('/relative')).toBeNull();
    expect(m.safeHref(undefined)).toBeNull();
  });

  it('reads the fragment and the document id', () => {
    expect(m.parseFragment('#code=abc_-1&comment=owner%3Ax')).toEqual({ code: 'abc_-1', comment: 'owner:x' });
    expect(m.parseFragment('')).toEqual({ code: null, comment: null });
    expect(m.docIdFromPath(`/docs/${DOC}`)).toBe(DOC);
  });

  it('writes the Send template exactly', () => {
    expect(m.sendMessage({ count: 3, title: 'Onboarding plan', label: 4, origin: 'https://echo.example.dev', id: DOC }))
      .toBe(`I left 3 comments on "Onboarding plan" (version 4): https://echo.example.dev/docs/${DOC}`);
    expect(m.sendMessage({ count: 1, title: 'X', label: 1, origin: 'https://o', id: 'i' })).toBe('I left 1 comment on "X" (version 1): https://o/docs/i');
  });

  it('Send is offered only with something unsent of mine and a place to send it', () => {
    const page = {
      me: { canSend: true }, primary: { sendPath: '/mobile/chat/7', primaryRow: 'A:1' }, version: { id: 'v', label: 1 },
      comments: [{ key: 'a', mine: true, resolved: false, sent: true }, { key: 'b', mine: false, resolved: false, sent: false }],
    };
    expect(m.canSend(page)).toBe(false);
    page.comments.push({ key: 'c', mine: true, resolved: false, sent: false });
    expect(m.canSend(page)).toBe(true);
    expect(m.unsentMine(page).map((c) => c.key)).toEqual(['c']);
    expect(m.canSend({ ...page, primary: { sendPath: null, primaryRow: 'A:1' } })).toBe(false);
    expect(m.openWords(m.openCount(page))).toBe('3 open comments');
    expect(m.openWords(1)).toBe('1 open comment');
  });

  it('says versions and anchor notes in words', () => {
    expect(m.versionWords({ version: { id: 'b', label: 2 }, versions: [{ id: 'a', label: 1 }, { id: 'b', label: 2 }, { id: 'c', label: 3 }] })).toBe('Version 2 of 3');
    expect(m.anchorNote('edited')).toBe('The passage changed since this comment');
    expect(m.anchorNote('orphaned')).toBe('The passage this comment was on was removed');
    expect(m.anchorNote('ok')).toBeNull();
  });

  it('turns errors into plain words, never raw codes', () => {
    expect(m.errorWords(409, { error: 'document-moved' }, { agentName: 'Echo', conversation: 'Instar Docs' })).toBe('This document moved while sending. Send again to tell Echo in Instar Docs.');
    expect(m.errorWords(401, { error: 'doc-session-expired' }, { inApp: true })).toBe('This page timed out. Open the document again from the app.');
    expect(m.errorWords(400, { error: 'weird-code', detail: 'bad-thing' })).not.toMatch(/weird-code|bad-thing/);
    expect(m.errorWords(0, null)).toMatch(/couldn't be reached/);
  });
});

describe('drafts, layout, compare, bridge', () => {
  it('drafts survive only in a known shape', () => {
    const id = crypto.randomUUID();
    expect(m.parseDraft(JSON.stringify({ text: 'hi', id, salt: 'a'.repeat(32) }))).toEqual({ text: 'hi', id, salt: 'a'.repeat(32) });
    expect(m.parseDraft('{not json')).toBeNull();
    expect(m.parseDraft(JSON.stringify({ text: 'hi', id: 'nope' }))).toBeNull();
    expect(m.draftKey(DOC, 'comment', 3, 9)).toBe(`instar-doc-draft:${DOC}:comment:3-9`);
  });

  it('pushes margin threads apart and collapses to a list when they drift too far', () => {
    const l = m.marginLayout([{ key: 'b', top: 105, height: 50 }, { key: 'a', top: 100, height: 50 }]);
    expect(l).toEqual({ mode: 'margin', tops: { a: 100, b: 158 } });
    const many = Array.from({ length: 6 }, (_, i) => ({ key: `k${i}`, top: 100, height: 80 }));
    expect(m.marginLayout(many).mode).toBe('list');
  });

  it('merges diff pieces', () => {
    expect(m.diffPieces([{ op: 'eq', text: 'a ' }, { op: 'del', text: 'b' }, { op: 'del', text: 'c' }, { op: 'ins', text: 'd' }, { op: 'eq', text: '' }]))
      .toEqual([{ kind: 'eq', text: 'a ' }, { kind: 'del', text: 'bc' }, { kind: 'ins', text: 'd' }]);
  });

  it('bridge writes carry no hashes and app events are checked', () => {
    expect(m.bridgeFields('reply', { docId: DOC, commentKey: 'k', replyId: 'r' })).toEqual({ docId: DOC, commentKey: 'k', replyId: 'r' });
    expect(m.bridgeFields('resolve', { docId: DOC, commentKey: 'k', replyId: 'r' })).toEqual({ docId: DOC, commentKey: 'k' });
    expect(() => m.bridgeFields('send', { docId: DOC })).toThrow();
    expect(m.parseAppEvent({ type: 'write-result', id: 'x', status: 201, body: { key: 'k' } })).toEqual({ type: 'write-result', id: 'x', status: 201, body: { key: 'k' } });
    expect(m.parseAppEvent({ type: 'focus-comment', commentKey: 'k' })).toEqual({ type: 'focus-comment', commentKey: 'k' });
    expect(m.parseAppEvent({ type: 'run', code: 'x' })).toBeNull();
    expect(m.parseAppEvent(null)).toBeNull();
  });
});
