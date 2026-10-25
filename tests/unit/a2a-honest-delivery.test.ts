/**
 * Honest delivery outcomes (docs/specs/a2a-honest-delivery-outcomes.md) — unit tier.
 *
 * The sender listens to the relay's per-message verdicts and records them; it
 * never infers failure from silence. These tests pin both sides of every
 * decision boundary in the spec's transition table, the reason-code bridge,
 * the silence sweep, the "peer went quiet" signal surviving the new states,
 * the settled-reply rule, and the client-side verdict dispatcher.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { A2ADeliveryTracker, nowIso } from '../../src/threadline/A2ADeliveryTracker.js';
import {
  mapRelayReason, clampRelayReason, clampRelayTtlSec, relayHoldHours, RELAY_TTL_CLAMP_SEC,
} from '../../src/threadline/relayVerdict.js';
import { ListenerSessionManager } from '../../src/threadline/ListenerSessionManager.js';
import { ThreadlineClient } from '../../src/threadline/client/ThreadlineClient.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const PEER = 'd5d07ce5f9b199abac3a90ea3c90d269';
const H = 60 * 60 * 1000;

function send(t: A2ADeliveryTracker, id: string, opts: { sentAt?: string; thread?: string; transport?: string } = {}): void {
  t.recordSent({ messageId: id, peerFp: PEER, peerName: 'luna', threadId: opts.thread ?? 'thread-1', transport: opts.transport ?? 'relay', sentAt: opts.sentAt });
}

describe('relay reason bridge (§1)', () => {
  it('maps the relay\'s actual refusal prefixes to fixed codes with retryability', () => {
    expect(mapRelayReason('Offline queue full (recipient-cap)')).toEqual({ code: 'queue-full', retryLater: true, unmapped: false });
    expect(mapRelayReason('Rate limited (perAgentPerMinute)')).toMatchObject({ code: 'rate-limited', retryLater: true });
    expect(mapRelayReason('New agent rate limit: 10/h')).toMatchObject({ code: 'rate-limited', retryLater: true });
    expect(mapRelayReason('Duplicate message ID (replay detected)')).toMatchObject({ code: 'routing-refused', retryLater: false });
    expect(mapRelayReason('Recipient socket not available')).toMatchObject({ code: 'routing-refused', retryLater: false });
  });

  it('an unrecognised reason is unmapped with UNKNOWN retryability — never a guess', () => {
    expect(mapRelayReason('Some new wording from a relay deploy')).toEqual({ code: 'unmapped', retryLater: null, unmapped: true });
    expect(mapRelayReason(undefined)).toEqual({ code: 'unmapped', retryLater: null, unmapped: true });
  });

  it('clamps relay prose and strips control, bidi and zero-width characters', () => {
    const raw = 'A\u0007B‮C​D' + 'x'.repeat(500);
    const out = clampRelayReason(raw)!;
    expect(out.startsWith('ABCD')).toBe(true);
    expect(out.length).toBe(200);
  });

  it('clamps the relay TTL: absent / non-finite / negative → 24 h, huge → 24 h', () => {
    expect(clampRelayTtlSec(undefined)).toBe(RELAY_TTL_CLAMP_SEC);
    expect(clampRelayTtlSec(Number.NaN)).toBe(RELAY_TTL_CLAMP_SEC);
    expect(clampRelayTtlSec(-5)).toBe(RELAY_TTL_CLAMP_SEC);
    expect(clampRelayTtlSec(1e12)).toBe(RELAY_TTL_CLAMP_SEC);
    expect(clampRelayTtlSec(3600)).toBe(3600);
    expect(relayHoldHours(1e12)).toBe(24);
    expect(relayHoldHours(5400)).toBe(2);
  });
});

describe('A2ADeliveryTracker relay verdicts (§2 transition table)', () => {
  let t: A2ADeliveryTracker;
  beforeEach(() => { t = A2ADeliveryTracker.openMemory(); });
  afterEach(() => t.close());

  it('delivered/queued store the verdict and leave state awaiting-ack', () => {
    send(t, 'm1'); send(t, 'm2');
    expect(t.recordRelayStatus({ messageId: 'm1', status: 'delivered' })).toBe('applied');
    expect(t.recordRelayStatus({ messageId: 'm2', status: 'queued', ttlSec: 3600 })).toBe('applied');
    expect(t.get('m1')).toMatchObject({ state: 'awaiting-ack', relayStatus: 'delivered' });
    const m2 = t.get('m2')!;
    expect(m2).toMatchObject({ state: 'awaiting-ack', relayStatus: 'queued' });
    expect(m2.relayExpiresAt).not.toBeNull();
  });

  it('every rejection fails the row and stores code + retryability (a refusal is never "unknown")', () => {
    send(t, 'm1'); send(t, 'm2');
    t.recordRelayStatus({ messageId: 'm1', status: 'rejected', reasonCode: 'queue-full', retryLater: true, reason: 'Offline queue full' });
    t.recordRelayStatus({ messageId: 'm2', status: 'rejected', reasonCode: 'unmapped', retryLater: null });
    expect(t.get('m1')).toMatchObject({ state: 'failed', relayStatus: 'rejected', relayReasonCode: 'queue-full', relayRetryable: true });
    expect(t.get('m2')).toMatchObject({ state: 'failed', relayReasonCode: 'unmapped', relayRetryable: null });
  });

  it('a later delivered/queued never overwrites a stored rejected or expired', () => {
    send(t, 'm1');
    t.recordRelayStatus({ messageId: 'm1', status: 'rejected', reasonCode: 'routing-refused', retryLater: false });
    expect(t.recordRelayStatus({ messageId: 'm1', status: 'delivered' })).toBe('ignored');
    expect(t.get('m1')).toMatchObject({ state: 'failed', relayStatus: 'rejected' });
  });

  it('an acked row is never changed by any relay verdict', () => {
    send(t, 'm1');
    t.recordAck('m1');
    expect(t.recordRelayStatus({ messageId: 'm1', status: 'rejected', reasonCode: 'routing-refused' })).toBe('ignored');
    expect(t.get('m1')!.state).toBe('acked');
  });

  it('unknown message ids are ignored (another process\'s send / pre-upgrade)', () => {
    expect(t.recordRelayStatus({ messageId: 'never-sent', status: 'delivered' })).toBe('ignored');
  });

  it('expired applies only when corroborated: row was queued AND recipient matches', () => {
    send(t, 'q'); send(t, 'd'); send(t, 'x');
    t.recordRelayStatus({ messageId: 'q', status: 'queued', ttlSec: 60 });
    t.recordRelayStatus({ messageId: 'd', status: 'delivered' });
    t.recordRelayStatus({ messageId: 'x', status: 'queued', ttlSec: 60 });
    expect(t.recordRelayStatus({ messageId: 'q', status: 'expired', recipientId: PEER })).toBe('applied');
    expect(t.recordRelayStatus({ messageId: 'd', status: 'expired', recipientId: PEER })).toBe('ignored');
    expect(t.recordRelayStatus({ messageId: 'x', status: 'expired', recipientId: 'someone-else' })).toBe('ignored');
    expect(t.get('q')).toMatchObject({ state: 'failed', relayStatus: 'expired' });
    expect(t.get('d')!.state).toBe('awaiting-ack');
    expect(t.get('x')!.state).toBe('awaiting-ack');
    expect(t.expiredMismatchIgnored).toBe(2);
    // A frame with no recipient is not corroboration either.
    send(t, 'n');
    t.recordRelayStatus({ messageId: 'n', status: 'queued', ttlSec: 60 });
    expect(t.recordRelayStatus({ messageId: 'n', status: 'expired' })).toBe('ignored');
    expect(t.get('n')!.state).toBe('awaiting-ack');
  });

  it('a ban fan-out lands as non-terminal unconfirmed, only from awaiting-ack with no relay status', () => {
    send(t, 'live'); send(t, 'already');
    t.recordRelayStatus({ messageId: 'already', status: 'delivered' });
    expect(t.recordRelayStatus({ messageId: 'live', status: 'unconfirmed', reasonCode: 'banned' })).toBe('applied');
    expect(t.recordRelayStatus({ messageId: 'already', status: 'unconfirmed', reasonCode: 'banned' })).toBe('ignored');
    expect(t.get('live')).toMatchObject({ state: 'unconfirmed', relayStatus: null, relayReasonCode: 'banned' });
    expect(t.get('already')!.state).toBe('awaiting-ack');
  });

  it('a late id-bearing verdict on an unconfirmed row corrects it', () => {
    send(t, 'b1'); send(t, 'b2');
    t.recordRelayStatus({ messageId: 'b1', status: 'unconfirmed', reasonCode: 'banned' });
    t.recordRelayStatus({ messageId: 'b2', status: 'unconfirmed', reasonCode: 'banned' });
    t.recordRelayStatus({ messageId: 'b1', status: 'delivered' });
    t.recordRelayStatus({ messageId: 'b2', status: 'rejected', reasonCode: 'routing-refused', retryLater: false });
    expect(t.get('b1')).toMatchObject({ state: 'awaiting-ack', relayStatus: 'delivered' });
    expect(t.get('b2')!.state).toBe('failed');
  });

  it('a reply acks an unconfirmed row but never a failed one', () => {
    send(t, 'refused', { sentAt: '2026-10-06T10:00:00.000Z' });
    send(t, 'unknown', { sentAt: '2026-10-06T11:00:00.000Z' });
    t.recordRelayStatus({ messageId: 'refused', status: 'rejected', reasonCode: 'routing-refused', retryLater: false });
    t.recordRelayStatus({ messageId: 'unknown', status: 'unconfirmed', reasonCode: 'banned' });
    expect(t.recordAckByThread('thread-1')).toBe('unknown');
    expect(t.get('refused')!.state).toBe('failed');
    expect(t.recordAck('refused')).toBe(false);
  });
});

describe('silence sweep (§3) — relabel only, never fail', () => {
  let t: A2ADeliveryTracker;
  beforeEach(() => { t = A2ADeliveryTracker.openMemory(); });
  afterEach(() => t.close());

  it('moves silent relay rows to unconfirmed after 24 h and queued rows after expiry + 1 h', () => {
    const since = t.relayTrackingSince();
    // tracking-since is "now" in a fresh DB; rows must be sent after it to be eligible.
    send(t, 'silent', { sentAt: new Date(Date.parse(since) + 1000).toISOString() });
    const sweepAt = Date.parse(since) + 1000 + 25 * H;
    const moved = t.sweepSilence(sweepAt);
    expect(moved).toEqual([{ messageId: 'silent', peerFp: PEER, cause: 'no-verdict-timeout' }]);
    expect(t.get('silent')!.state).toBe('unconfirmed');
  });

  it('never touches local-transport rows, rows sent before tracking began, delivered rows, or failed rows', () => {
    const since = Date.parse(t.relayTrackingSince());
    send(t, 'local', { sentAt: new Date(since + 1000).toISOString(), transport: 'local' });
    send(t, 'old', { sentAt: new Date(since - 1000).toISOString() });
    send(t, 'delivered', { sentAt: new Date(since + 1000).toISOString() });
    t.recordRelayStatus({ messageId: 'delivered', status: 'delivered' });
    send(t, 'refused', { sentAt: new Date(since + 1000).toISOString() });
    t.recordRelayStatus({ messageId: 'refused', status: 'rejected', reasonCode: 'routing-refused' });
    expect(t.sweepSilence(since + 1000 + 48 * H)).toEqual([]);
    expect(t.get('local')!.state).toBe('awaiting-ack');
    expect(t.get('old')!.state).toBe('awaiting-ack');
    expect(t.get('delivered')!.state).toBe('awaiting-ack');
    expect(t.get('refused')!.state).toBe('failed');
  });

  it('a queued row is relabelled only after relay_expires_at + 1 h', () => {
    const since = Date.parse(t.relayTrackingSince());
    send(t, 'q', { sentAt: new Date(since + 1000).toISOString() });
    t.recordRelayStatus({ messageId: 'q', status: 'queued', ttlSec: 3600 }, new Date(since + 2000).toISOString());
    expect(t.sweepSilence(since + 2000 + 1 * H + 30 * 60_000)).toEqual([]);
    expect(t.sweepSilence(since + 2000 + 2 * H + 60_000)).toEqual([{ messageId: 'q', peerFp: PEER, cause: 'queued-expired-unobserved' }]);
  });

  it('REGRESSION (round 2): the "peer went quiet" signal survives the sweep — a peer silent 30 h still reads stale', () => {
    const since = Date.parse(t.relayTrackingSince());
    send(t, 'silent', { sentAt: new Date(since + 1000).toISOString() });
    const at = since + 1000 + 30 * H;
    t.sweepSilence(at);
    const h = t.peerHealth(PEER, { nowMs: at });
    expect(h.unconfirmedCount).toBe(1);
    expect(h.pendingCount).toBe(1);
    expect(h.stale).toBe(true);
  });

  it('a provably-expired message marks the peer stale until a later inbound', () => {
    send(t, 'q');
    t.recordRelayStatus({ messageId: 'q', status: 'queued', ttlSec: 60 });
    t.recordRelayStatus({ messageId: 'q', status: 'expired', recipientId: PEER });
    expect(t.peerHealth(PEER).stale).toBe(true);
    expect(t.peerHealth(PEER).failedCount).toBe(1);
    t.recordInboundFrom(PEER, 'luna', new Date(Date.now() + 1000).toISOString());
    expect(t.peerHealth(PEER).stale).toBe(false);
  });

  it('peerHealth exposes the newest relay verdict as a code, never relay prose', () => {
    send(t, 'm');
    t.recordRelayStatus({ messageId: 'm', status: 'rejected', reasonCode: 'queue-full', retryLater: true, reason: 'Offline queue full (x)' });
    const h = t.peerHealth(PEER);
    expect(h.lastRelayStatus).toMatchObject({ status: 'rejected', reasonCode: 'queue-full', retryable: true });
    expect(JSON.stringify(h)).not.toContain('Offline queue full');
  });
});

describe('schema migration (§2, migration parity)', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-honest-mig-')); });
  afterEach(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/a2a-honest-delivery.test.ts' }));

  it('adds the columns to a pre-existing database in place, idempotently, keeping old rows', () => {
    const dbPath = path.join(dir, 'state', 'a2a-delivery.agent.sqlite');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const legacy = new Database(dbPath);
    legacy.exec(`CREATE TABLE a2a_delivery (message_id TEXT PRIMARY KEY, peer_fp TEXT NOT NULL, peer_name TEXT, thread_id TEXT, subject TEXT, transport TEXT, state TEXT NOT NULL, sent_at TEXT NOT NULL, acked_at TEXT, attempts INTEGER NOT NULL DEFAULT 1, last_attempt_at TEXT, next_retry_at TEXT, escalated_at TEXT);`);
    legacy.prepare(`INSERT INTO a2a_delivery (message_id, peer_fp, state, sent_at) VALUES ('old', ?, 'awaiting-ack', '2026-10-01T00:00:00.000Z')`).run(PEER);
    legacy.close();
    for (let i = 0; i < 2; i++) {
      const t = A2ADeliveryTracker.open('agent', dir);
      expect(t.get('old')).toMatchObject({ state: 'awaiting-ack', relayStatus: null });
      t.close();
    }
    const check = new Database(dbPath);
    const cols = (check.prepare(`PRAGMA table_info(a2a_delivery)`).all() as Array<{ name: string }>).map((c) => c.name);
    check.close();
    for (const c of ['relay_status', 'relay_status_at', 'relay_reason_code', 'relay_reason', 'relay_expires_at', 'relay_retryable']) expect(cols).toContain(c);
  });

  it('nowIso emits ISO-with-T timestamps (the lexical-compare invariant)', () => {
    expect(nowIso(new Date('2026-10-06T12:00:00Z'))).toBe('2026-10-06T12:00:00.000Z');
  });
});

describe('hasCanonicalReplyFor settled rule (§4)', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-honest-outbox-')); });
  afterEach(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/a2a-honest-delivery.test.ts' }));

  const entry = (m: ListenerSessionManager, outcome: string | undefined) => m.appendCanonicalOutboxEntry({
    from: 'echo', senderName: 'echo', to: PEER, recipientName: 'luna', threadId: 'thread-1', text: 'reply', inReplyTo: 'in-1', ...(outcome ? { outcome } : {}),
  });

  it('a lone refused reply is unsettled (re-drivable)', () => {
    const m = new ListenerSessionManager(dir, 'token');
    entry(m, 'relay-rejected');
    expect(m.hasCanonicalReplyFor('thread-1', 'in-1')).toBe(false);
  });

  it('[relay-sent, relay-rejected] stays settled — a refused retry never un-settles a success', () => {
    const m = new ListenerSessionManager(dir, 'token');
    entry(m, 'relay-sent'); entry(m, 'relay-rejected');
    expect(m.hasCanonicalReplyFor('thread-1', 'in-1')).toBe(true);
  });

  it('[relay-rejected, relay-sent] is settled', () => {
    const m = new ListenerSessionManager(dir, 'token');
    entry(m, 'relay-rejected'); entry(m, 'relay-sent');
    expect(m.hasCanonicalReplyFor('thread-1', 'in-1')).toBe(true);
  });

  it('legacy entries with no outcome, and relay-unconfirmed, count as settled (no duplicate)', () => {
    const m = new ListenerSessionManager(dir, 'token');
    entry(m, undefined);
    expect(m.hasCanonicalReplyFor('thread-1', 'in-1')).toBe(true);
    const m2 = new ListenerSessionManager(fs.mkdtempSync(path.join(dir, 'b-')), 'token');
    entry(m2, 'relay-unconfirmed');
    expect(m2.hasCanonicalReplyFor('thread-1', 'in-1')).toBe(true);
  });
});

describe('ThreadlineClient verdict dispatcher (§1)', () => {
  let client: ThreadlineClient;
  let now: number;
  const priv = () => client as unknown as {
    handleRelayAckFrame(f: Record<string, unknown>): void;
    handleRelayErrorFrame(f: Record<string, unknown>): void;
    noteSent(id: string): void;
  };
  beforeEach(() => { now = 1_000_000; client = new ThreadlineClient({ name: 'echo', stateDir: os.tmpdir() } as never, () => now); });

  it('REGRESSION (round 1): a verdict that lands before anyone waits is not lost (cache)', async () => {
    priv().handleRelayAckFrame({ type: 'ack', messageId: 'm1', status: 'delivered' });
    await expect(client.awaitRelayAck('m1', 10)).resolves.toMatchObject({ status: 'delivered' });
  });

  it('a waiter resolves on the verdict and times out to null otherwise', async () => {
    const p = client.awaitRelayAck('m2', 1000);
    priv().handleRelayAckFrame({ type: 'ack', messageId: 'm2', status: 'queued', ttl: 3600 });
    await expect(p).resolves.toMatchObject({ status: 'queued', ttlSec: 3600 });
    await expect(client.awaitRelayAck('m3', 5)).resolves.toBeNull();
  });

  it('a rejected ack carries a fixed code and never re-emits the raw text to listeners as the code', async () => {
    const seen: unknown[] = [];
    client.on('relay-verdict', (v) => seen.push(v));
    priv().handleRelayAckFrame({ type: 'ack', messageId: 'm4', status: 'rejected', reason: 'Offline queue full (cap)' });
    expect(seen[0]).toMatchObject({ status: 'rejected', reasonCode: 'queue-full', retryLater: true });
  });

  it('an unmapped reason increments the drift counter and reports unknown retryability', () => {
    priv().handleRelayAckFrame({ type: 'ack', messageId: 'm5', status: 'rejected', reason: 'brand new relay wording' });
    expect(client.relayVerdictCounters.unmappedReason).toBe(1);
  });

  it('the ban frame (lowercase wire code) resolves LIVE waiters as unconfirmed/banned and sets the hint', async () => {
    const p = client.awaitRelayAck('m6', 1000);
    priv().handleRelayErrorFrame({ type: 'error', code: 'banned', message: 'Banned until …' });
    await expect(p).resolves.toMatchObject({ status: 'unconfirmed', reasonCode: 'banned' });
    expect(client.banSuspected).toBe(true);
  });

  it('an uppercase BANNED is not the wire value and does nothing', () => {
    priv().handleRelayErrorFrame({ type: 'error', code: 'BANNED' });
    expect(client.banSuspected).toBe(false);
  });

  it('the ban hint clears only on an ack for a message sent AFTER the ban, never on an older flush ack', () => {
    priv().noteSent('before');
    priv().handleRelayErrorFrame({ type: 'error', code: 'banned' });
    priv().handleRelayAckFrame({ type: 'ack', messageId: 'before', status: 'delivered' });
    expect(client.banSuspected).toBe(true);
    priv().handleRelayAckFrame({ type: 'ack', messageId: 'unknown-id', status: 'delivered' });
    expect(client.banSuspected).toBe(true);
    priv().noteSent('after');
    priv().handleRelayAckFrame({ type: 'ack', messageId: 'after', status: 'delivered' });
    expect(client.banSuspected).toBe(false);
  });

  it('the waiter cap resolves new waits to null and counts it', async () => {
    const waits: Promise<unknown>[] = [];
    for (let i = 0; i < 1000; i++) waits.push(client.awaitRelayAck(`w${i}`, 60_000));
    await expect(client.awaitRelayAck('over', 60_000)).resolves.toBeNull();
    expect(client.relayVerdictCounters.waiterOverCap).toBe(1);
    for (let i = 0; i < 1000; i++) priv().handleRelayAckFrame({ type: 'ack', messageId: `w${i}`, status: 'delivered' });
    await Promise.all(waits);
  });
});
