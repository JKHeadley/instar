import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AttributionJudge } from '../../../src/core/attribution/AttributionJudge.js';
import { AttributionLedger } from '../../../src/core/attribution/AttributionLedger.js';
import { AttributionService, quoteBeforeMarker, surroundingLines } from '../../../src/core/attribution/AttributionService.js';
import { parseMarkers } from '../../../src/core/attribution/marker.js';
import type { ResolveResult } from '../../../src/core/attribution/SourceResolver.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';

const row = { messageId: 123160, topicId: 102965, text: 'at least every hour and a half or so or two hours', fromUser: true, telegramUserId: 7812716706, forwarded: false, provenance: 'user', timestamp: '2026-10-08T04:34:33.000Z' };
const found: ResolveResult = { outcome: 'found', row, failed: [] };
const LINE = 'Justin: "at least every hour and a half or so or two hours" [source: telegram 102965/123160 2026-10-08]';

function claimsReply(claims: unknown[]) { return JSON.stringify({ claims }); }

describe('AttributionService', () => {
  let dir: string;
  let ledger: AttributionLedger;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attr-svc-')); ledger = new AttributionLedger({ stateDir: dir, machineId: 'm1' }); });
  afterEach(() => { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/attribution/AttributionService.test.ts:cleanup' }); });

  const service = (replies: Array<string | Error>, resolved: ResolveResult = found, extra = {}) => {
    const queue = [...replies];
    const judge = new AttributionJudge({ evaluate: async () => { const next = queue.shift()!; if (next instanceof Error) throw next; return next; } });
    return new AttributionService({ judge, resolve: async () => resolved, identity: (_c, id) => (id === '7812716706' ? 'Justin' : null), ledger, authorship: () => 'human', ...extra });
  };
  const claim = (over = {}) => ({ span: 'Justin', person: 'Justin', kind: 'rule', markerIndex: 0, labelled: false, stillCredits: false, ...over });
  const own = '{"ownWords":"own","faithful":true,"why":"ok"}';

  it('passes a faithful sourced quote and records it as origin', async () => {
    const result = await service([claimsReply([claim()]), own]).check(LINE, { surface: 'note-write', firstSeen: '2026-11-05T00:00:00Z' });
    expect(result.verdict).toBe('pass');
    expect(result.findings[0]).toMatchObject({ strength: 'verified', relation: 'origin' });
    expect(ledger.rows()[0]).toMatchObject({ person: 'Justin', relation: 'origin', verdict: 'pass' });
  });

  it('refuses the first step of the laptop-rule chain: a credit with no source', async () => {
    const text = 'Justin corrected me: never spawn on the laptop.';
    const result = await service([claimsReply([claim({ span: 'Justin corrected me', markerIndex: null })])]).check(text, { surface: 'note-write' });
    expect(result.findings[0]).toMatchObject({ verdict: 'refuse', reason: 'unsourced' });
    expect(result.verdict).toBe('refuse');
  });

  it('refuses a label that still credits the person, and passes one that removes the credit', async () => {
    const promoted = "Justin's standing rule: X [source unknown]";
    expect((await service([claimsReply([claim({ span: promoted, markerIndex: null, labelled: true, stillCredits: true })])]).check(promoted, { surface: 'note-write' })).findings[0].reason).toBe('promoted-unsourced');
    const honest = 'X. An earlier note credited this to Justin; source unknown. [source unknown]';
    expect((await service([claimsReply([claim({ span: honest, markerIndex: null, labelled: true })])]).check(honest, { surface: 'note-write' })).verdict).toBe('pass');
  });

  it('refuses a malformed marker without asking the model', async () => {
    const result = await service([]).check('Justin: "x" [source: telegram 1/2]', { surface: 'note-write' });
    expect(result.findings[0].reason).toBe('malformed-marker');
  });

  it('passes as unchecked when the model is down, even with a wrong quote: no veto without the gate', async () => {
    const text = 'Justin: "invented words" [source: telegram 102965/123160 2026-10-08]';
    expect((await service([new Error('down')]).check(text, { surface: 'note-write' })).verdict).toBe('unchecked');
    const r2 = await service([claimsReply([claim()]), new Error('down')]).check(text, { surface: 'note-write' });
    expect(r2.findings[0].verdict).toBe('unchecked');
  });

  it('names the failed exact fact when the judge refuses', async () => {
    const text = 'Justin: "any Codex account" [source: telegram 102965/123160 2026-10-08]';
    const result = await service([claimsReply([claim()]), '{"ownWords":"own","faithful":false,"why":"not his words"}']).check(text, { surface: 'note-write' });
    expect(result.findings[0].reason).toBe('quote-not-in-record');
  });

  it('calls a stronger rule on real words overstated', async () => {
    const result = await service([claimsReply([claim()]), '{"ownWords":"own","faithful":false,"why":"permanent"}']).check(LINE, { surface: 'note-write' });
    expect(result.findings[0].reason).toBe('overstated');
  });

  it('refuses words the judge rules relayed, even on a person\'s own row', async () => {
    const result = await service([claimsReply([claim()]), '{"ownWords":"relayed","faithful":true,"why":"paste"}']).check(LINE, { surface: 'note-write' });
    expect(result.findings[0].reason).toBe('relayed');
  });

  it('treats unclear authorship as unchecked, never as their own words', async () => {
    const result = await service([claimsReply([claim()]), '{"ownWords":"unclear","faithful":true,"why":"?"}']).check(LINE, { surface: 'note-write' });
    expect(result.findings[0].verdict).toBe('unchecked');
  });

  it('refuses a new citation that cannot be shown, unless a pin or ledger row holds it', async () => {
    for (const outcome of ['unverifiable', 'not-found'] as const) {
      const result = await service([claimsReply([claim()])], { outcome, failed: [] }).check(LINE, { surface: 'note-write' });
      expect(result.findings[0].reason).toBe('cannot-be-shown');
      const known = await service([claimsReply([claim()])], { outcome, failed: [] }, { knownRef: () => true }).check(LINE, { surface: 'note-write' });
      expect(known.findings[0]).toMatchObject({ verdict: 'pass', relation: 'unconfirmed' });
    }
  });

  it('lets a down machine pass but records it as unconfirmed, not as origin', async () => {
    const result = await service([claimsReply([claim()])], { outcome: 'unreachable', failed: ['laptop'] }).check(LINE, { surface: 'note-write' });
    expect(result.findings[0]).toMatchObject({ verdict: 'pass', relation: 'unconfirmed' });
  });

  it('refuses a source newer than the claim', async () => {
    const result = await service([claimsReply([claim()])]).check(LINE, { surface: 'note-write', firstSeen: '2026-07-30T00:00:00Z' });
    expect(result.findings[0].reason).toBe('later-than-claim');
  });

  it('marks an audit match with no known first-seen as reconstructed', async () => {
    const result = await service([claimsReply([claim()]), own]).check(LINE, { surface: 'audit', firstSeen: null });
    expect(result.findings[0].relation).toBe('reconstructed');
  });

  it('records a source attached later as support, not as where the claim came from', async () => {
    const result = await service([claimsReply([claim()]), own]).check(LINE, { surface: 'note-write', firstSeen: '2026-11-05T00:00:00Z', attachedLater: true });
    expect(result.findings[0]).toMatchObject({ verdict: 'pass', relation: 'reconstructed' });
  });

  it('refuses a wrong date, wrong quote or missing quote while the judge runs, even if it would pass', async () => {
    const wrongQuote = 'Justin: "other words" [source: telegram 102965/123160 2026-10-08]';
    expect((await service([claimsReply([claim()]), own]).check(wrongQuote, { surface: 'note-write' })).findings[0].reason).toBe('quote-not-in-record');
    const wrongDate = 'Justin: "at least every hour and a half or so or two hours" [source: telegram 102965/123160 2026-10-07]';
    expect((await service([claimsReply([claim()]), own]).check(wrongDate, { surface: 'note-write' })).findings[0].reason).toBe('date-mismatch');
    const noQuote = 'Justin asked for this [source: telegram 102965/123160 2026-10-08]';
    expect((await service([claimsReply([claim()]), own]).check(noQuote, { surface: 'note-write' })).findings[0].reason).toBe('quote-not-in-record');
  });

  it('refuses a display name with no identity, and somebody else\'s row', async () => {
    const stranger = { ...found, row: { ...row, telegramUserId: 42 } };
    expect((await service([claimsReply([claim()])], stranger).check(LINE, { surface: 'note-write' })).findings[0].reason).toBe('identity-unverified');
    expect((await service([claimsReply([claim({ person: 'Dawn' })])]).check(LINE, { surface: 'note-write' })).findings[0].reason).toBe('record-not-theirs');
  });

  it('refuses a citation of a deleted message', async () => {
    const result = await service([claimsReply([claim()])], { outcome: 'removed', failed: [] }).check(LINE, { surface: 'note-write' });
    expect(result.findings[0].reason).toBe('cannot-be-shown');
  });

  it('refuses a rule resting on nobody', async () => {
    const text = 'That is a standing rule, so no.';
    const result = await service([claimsReply([claim({ span: 'standing rule, so no', person: null, kind: 'rule-refusal', markerIndex: null })])]).check(text, { surface: 'send' });
    expect(result.findings[0].reason).toBe('unsourced');
    expect(ledger.rows()[0].person).toBe('unnamed');
  });

  it('judges the surrounding text, so a heading-only change is seen', async () => {
    const seen: string[] = [];
    const judge = new AttributionJudge({ evaluate: async (prompt: string) => { seen.push(prompt); return '{"claims":[]}'; } });
    const s = new AttributionService({ judge, resolve: async () => found, identity: () => null, ledger });
    await s.check("# Justin's standing rules", { surface: 'note-write', surroundingText: "# Justin's standing rules\n- never spawn on the laptop" });
    expect(seen[0]).toContain('never spawn on the laptop');
  });
});

describe('helpers', () => {
  it('finds the quote on the marker line', () => {
    const { markers } = parseMarkers(LINE);
    expect(quoteBeforeMarker(LINE, markers[0])).toBe('at least every hour and a half or so or two hours');
  });

  it('handles curly quotes and a missing quote', () => {
    const curly = 'J: “words” [source: app c/e 2026-01-01]';
    expect(quoteBeforeMarker(curly, parseMarkers(curly).markers[0])).toBe('words');
    const none = 'no quote [source: app c/e 2026-01-01]';
    expect(quoteBeforeMarker(none, parseMarkers(none).markers[0])).toBeNull();
  });

  it('returns the line with its neighbours', () => {
    expect(surroundingLines('a\nb\nc\nd', 'c')).toBe('b\nc\nd');
    expect(surroundingLines('a', 'zz')).toBe('zz');
  });
});
