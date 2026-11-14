/**
 * Unit (Tier 1) — relay-socket inbound canonical history + large-body backing.
 *
 * Real ThreadLog + real ThreadMessageRecorder + real MessageStore (no mocks of
 * the units under test). Covers: the >8 KiB body is backed by a resolvable
 * MessageStore record (never a dangling textRef), the peer/id/digest namespace,
 * duplicate + collision never poisoning the first body, the no-backing failure
 * being observable and non-throwing, and the relay ingress step's exclusions and
 * legacy timestamp / message-id fallbacks.
 */

// canonical-migration-validator: threadline-inbound-canonical-store@4
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ThreadLog } from '../../../src/threadline/ThreadLog.js';
import { ConversationStore } from '../../../src/threadline/ConversationStore.js';
import { ThreadMessageRecorder, threadBodyStoreId } from '../../../src/threadline/recordThreadMessage.js';
import { recordRelayIngressHistory, legacyRelayMessageId, classifyRelayIngress, recordGatePassedIngress } from '../../../src/threadline/relayIngressHistory.js';
import { createThreadMessageRecorder } from '../../../src/threadline/createThreadMessageRecorder.js';
import { MessageStore } from '../../../src/messaging/MessageStore.js';
import { createThreadlineReapRecovery } from '../../../src/threadline/ThreadlineReapRecovery.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import { DegradationReporter } from '../../../src/monitoring/DegradationReporter.js';

const PEER = 'a'.repeat(32);
const BIG = 'x'.repeat(9000) + ' end-of-large-body';

let dir: string;
let threadLog: ThreadLog;
let convo: ConversationStore;
let messageStore: MessageStore;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-ingress-hist-'));
  threadLog = new ThreadLog(dir);
  convo = new ConversationStore(dir);
  messageStore = new MessageStore(path.join(dir, 'messages'));
  await messageStore.initialize();
});
afterEach(() => {
  vi.restoreAllMocks();
  SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/threadline/relayIngressHistory.test.ts' });
});

function recorder(extra: Partial<ConstructorParameters<typeof ThreadMessageRecorder>[0]> = {}) {
  return new ThreadMessageRecorder({ threadLog, conversationStore: convo, headCacheCoalesceMs: 1, bodyStore: messageStore, ...extra });
}

function bodyDir(threadId: string) {
  return path.join(dir, 'messages', 'bodies', MessageStore.threadBodyPartition(threadId));
}
function bodyFiles(threadId: string): string[] {
  return fs.existsSync(bodyDir(threadId)) ? fs.readdirSync(bodyDir(threadId)) : [];
}

function inboundRow(threadId: string, messageId: string) {
  return threadLog.read(threadId, { limit: 1000 }).entries.find((e) => e.messageId === messageId && e.direction === 'inbound');
}

