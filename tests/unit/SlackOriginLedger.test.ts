/**
 * message-origin-all-platforms §3 (Slack): the origin ledger every Slack send writes first —
 * intents, self-contained receipts, refusal, the operator exception, recovery without a restart,
 * rotation with a restart-equal index, the reserved notice, and the reply scope's one call.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SlackOriginLedger, SlackOriginRecordingError, refusalWarrantsNotice } from '../../src/messaging/slack/SlackOriginLedger.js';
import { originEvidenceFromLaunchRecord } from '../../src/messaging/messageOrigin.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/SlackOriginLedger.test.ts' }); });
function fresh(opts: { failClosed?: () => boolean; maxBytes?: number; now?: () => number } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-origin-'));
  dirs.push(dir);
  const reports: string[] = [];
  const file = path.join(dir, 'state', 'slack-origins.jsonl');
  const make = () => new SlackOriginLedger({ file, machine: () => ({ id: 'm1', name: 'Mac Studio' }), report: (f) => reports.push(f), ...opts });
  return { dir, file, reports, make };
}
const sessionEvidence = originEvidenceFromLaunchRecord({ machineId: 'm1', machineName: 'Mac Studio', sessionId: 's', framework: 'claude-code', model: 'claude-opus-5-5', at: 1 });
const nowTs = () => (Date.now() / 1000).toFixed(6);

describe('SlackOriginLedger', () => {
  it('records an intent before and a receipt after; the post is found by (channel, ts) and survives a restart', () => {
    const { file, make } = fresh();
    const l = make();
    const ts = nowTs();
    const intent = SlackOriginLedger.runInScope({ evidence: sessionEvidence, channel: 'C1', threadTs: null }, () => l.beginIntent('chat.postMessage', 'C1', null));
    expect(intent.evidence).toBe(sessionEvidence);
    l.completeReceipt(intent, ts);
    expect(l.lookup('C1', ts)).toEqual({ evidence: sessionEvidence });
    expect(l.lookup('C2', ts)).toMatchObject({ missing: expect.any(String) }); // ts is only unique per channel
    expect((fs.statSync(file).mode & 0o777)).toBe(0o600);
    const restarted = make();
    expect(restarted.lookup('C1', ts)).toEqual({ evidence: sessionEvidence });
  });

  it('the reply scope admits one call to its own target; anything else is server-automation', () => {
    const { make } = fresh();
    const l = make();
    SlackOriginLedger.runInScope({ evidence: sessionEvidence, channel: 'C1', threadTs: '1.0' }, () => {
      expect(l.beginIntent('chat.postMessage', 'C9', null).evidence.producerKind).toBe('server-automation');
      expect(l.beginIntent('chat.postMessage', 'C1', '1.0').evidence).toBe(sessionEvidence);
      expect(l.beginIntent('chat.postMessage', 'C1', '1.0').evidence.producerKind).toBe('server-automation');
    });
    expect(l.beginIntent('chat.postMessage', 'C1', null).evidence.producerKind).toBe('server-automation');
  });

  it('an edit is a revision and never replaces the creating post', () => {
    const { make } = fresh();
    const l = make();
    const ts = nowTs();
    l.completeReceipt(SlackOriginLedger.runInScope({ evidence: sessionEvidence, channel: 'C1', threadTs: null }, () => l.beginIntent('chat.postMessage', 'C1', null)), ts);
    l.completeReceipt(l.beginIntent('chat.update', 'C1', null), ts);
    expect(l.lookup('C1', ts)).toEqual({ evidence: sessionEvidence });
    expect(make().lookup('C1', ts)).toEqual({ evidence: sessionEvidence });
  });

  it('refuses every send (session and automation) when the intent cannot be written, and recovers without a restart', () => {
    let t = 1_000_000;
    const { dir, make, reports } = fresh({ now: () => t });
    const l = make();
    fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'state', 'slack-origins.jsonl'), '');
    fs.chmodSync(path.join(dir, 'state'), 0o500);
    fs.chmodSync(path.join(dir, 'state', 'slack-origins.jsonl'), 0o400);
    try {
      expect(() => l.beginIntent('chat.postMessage', 'C1', null)).toThrow(SlackOriginRecordingError);
      expect(() => SlackOriginLedger.runInScope({ evidence: sessionEvidence, channel: 'C1', threadTs: null }, () => l.beginIntent('chat.postMessage', 'C1', null))).toThrow(SlackOriginRecordingError);
      expect(l.counters.refused).toBe(2);
      expect(reports).toContain('SlackAdapter.originRecording');
    } finally {
      fs.chmodSync(path.join(dir, 'state'), 0o700);
      fs.chmodSync(path.join(dir, 'state', 'slack-origins.jsonl'), 0o600);
    }
    // Inside the retry window it still refuses without touching the disk; after it, it recovers.
    expect(() => l.beginIntent('chat.postMessage', 'C1', null)).toThrow(SlackOriginRecordingError);
    t += 6_000;
    expect(l.beginIntent('chat.postMessage', 'C1', null).recorded).toBe(true);
  });

  it('the operator exception (slackFailClosed false) lets the send proceed unrecorded, reported', () => {
    const { dir, make, reports } = fresh({ failClosed: () => false });
    const l = make();
    fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'state', 'slack-origins.jsonl'), '');
    fs.chmodSync(path.join(dir, 'state', 'slack-origins.jsonl'), 0o400);
    try {
      const intent = l.beginIntent('chat.postMessage', 'C1', null);
      expect(intent.recorded).toBe(false);
      expect(l.counters.refused).toBe(0);
      expect(reports).toContain('SlackAdapter.originRecording');
    } finally { fs.chmodSync(path.join(dir, 'state', 'slack-origins.jsonl'), 0o600); }
  });

  it('a miss is never a claim: not-retained before coverage, unlinked near an unreceipted intent, else other-machine', () => {
    const { make } = fresh();
    const l = make();
    expect(l.lookup('C1', nowTs())).toEqual({ missing: 'not-retained' }); // nothing retained yet
    l.beginIntent('chat.postMessage', 'C1', null); // no receipt: the send happened, the receipt did not
    expect(l.lookup('C1', nowTs())).toEqual({ missing: 'unlinked' });
    expect(l.lookup('C2', nowTs())).toEqual({ missing: 'other-machine' });
    expect(l.lookup('C1', '1000000.000000')).toEqual({ missing: 'not-retained' });
  });

  it('rotation keeps the live index equal to what a restart builds, and receipts never depend on rotated intents', () => {
    const { file, make } = fresh({ maxBytes: 2_000 });
    const l = make();
    const stamps: string[] = [];
    for (let i = 0; i < 12; i++) {
      const ts = `${Math.floor(Date.now() / 1000) + i}.000100`;
      stamps.push(ts);
      l.completeReceipt(l.beginIntent('chat.postMessage', 'C1', null), ts);
    }
    expect(fs.existsSync(`${file}.1`)).toBe(true);
    const restarted = make();
    for (const ts of stamps) expect('evidence' in l.lookup('C1', ts)).toBe('evidence' in restarted.lookup('C1', ts));
    expect(l.coversSince).toBe(restarted.coversSince);
  });

  it('skips a torn or garbage line instead of throwing', () => {
    const { file, make } = fresh();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"v":1,"kind":"receipt"\nnot json\n');
    expect(() => make()).not.toThrow();
  });

  it('the reserved notice: bound to its conversation, once per incarnation and per 15 minutes, never reused after restart', () => {
    let t = 5_000_000;
    const { make, reports } = fresh({ now: () => t });
    const l = make();
    l.beginIntent('chat.postMessage', 'C1', null); // writes C1's reserve
    const first = l.takeOutageNotice('C1', null);
    expect(first).not.toBeNull();
    expect(first!.evidence).toMatchObject({ producerKind: 'server-automation', harness: { status: 'not-applicable' }, model: { status: 'not-applicable' } });
    t += 16 * 60_000;
    expect(l.takeOutageNotice('C1', null)).toBeNull(); // consumed this incarnation
    expect(l.takeOutageNotice('C9', null)).toBeNull(); // never had one
    expect(reports).toContain('SlackAdapter.originNotice');
    expect(make().takeOutageNotice('C1', null)).toBeNull(); // an earlier incarnation's reserve is never reused
  });

  it('only a refused post warrants a notice', () => {
    expect(refusalWarrantsNotice('chat.postMessage')).toBe(true);
    expect(refusalWarrantsNotice('chat.postEphemeral')).toBe(false);
    expect(refusalWarrantsNotice('chat.update')).toBe(false);
    expect(refusalWarrantsNotice('files.completeUploadExternal')).toBe(false);
  });
});
