// safe-git-allow: test-tmpdir-cleanup — afterEach removes per-test mkdtempSync tmpdir.
/**
 * ScopeAccretionRatifier — Tier 1 (spec: autonomous-scope-accretion-completion.md
 * §2.6 R23/R37/R38/R45).
 *
 * The trigger + confirmation parsers are fed byte-for-byte captured REAL
 * Telegram receive-path message objects (tests/fixtures/captured/
 * scope-accretion-telegram-receive — see the meta.json sidecars). The ratifier
 * itself runs against a REAL AutonomousRunStore on a tmp state dir.
 *
 * Decision boundaries under test (both sides): reply-anchored confirmation
 * binds EXACTLY the enumerated set; a bare affirmative NOT reply-anchored
 * resolves to the EMPTY set (R38); vocabulary-only match with no confirmation
 * ratifies nothing; a non-operator sender is refused; a pre-accretion blanket
 * trigger enumerates nothing; enumerations dedupe per set hash.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ScopeAccretionRatifier,
  parseDeferTrigger,
  parseRatificationConfirmation,
  parseReceivePathMessage,
} from '../../src/core/ScopeAccretionRatifier.js';
import { AutonomousRunStore, hashPathSet } from '../../src/core/AutonomousRunStore.js';
import { loadCapturedFixture } from '../helpers/loadCapturedFixture.js';

let tmp: string;
let store: AutonomousRunStore;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-sar-'));
  store = new AutonomousRunStore(tmp);
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function registerRun(topicId = '9984'): string {
  const r = store.register({
    topicId,
    condition: 'ship it',
    workDir: tmp,
    startedAt: new Date(Date.now() - 3_600_000).toISOString(),
    scopeAccretion: { enabled: true, breakerK: 3 },
    baseRoots: [],
    maxDurationMs: 24 * 3_600_000,
  });
  if (!r.ok) throw new Error('register failed');
  return r.runId;
}

describe('parseReceivePathMessage — captured REAL Telegram message objects', () => {
  it('parses the REAL captured Telegram receive-path message objects', () => {
    const rawEnum = loadCapturedFixture('scope-accretion-telegram-receive', 'enumeration-message');
    const parsedEnum = parseReceivePathMessage(rawEnum);
    expect(parsedEnum).not.toBeNull();
    expect(parsedEnum!.text).toContain('Ratify deferring these 2 artifacts?');
    expect(parsedEnum!.messageId).toBeGreaterThan(0);

    const rawReply = loadCapturedFixture('scope-accretion-telegram-receive', 'reply-anchored-confirmation');
    const parsedReply = parseReceivePathMessage(rawReply);
    expect(parsedReply).not.toBeNull();
    // The reply_to_message chain points at the enumeration message (R38 anchor).
    expect(parsedReply!.replyToMessageId).toBe(parsedEnum!.messageId);

    expect(parseReceivePathMessage('not json at all')).toBeNull();
    expect(parseReceivePathMessage('{"no":"text"}')).toBeNull();
  });
});

describe('parseDeferTrigger — captured REAL trigger payload', () => {
  it('matches defer-intent vocabulary in the REAL captured trigger message', () => {
    const rawTrigger = loadCapturedFixture('scope-accretion-telegram-receive', 'defer-trigger');
    // The parser consumes the message TEXT; feeding the raw captured bytes is a
    // conservative superset (the vocabulary lives in the text field).
    expect(parseDeferTrigger(rawTrigger)).toBe('defer');
    const msg = parseReceivePathMessage(rawTrigger)!;
    expect(parseDeferTrigger(msg.text)).toBe('defer');
    expect(parseDeferTrigger('all done, shipping the PR now')).toBeNull();
  });
});

describe('parseRatificationConfirmation (R38 — strict; the one path toward exit)', () => {
  it('binds a REAL reply-anchored confirmation to the enumerated set (message-id chain)', () => {
    const rawReply = loadCapturedFixture('scope-accretion-telegram-receive', 'reply-anchored-confirmation');
    const parsed = parseReceivePathMessage(rawReply)!;
    const enums = [{ setHash: 'HASH-1', messageId: parsed.replyToMessageId! }];
    const match = parseRatificationConfirmation(rawReply, enums);
    expect(match.replyAnchored).toBe(true);
    expect(match.affirmative).toBe(true);
    expect(match.boundSetHash).toBe('HASH-1');
    // A reply anchored to a DIFFERENT message id binds nothing.
    const wrongAnchor = parseRatificationConfirmation(rawReply, [{ setHash: 'H2', messageId: 1 }]);
    expect(wrongAnchor.boundSetHash).toBeNull();
  });

  it('a REAL bare affirmative NOT reply-anchored resolves to the EMPTY set', () => {
    const rawBare = loadCapturedFixture('scope-accretion-telegram-receive', 'bare-affirmative');
    const match = parseRatificationConfirmation(rawBare, [{ setHash: 'HASH-1', messageId: 42 }]);
    expect(match.affirmative).toBe(true);
    expect(match.replyAnchored).toBe(false);
    expect(match.boundSetHash).toBeNull(); // a busy topic's unrelated "yes" ratifies NOTHING
  });

  it('the explicit "ratify" token with affirmative content binds the latest enumeration', () => {
    const match = parseRatificationConfirmation(
      { text: 'yes — ratify the deferral' },
      [
        { setHash: 'OLD', messageId: 1 },
        { setHash: 'NEW', messageId: 2 },
      ],
    );
    expect(match.boundSetHash).toBe('NEW');
  });

  it('non-affirmative content never binds', () => {
    const match = parseRatificationConfirmation(
      { text: 'no, build them', replyToMessageId: 42 },
      [{ setHash: 'H', messageId: 42 }],
    );
    expect(match.boundSetHash).toBeNull();
  });
});

// ── The ratifier against a REAL store ───────────────────────────────────────

interface Sent { topicId: number; text: string }

function makeRatifier(opts: { operatorUid?: string | null; sends?: Sent[] } = {}) {
  const sends: Sent[] = opts.sends ?? [];
  let nextMessageId = 500;
  const ratifier = new ScopeAccretionRatifier({
    store,
    getOperatorUid: () => (opts.operatorUid === undefined ? '777' : opts.operatorUid),
    sendToTopic: async (topicId, text) => {
      sends.push({ topicId, text });
      return { messageId: ++nextMessageId };
    },
    dashboardLink: () => 'http://localhost:4040/dashboard',
  });
  return { ratifier, sends };
}

describe('ScopeAccretionRatifier.observeInbound (server-owned records, R45)', () => {
  it('trigger from the VERIFIED operator → server-authored enumeration recorded with its message id', async () => {
    const runId = registerRun();
    store.update('9984', runId, (r) => {
      r.lastUnbuilt = [{ path: 'docs/specs/a.md', cls: 'deliverable', deleted: false, firstSeenAt: new Date().toISOString() }];
    });
    const { ratifier, sends } = makeRatifier();
    await ratifier.observeInbound({ topicId: 9984, text: 'defer those specs to a later session', senderUid: '777', messageId: 100, at: Date.now() });
    expect(sends).toHaveLength(1);
    expect(sends[0].text).toContain('Ratify deferring these 1 artifact');
    expect(sends[0].text).toContain('docs/specs/a.md');
    const rec = store.getRecord('9984')!;
    expect(rec.enumerations).toHaveLength(1);
    expect(rec.enumerations[0].messageId).toBe(501);
    expect(rec.triggers).toHaveLength(1);
  });

  it('a NON-operator sender is refused (Know Your Principal) — no trigger, no enumeration', async () => {
    const runId = registerRun();
    store.update('9984', runId, (r) => {
      r.lastUnbuilt = [{ path: 'docs/specs/a.md', cls: 'deliverable', deleted: false, firstSeenAt: new Date().toISOString() }];
    });
    const { ratifier, sends } = makeRatifier({ operatorUid: '777' });
    await ratifier.observeInbound({ topicId: 9984, text: 'defer those specs', senderUid: '666', messageId: 100, at: Date.now() });
    expect(sends).toHaveLength(0);
    expect(store.getRecord('9984')!.enumerations).toHaveLength(0);
  });

  it('a pre-accretion blanket "defer those" (empty unbuilt set) enumerates NOTHING', async () => {
    registerRun();
    const { ratifier, sends } = makeRatifier();
    await ratifier.observeInbound({ topicId: 9984, text: 'defer those specs', senderUid: '777', messageId: 100, at: Date.now() });
    expect(sends).toHaveLength(0);
  });

  it('an unchanged unbuilt set re-uses the recorded enumeration (set-hash dedupe, never re-sends)', async () => {
    const runId = registerRun();
    store.update('9984', runId, (r) => {
      r.lastUnbuilt = [{ path: 'docs/specs/a.md', cls: 'deliverable', deleted: false, firstSeenAt: new Date().toISOString() }];
    });
    const { ratifier, sends } = makeRatifier();
    await ratifier.observeInbound({ topicId: 9984, text: 'defer those specs', senderUid: '777', messageId: 100, at: Date.now() });
    await ratifier.observeInbound({ topicId: 9984, text: 'please defer them', senderUid: '777', messageId: 101, at: Date.now() });
    expect(sends).toHaveLength(1);
  });

  it('reply-anchored operator confirmation ratifies EXACTLY the enumerated set (persisted, uid hashed)', async () => {
    const runId = registerRun();
    const artifacts = ['docs/specs/a.md', 'docs/specs/b.md'];
    store.update('9984', runId, (r) => {
      r.enumerations.push({ setHash: hashPathSet(artifacts), messageId: 501, at: new Date().toISOString(), artifacts });
    });
    const { ratifier } = makeRatifier();
    await ratifier.observeInbound({ topicId: 9984, text: 'yes — approve', senderUid: '777', messageId: 600, replyToMessageId: 501, at: Date.now() });
    const rec = store.getRecord('9984')!;
    expect(rec.ratifiedArtifacts.sort()).toEqual(artifacts);
    expect(rec.ratifications).toHaveLength(1);
    expect(rec.ratifications[0]).toMatchObject({ via: 'conversation', enumerationMessageId: 501, confirmationMessageId: 600 });
    // Audit discipline (§4): the uid is HASHED, never stored raw.
    expect(rec.ratifications[0].verifiedOperatorUidHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(rec.ratifications[0])).not.toContain('"777"');
  });

  it('a bare "yes" NOT reply-anchored ratifies NOTHING even with an enumeration outstanding (R38)', async () => {
    const runId = registerRun();
    store.update('9984', runId, (r) => {
      r.enumerations.push({ setHash: 'H', messageId: 501, at: new Date().toISOString(), artifacts: ['docs/specs/a.md'] });
    });
    const { ratifier } = makeRatifier();
    await ratifier.observeInbound({ topicId: 9984, text: 'yes', senderUid: '777', messageId: 600, at: Date.now() });
    expect(store.getRecord('9984')!.ratifiedArtifacts).toHaveLength(0);
  });

  it('no active run → observer is a no-op (never throws into the receive path)', async () => {
    const { ratifier, sends } = makeRatifier();
    await ratifier.observeInbound({ topicId: 555, text: 'defer everything', senderUid: '777', messageId: 1, at: Date.now() });
    expect(sends).toHaveLength(0);
  });
});