describe('ThreadMessageRecorder — over-cap body backing', () => {
  it('a >8 KiB body is written to MessageStore and the log reference resolves (text, not just a row)', async () => {
    const r = recorder();
    const res = r.record({ threadId: 'thread-big', messageId: 'm-1', direction: 'inbound', body: BIG, createdAt: '2026-11-10T01:00:00.000Z', peerFingerprint: PEER });
    expect(res.status).toBe('appended');
    const row = inboundRow('thread-big', 'm-1')!;
    expect(row.textRef.kind).toBe('store');
    const storeId = (row.textRef as { messageStoreId: string }).messageStoreId;
    expect(MessageStore.isThreadBodyStoreId(storeId)).toBe(true);
    expect(storeId).not.toBe('m-1'); // never the raw wire id
    // Resolvable through the recorder AND the real MessageStore read path.
    expect(r.resolveText(row)).toBe(BIG);
    const env = await messageStore.get(storeId);
    expect(env?.message.id).toBe('m-1');
    expect(env?.message.body).toBe(BIG);
    // Backing records stay out of the delivery store/indexes.
    expect(await messageStore.queryInbox('local')).toHaveLength(0);
  });

  it('ThreadlineReapRecovery (the existing consumer) recovers the large body from the backing', async () => {
    const r = recorder();
    r.record({ threadId: 'thread-reap', messageId: 'm-r', direction: 'inbound', body: BIG, createdAt: '2026-11-10T01:00:00.000Z', peerFingerprint: PEER });
    let routed: { body?: string } | null = null;
    const manager = { readCanonicalInboxEntry: () => null, hasReplyClaim: () => false, hasCanonicalReplyFor: () => false, tryClaimReply: () => true, releaseReplyClaim: () => {} };
    const recovery = createThreadlineReapRecovery({
      localAgent: 'echo',
      manager: () => manager as never,
      threadLog: () => threadLog,
      messageStore: () => messageStore,
      router: () => ({ handleInboundMessage: async (env: { message: { body: string } }) => { routed = env.message; return { handled: true, spawned: true }; } }) as never,
    });
    const entry = { id: 'q1', threadlineMessageId: 'm-r', threadId: 'thread-reap' } as never;
    expect(recovery.pending(entry)).toBe(true);
    await recovery.respawn(entry).catch(() => { /* the router stub's return shape is not under test */ });
    expect(routed?.body).toBe(BIG);
  });

  it('the store id is namespaced by peer + thread + id + digest and is path-safe for hostile ids', () => {
    const base = { direction: 'inbound' as const, threadId: 'thread-ns', messageId: '../../etc/passwd', contentDigest: 'd1' };
    const a = threadBodyStoreId({ ...base, peerFingerprint: PEER });
    const b = threadBodyStoreId({ ...base, peerFingerprint: 'b'.repeat(32) });
    const c = threadBodyStoreId({ ...base, peerFingerprint: PEER, contentDigest: 'd2' });
    expect(new Set([a, b, c]).size).toBe(3);
    for (const id of [a, b, c]) expect(MessageStore.isThreadBodyStoreId(id)).toBe(true);
    const r = recorder();
    r.record({ threadId: 'thread-ns', messageId: '../../etc/passwd', direction: 'inbound', body: BIG, createdAt: '2026-11-10T01:00:00.000Z', peerFingerprint: PEER });
    // Exactly one partition (the thread's full SHA-256), holding one record.
    expect(fs.readdirSync(path.join(dir, 'messages', 'bodies'))).toEqual([MessageStore.threadBodyPartition('thread-ns')]);
    const files = bodyFiles('thread-ns');
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(new RegExp(`^tlbody-${MessageStore.threadBodyPartition('thread-ns')}-[0-9a-f]{64}\\.json$`));
  });

  it('duplicate keeps one record; a same-id different-body collision never overwrites the first body', () => {
    const r = recorder();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const input = { threadId: 'thread-col', messageId: 'm-c', direction: 'inbound' as const, body: BIG, createdAt: '2026-11-10T01:00:00.000Z', peerFingerprint: PEER };
    expect(r.record(input).status).toBe('appended');
    expect(r.record(input).status).toBe('duplicate');
    expect(r.record({ ...input, body: BIG + ' TAMPERED' }).status).toBe('collision');
    expect(warn).toHaveBeenCalled();
    expect(bodyFiles('thread-col')).toHaveLength(1);
    expect(r.resolveText(inboundRow('thread-col', 'm-c')!)).toBe(BIG);
  });

  it('a tampered backing record does not resolve (digest-verified, never a guess)', () => {
    const r = recorder();
    r.record({ threadId: 'thread-tamper', messageId: 'm-t', direction: 'inbound', body: BIG, createdAt: '2026-11-10T01:00:00.000Z', peerFingerprint: PEER });
    const row = inboundRow('thread-tamper', 'm-t')!;
    const file = path.join(bodyDir('thread-tamper'), `${(row.textRef as { messageStoreId: string }).messageStoreId}.json`);
    const env = JSON.parse(fs.readFileSync(file, 'utf-8'));
    env.message.body = 'swapped';
    fs.writeFileSync(file, JSON.stringify(env));
    expect(r.resolveText(row)).toBeNull();
  });

  it.each(['corrupt JSON', 'unreadable file'])('%s reports metadata without private text; retention stays quiet', (failure) => {
    const report = vi.spyOn(DegradationReporter.getInstance(), 'report').mockImplementation(() => {});
    const r = recorder();
    r.record({ threadId: 'thread-corrupt', messageId: 'm-k', direction: 'inbound', body: BIG, createdAt: '2026-11-10T01:00:00.000Z', peerFingerprint: PEER });
    const row = inboundRow('thread-corrupt', 'm-k')!;
    const storeId = (row.textRef as { messageStoreId: string }).messageStoreId;
    const file = path.join(bodyDir('thread-corrupt'), `${storeId}.json`);
    if (failure === 'corrupt JSON') {
      fs.writeFileSync(file, 'PRIVATE-SENTINEL malformed private body');
    } else {
      fs.renameSync(file, `${file}.original`);
      fs.mkdirSync(file); // deterministic real read failure even with elevated privileges
    }
    expect(r.resolveText(row)).toBeNull();
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0][0]).toMatchObject({ feature: 'MessageStore.threadBody' });
    expect(String(report.mock.calls[0][0].reason)).toContain(storeId);
    expect(report.mock.calls[0][0].reason).toContain(failure === 'corrupt JSON' ? 'invalid JSON' : 'read failed');
    expect(JSON.stringify(report.mock.calls[0][0])).not.toContain('PRIVATE');

    report.mockClear();
    messageStore.deleteThreadBodiesSync('thread-corrupt');
    expect(r.resolveText(row)).toBeNull();
    expect(messageStore.getThreadBodySync(storeId)).toBeNull();
    expect(report).not.toHaveBeenCalled();
  });

  it('no backing store: an over-cap body fails observably (append-failed + Attention after the streak), no dangling row, never throws', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const items: Array<{ id: string }> = [];
    const r = recorder({ bodyStore: null, appendFailureAlertThreshold: 2, attention: { createAttentionItem: (i) => { items.push(i); } } });
    for (let i = 0; i < 2; i++) {
      expect(r.record({ threadId: 'thread-nostore', messageId: `m-${i}`, direction: 'inbound', body: BIG, createdAt: '2026-11-10T01:00:00.000Z', peerFingerprint: PEER }).status).toBe('append-failed');
    }
    expect(threadLog.read('thread-nostore', { limit: 10 }).entries).toHaveLength(0);
    expect(items.map((i) => i.id)).toEqual(['threadline-canonical-append-fail:thread-nostore']);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('no body store is wired'))).toBe(true);
    // A small body on the same recorder still records inline.
    expect(r.record({ threadId: 'thread-nostore', messageId: 'small', direction: 'inbound', body: 'hi', createdAt: '2026-11-10T01:00:00.000Z' }).status).toBe('appended');
  });
});

describe('canonical body retention — close-only, per-thread partition', () => {
  const big = (threadId: string, messageId: string) => ({ threadId, messageId, direction: 'inbound' as const, body: BIG, createdAt: '2026-11-10T01:00:00.000Z', peerFingerprint: PEER });
  const prod = () => createThreadMessageRecorder({ config: { stateDir: dir }, threadLog, conversationStore: convo, messageStore, onContact: () => {} });

  it('a save whose id partition does not match the envelope thread is refused', () => {
    const r = recorder();
    r.record(big('thread-own', 'm-1'));
    const id = (inboundRow('thread-own', 'm-1')!.textRef as { messageStoreId: string }).messageStoreId;
    const env = messageStore.getThreadBodySync(id)!;
    const foreign = { ...env, message: { ...env.message, threadId: 'thread-other' } };
    const forged = `tlbody-${MessageStore.threadBodyPartition('thread-own')}-${'0'.repeat(64)}`;
    expect(() => messageStore.saveThreadBodySync(forged, foreign)).toThrow(/does not belong/);
    expect(bodyFiles('thread-other')).toHaveLength(0);
  });

  it('a true resolved close (shared production seam) removes that thread\'s log AND bodies — including a body whose log append failed — and no other thread\'s', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = prod();
    await convo.mutate('thread-close', (d) => { d.state = 'active'; return d; });
    await convo.mutate('thread-keep', (d) => { d.state = 'active'; return d; });
    expect(r.record(big('thread-close', 'm-1')).status).toBe('appended');
    expect(r.record(big('thread-keep', 'm-1')).status).toBe('appended');
    // Body written, then the log append fails: the orphan body lives in the same partition.
    const spy = vi.spyOn(threadLog, 'append').mockImplementationOnce(() => { throw new Error('EIO'); });
    expect(r.record(big('thread-close', 'm-orphan')).status).toBe('append-failed');
    spy.mockRestore();
    expect(bodyFiles('thread-close')).toHaveLength(2);

    await convo.mutate('thread-close', (d) => { d.state = 'resolved'; return d; });
    expect(fs.existsSync(bodyDir('thread-close'))).toBe(false);
    expect(threadLog.read('thread-close', { limit: 10 }).entries).toHaveLength(0);
    // The other thread is untouched and still resolves through MessageStore.get (reap-recovery read path).
    const keepRow = inboundRow('thread-keep', 'm-1')!;
    expect(r.resolveText(keepRow)).toBe(BIG);
    expect((await messageStore.get((keepRow.textRef as { messageStoreId: string }).messageStoreId))?.message.body).toBe(BIG);
  });

  it('pinned close, cold archive and retireInactive keep the bodies (no seam fire)', async () => {
    const r = prod();
    await convo.mutate('thread-pin', (d) => { d.pinned = true; d.state = 'active'; return d; });
    await convo.mutate('thread-cold', (d) => { d.state = 'active'; return d; });
    await convo.mutate('thread-lru', (d) => { d.state = 'active'; d.lastActivityAt = new Date(Date.now() - 48 * 3600_000).toISOString(); return d; });
    for (const t of ['thread-pin', 'thread-cold', 'thread-lru']) r.record(big(t, 'm-1'));
    await convo.mutate('thread-pin', (d) => { d.state = 'resolved'; return d; });
    await convo.mutate('thread-cold', (d) => { d.state = 'archived'; return d; });
    expect(convo.retireInactive(24 * 3600_000)).toBeGreaterThanOrEqual(1);
    for (const t of ['thread-pin', 'thread-cold', 'thread-lru']) {
      expect(bodyFiles(t)).toHaveLength(1);
      expect(r.resolveText(inboundRow(t, 'm-1')!)).toBe(BIG);
    }
  });

  it('log rotation never drops a body: every row (live or archived) keeps a resolvable backing', () => {
    threadLog = new ThreadLog(dir, { maxEntriesPerThread: 4 });
    const r = recorder();
    for (let i = 0; i < 9; i++) expect(r.record(big('thread-rot', `m-${i}`)).status).toBe('appended');
    expect(threadLog.read('thread-rot', { limit: 100 }).entries.length).toBeLessThan(9);
    expect(bodyFiles('thread-rot')).toHaveLength(9);
  });
});

describe('recordRelayIngressHistory — the relay-socket inbound step', () => {
  const base = { message: { from: PEER, threadId: 'thread-relay', messageId: 'rm-1', timestamp: '2026-11-10T02:03:04.567Z' }, text: 'please review the patch', ackConsumed: false, fallbackThreadId: 'auto-x' };

  it('records an authorized inbound with the original wire timestamp, id, thread and verified peer', () => {
    const out = recordRelayIngressHistory(recorder(), { ...base, reason: 'relay-authenticated' });
    expect(out.status).toBe('appended');
    const row = inboundRow('thread-relay', 'rm-1')!;
    expect(row.createdAt).toBe('2026-11-10T02:03:04.567Z');
    expect(row.createdAtSource).toBeUndefined();
    expect(row.peerFingerprint).toBe(PEER);
    expect(row.author.agentFingerprint).toBe(PEER);
    expect(row.textRef).toEqual({ kind: 'inline', text: 'please review the patch' });
  });

  it('excludes probes, consumed acks, a missing recorder and non-canonical thread ids — nothing is logged', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = recorder();
    expect(recordRelayIngressHistory(r, { ...base, reason: 'probe' })).toEqual({ status: 'excluded', reason: 'probe' });
    expect(recordRelayIngressHistory(r, { ...base, ackConsumed: true })).toEqual({ status: 'excluded', reason: 'ack' });
    expect(recordRelayIngressHistory(null, base)).toEqual({ status: 'excluded', reason: 'no-recorder' });
    expect(recordRelayIngressHistory(r, { ...base, message: { ...base.message, threadId: '../escape' } })).toEqual({ status: 'excluded', reason: 'invalid-thread-id' });
    expect(recordRelayIngressHistory(r, { ...base, message: { ...base.message, threadId: undefined } })).toEqual({ status: 'excluded', reason: 'invalid-thread-id' });
    expect(threadLog.read('thread-relay', { limit: 10 }).entries).toHaveLength(0);
  });

  it('legacy missing timestamp: receive time with explicit provenance; a later retry is a duplicate, not a collision', () => {
    const r = recorder();
    const noTs = { ...base, message: { ...base.message, timestamp: undefined } };
    const first = recordRelayIngressHistory(r, { ...noTs, receivedAt: () => '2026-11-10T03:00:00.000Z' });
    expect(first).toMatchObject({ status: 'appended', createdAtSource: 'receive-time' });
    const retry = recordRelayIngressHistory(r, { ...noTs, receivedAt: () => '2026-11-10T03:05:00.000Z' });
    expect(retry.status).toBe('duplicate');
    const rows = threadLog.read('thread-relay', { limit: 10 }).entries;
    expect(rows).toHaveLength(1);
    expect(rows[0].createdAt).toBe('2026-11-10T03:00:00.000Z');
    expect(rows[0].createdAtSource).toBe('receive-time');
    expect(convo.get('thread-relay')?.collisionCount ?? 0).toBe(0);
  });

  it('legacy missing timestamp: a same-id retry with a DIFFERENT body is a collision, never a duplicate; the first row/time is kept', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = recorder();
    const noTs = { ...base, message: { ...base.message, timestamp: undefined } };
    expect(recordRelayIngressHistory(r, { ...noTs, receivedAt: () => '2026-11-10T03:00:00.000Z' }).status).toBe('appended');
    const changed = recordRelayIngressHistory(r, { ...noTs, text: 'a different body', receivedAt: () => '2026-11-10T03:05:00.000Z' });
    expect(changed.status).toBe('collision');
    expect(warn.mock.calls.some((c) => String(c[0]).includes('content collision on thread-relay'))).toBe(true);
    const rows = threadLog.read('thread-relay', { limit: 10 }).entries;
    expect(rows).toHaveLength(1);
    expect(rows[0].createdAt).toBe('2026-11-10T03:00:00.000Z');
    expect(rows[0].textRef).toEqual({ kind: 'inline', text: 'please review the patch' });
  });

  it('legacy missing message id: a stable derived id, so a redelivered copy dedupes', () => {
    const r = recorder();
    const noId = { ...base, message: { ...base.message, messageId: undefined } };
    const a = recordRelayIngressHistory(r, noId);
    const b = recordRelayIngressHistory(r, noId);
    expect(a.status).toBe('appended');
    expect(b.status).toBe('duplicate');
    const expected = legacyRelayMessageId({ from: PEER, threadId: 'thread-relay', timestamp: base.message.timestamp, text: base.text });
    expect('messageId' in a && a.messageId).toBe(expected);
    expect(threadLog.read('thread-relay', { limit: 10 }).entries).toHaveLength(1);
  });

  it('an append failure is reported, never thrown (delivery stays non-blocking)', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const failing = { append: () => { throw new Error('EACCES'); }, has: () => false, head: () => ({ count: 0, headHash: '', setAccum: '' }) } as unknown as ThreadLog;
    const r = new ThreadMessageRecorder({ threadLog: failing, conversationStore: convo, bodyStore: messageStore });
    expect(() => recordRelayIngressHistory(r, base)).not.toThrow();
    expect(recordRelayIngressHistory(r, base).status).toBe('append-failed');
  });

  it('a >8 KiB relay inbound is recorded with a resolvable backing body', () => {
    const r = recorder();
    expect(recordRelayIngressHistory(r, { ...base, text: BIG }).status).toBe('appended');
    expect(r.resolveText(inboundRow('thread-relay', 'rm-1')!)).toBe(BIG);
  });
});

describe('B1 — a bootstrap-synthesized timestamp is receive time, never a sender stamp', () => {
  const legacy = (ts: string) => ({
    reason: 'relay-authenticated',
    // As ThreadlineBootstrap's unknown-sender path builds it: no id, the timestamp filled in + marked.
    message: { from: PEER, threadId: 'thread-legacy-synth', timestamp: ts, timestampSynthesized: true },
    text: 'hi from an old sender', ackConsumed: false, fallbackThreadId: 'auto-x',
  });

  it('is recorded with receive-time provenance and a legacy id that ignores the synthesized time; a redelivery dedupes', () => {
    const r = recorder();
    const first = recordRelayIngressHistory(r, legacy('2026-11-10T05:00:00.000Z'));
    expect(first).toMatchObject({ status: 'appended', createdAtSource: 'receive-time' });
    const id = legacyRelayMessageId({ from: PEER, threadId: 'thread-legacy-synth', text: 'hi from an old sender' });
    expect((first as { messageId: string }).messageId).toBe(id);
    const row = inboundRow('thread-legacy-synth', id)!;
    expect(row.createdAt).toBe('2026-11-10T05:00:00.000Z');
    expect(row.createdAtSource).toBe('receive-time');
    // The redelivery's bootstrap fill-in is a DIFFERENT receive time: same id, duplicate, one row.
    const again = recordRelayIngressHistory(r, legacy('2026-11-10T05:00:09.000Z'));
    expect(again).toMatchObject({ status: 'duplicate', messageId: id });
    expect(threadLog.read('thread-legacy-synth', { limit: 10 }).entries).toHaveLength(1);
  });

  it('a real sender stamp (no synthesized mark) stays a wire stamp', () => {
    const out = recordRelayIngressHistory(recorder(), { ...legacy('2026-11-10T05:00:00.000Z'), message: { from: PEER, threadId: 'thread-legacy-synth', messageId: 'w-1', timestamp: '2026-11-10T05:00:00.000Z' } });
    expect(out).toMatchObject({ status: 'appended', createdAtSource: 'wire' });
    expect(inboundRow('thread-legacy-synth', 'w-1')!.createdAtSource).toBeUndefined();
  });
});

describe('P3 — thread ids outside the canonical allowlist are skipped (protocol limit)', () => {
  it('the bootstrap relay-<ms> fallback and an uppercase UUID are skipped; the warning is JSON-quoted and rate-limited per peer', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = recorder();
    const peer = 'f'.repeat(32);
    const mk = (threadId: string) => ({ reason: 'relay-authenticated', message: { from: peer, threadId, messageId: 'x-1', timestamp: '2026-11-10T00:00:00.000Z' }, text: 't', ackConsumed: false, fallbackThreadId: 'auto-x' });
    expect(recordRelayIngressHistory(r, mk(`relay-${Date.now()}`))).toEqual({ status: 'excluded', reason: 'invalid-thread-id' });
    expect(recordRelayIngressHistory(r, mk('3F2504E0-4F89-11D3-9A0C-0305E82C3301'))).toEqual({ status: 'excluded', reason: 'invalid-thread-id' });
    const lines = () => warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('canonical history skipped'));
    expect(lines()).toHaveLength(1); // once per peer per window
    const forged = { ...mk('evil\n[relay] forged line'), message: { ...mk('x').message, from: 'e'.repeat(32), threadId: 'evil\n[relay] forged line' } };
    expect(recordRelayIngressHistory(r, forged)).toEqual({ status: 'excluded', reason: 'invalid-thread-id' });
    expect(lines()).toHaveLength(2);
    expect(lines()[1]).not.toMatch(/\n/); // JSON-quoted: a newline cannot forge a log line
    expect(lines()[1]).toContain('evil\\n[relay]');
    expect(lines()[0]).toContain('"relay-');
  });
});

describe('classifyRelayIngress + recordGatePassedIngress — the shared handler step', () => {
  it('normalizes text exactly as the handler did and classifies auto-acks and kinded acks once', () => {
    expect(classifyRelayIngress({ content: 'plain' })).toMatchObject({ textContent: 'plain', msgType: undefined, isAutoAck: false, kindedAck: null });
    expect(classifyRelayIngress({ content: { content: 'hello', type: 'chat' } })).toMatchObject({ textContent: 'hello', msgType: 'chat', isAutoAck: false });
    expect(classifyRelayIngress({ content: { text: 'via text' } }).textContent).toBe('via text');
    expect(classifyRelayIngress({ content: { other: 1 } }).textContent).toBe('{"other":1}');
    expect(classifyRelayIngress({ content: 42 }).textContent).toBe('42');
    expect(classifyRelayIngress({ content: { content: 'Message received. Composing response...', type: 'ack' } }).isAutoAck).toBe(true);
  });

  it('records an ordinary message and excludes an ack the ack stage consumes', () => {
    const r = recorder();
    const msg = { from: PEER, threadId: 'thread-gp', messageId: 'gp-1', timestamp: '2026-11-10T00:00:00.000Z', content: { content: 'real text', type: 'chat' } };
    expect(recordGatePassedIngress(r, { reason: 'relay-authenticated', message: msg }, classifyRelayIngress(msg), 'auto-x').status).toBe('appended');
    const ack = { ...msg, messageId: 'gp-2', content: { content: 'Message received. Composing response...', type: 'ack' } };
    expect(recordGatePassedIngress(r, { message: ack }, classifyRelayIngress(ack), 'auto-x')).toEqual({ status: 'excluded', reason: 'ack' });
    expect(threadLog.read('thread-gp', { limit: 10 }).entries.map((e) => e.messageId)).toEqual(['gp-1']);
  });
});

describe('createThreadMessageRecorder — the one production composition', () => {
  it('wires the MessageStore backing and the peer-contact hook (fires only on a NEW leg)', () => {
    const contacts: string[] = [];
    const r = createThreadMessageRecorder({ config: { stateDir: dir }, threadLog, conversationStore: convo, messageStore, onContact: (p) => contacts.push(p) });
    const msg = { from: PEER, threadId: 'thread-cmp', messageId: 'c-1', timestamp: '2026-11-10T00:00:00.000Z', content: BIG };
    expect(recordGatePassedIngress(r, { reason: 'relay-authenticated', message: msg }, classifyRelayIngress(msg), 'auto-x').status).toBe('appended');
    expect(recordGatePassedIngress(r, { reason: 'relay-authenticated', message: msg }, classifyRelayIngress(msg), 'auto-x').status).toBe('duplicate');
    expect(contacts).toEqual([PEER]);
    const row = inboundRow('thread-cmp', 'c-1')!;
    expect(row.textRef.kind).toBe('store');
    expect(r.resolveText(row)).toBe(BIG); // no dangling over-cap reference
  });

  it('a throwing contact hook never affects recording, and the step never throws', () => {
    const r = createThreadMessageRecorder({ config: { stateDir: dir }, threadLog, conversationStore: convo, messageStore, onContact: () => { throw new Error('hook boom'); } });
    const msg = { from: PEER, threadId: 'thread-cmp2', messageId: 'c-2', timestamp: '2026-11-10T00:00:00.000Z', content: 'x' };
    expect(recordGatePassedIngress(r, { message: msg }, classifyRelayIngress(msg), 'auto-x').status).toBe('appended');
  });

  it('honors the config canonicalHistory.inlineMaxBytes knob', () => {
    const r = createThreadMessageRecorder({ config: { stateDir: dir, threadline: { canonicalHistory: { inlineMaxBytes: 4 } } }, threadLog, conversationStore: convo, messageStore, onContact: () => {} });
    r.record({ threadId: 'thread-knob', messageId: 'k-1', direction: 'inbound', body: 'longer than four', createdAt: '2026-11-10T00:00:00.000Z', peerFingerprint: PEER });
    const row = inboundRow('thread-knob', 'k-1')!;
    expect(row.textRef.kind).toBe('store');
    expect(r.resolveText(row)).toBe('longer than four');
  });
});
