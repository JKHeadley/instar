/**
 * The "I have your message; my reply is delayed" notice is only sent for a held
 * SESSION reply, at most once per topic per hold episode. Held background output
 * (server-automation: job results, status lines, restart notices) never
 * triggers it. Before this, every held background message on a standby posted
 * the notice, so topics nobody had written in got bursts of them.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  HeldNoticeGate, HELD_NOTICE_TOPIC_COOLDOWN_MS, forwardReplyToHolder,
} from '../../src/messaging/telegram-origin/OriginForwardToHolder.js';
import type { ForwardDeps, HolderSubmitResult } from '../../src/messaging/telegram-origin/OriginForwardToHolder.js';
import type { OriginPreparedBotOperation } from '../../src/messaging/telegram-origin/TelegramOriginService.js';
import { OriginStore } from '../../src/messaging/telegram-origin/OriginStore.js';
import { compileOriginWorker, temporaryState, admission, hash } from '../helpers/telegramOriginStore.js';

function clock() {
  let now = 1_000_000;
  return { now: () => now, sleep: async (ms: number) => { now += ms; }, advance: (ms: number) => { now += ms; } };
}

describe('HeldNoticeGate', () => {
  it('suppresses background output (server-automation) — the notice would be false', () => {
    const gate = new HeldNoticeGate({ now: () => 0 });
    expect(gate.decide({ topicId: 5, producerKind: 'server-automation' })).toEqual({ send: false, reason: 'automation' });
  });
  it('suppresses an unreadable or legacy author too (never claim a message nobody is answering)', () => {
    const gate = new HeldNoticeGate({ now: () => 0 });
    expect(gate.decide({ topicId: 5, producerKind: null })).toEqual({ send: false, reason: 'automation' });
    expect(gate.decide({ topicId: 5, producerKind: undefined })).toEqual({ send: false, reason: 'automation' });
    expect(gate.decide({ topicId: 5, producerKind: 'imported-legacy' })).toEqual({ send: false, reason: 'automation' });
  });
  it('allows the first held session reply in a topic', () => {
    const gate = new HeldNoticeGate({ now: () => 0 });
    expect(gate.decide({ topicId: 5, producerKind: 'session' })).toEqual({ send: true });
  });
  it('tells a topic once per cooldown however many replies are held, and other topics independently', () => {
    const c = clock();
    const gate = new HeldNoticeGate({ now: c.now });
    expect(gate.decide({ topicId: 5, producerKind: 'session' }).send).toBe(true);
    gate.recordSent(5);
    c.advance(60_000);
    expect(gate.decide({ topicId: 5, producerKind: 'session' })).toEqual({ send: false, reason: 'already-noticed' });
    expect(gate.decide({ topicId: 6, producerKind: 'session' }).send).toBe(true);
    c.advance(HELD_NOTICE_TOPIC_COOLDOWN_MS);
    expect(gate.decide({ topicId: 5, producerKind: 'session' }).send).toBe(true);
  });
  it('an undelivered notice leaves the topic eligible (only recordSent counts)', () => {
    const gate = new HeldNoticeGate({ now: () => 0 });
    expect(gate.decide({ topicId: 5, producerKind: 'session' }).send).toBe(true);
    expect(gate.decide({ topicId: 5, producerKind: 'session' }).send).toBe(true);
  });
});

describe('forwardReplyToHolder with the notice gate', () => {
  function setup(producerKind: string) {
    const c = clock();
    let n = 0;
    const prepare = vi.fn(async (holder: string) => ({
      record: { operationId: `op-${++n}`, originId: `o-${n}`, originMachineId: 'standby', executionOwnerMachineId: holder, producerKind } as never,
      admission: { operationId: `op-${n}` } as never,
    }) as OriginPreparedBotOperation);
    const submit = vi.fn<(holder: string, op: OriginPreparedBotOperation) => Promise<HolderSubmitResult>>(async () =>
      ({ ok: false, reason: 'origin-peer-unreachable', retryable: true, outcome: 'not-accepted' } as HolderSubmitResult));
    const notify = vi.fn(async () => true);
    const audit = vi.fn();
    const gate = new HeldNoticeGate({ now: c.now });
    const d: ForwardDeps = { lease: { selfMachineId: 'standby', leaseHolder: () => 'holder', holdsLease: () => false, isHolderHealthy: () => true },
      prepare, submit, hold: vi.fn(async () => undefined), notify, noticeGate: gate, audit, sleep: c.sleep, now: c.now };
    return { d, notify, audit };
  }
  const input = { topicId: 9210, chatId: '-100123', text: 'status line' };

  it('a held background send posts NO notice and reports it suppressed', async () => {
    const { d, notify, audit } = setup('server-automation');
    const out = await forwardReplyToHolder(d, input);
    expect(out).toMatchObject({ kind: 'held', noticeDelivered: false, noticeSuppressed: 'automation' });
    expect(notify).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ phase: 'notice-suppressed', suppressed: 'automation' }));
  });
  it('a held session reply posts the notice once; the second held reply in that topic does not', async () => {
    const { d, notify } = setup('session');
    expect(await forwardReplyToHolder(d, input)).toMatchObject({ kind: 'held', noticeDelivered: true });
    expect(await forwardReplyToHolder(d, input)).toMatchObject({ kind: 'held', noticeDelivered: false, noticeSuppressed: 'already-noticed' });
    expect(notify).toHaveBeenCalledTimes(1);
  });
});

describe('listHeldOperations carries the author kind from the sealed envelope', () => {
  let worker: URL;
  const stores: OriginStore[] = [];
  beforeAll(async () => { worker = await compileOriginWorker(); });
  afterEach(async () => { await Promise.all(stores.splice(0).map(s => s.close())); });

  function withProducer(name: string, producerKind: string | null) {
    const a = admission(name, 1_000);
    const envelope = JSON.parse(a.record.envelopeJson) as Record<string, unknown>;
    if (producerKind) envelope.producerKind = producerKind;
    const envelopeJson = JSON.stringify(envelope);
    return { ...a, record: { ...a.record, envelopeJson, envelopeDigest: hash(envelopeJson) } };
  }

  it('reads session / server-automation, and null when the envelope has none', async () => {
    const store = await OriginStore.open({ stateDir: temporaryState(), agentId: 'echo' }, worker); stores.push(store);
    for (const [name, kind] of [['bg', 'server-automation'], ['reply', 'session'], ['bare', null]] as const) {
      const a = withProducer(name, kind);
      await store.admit(a);
      await store.recordOperationState({ operationId: a.operationId, state: 'held', holdReason: 'lease-not-held', holdDetail: { kind: 'direct-lease-hold' } });
    }
    const byId = Object.fromEntries((await store.listHeldOperations({ holdReason: 'lease-not-held' })).map(r => [r.operationId, r.producerKind]));
    expect(byId).toEqual({ 'operation-bg': 'server-automation', 'operation-reply': 'session', 'operation-bare': null });
  });
});

describe('awareness refresh for installed agents', () => {
  it('rewrites the old delayed-notice sentence once and is idempotent', async () => {
    const { refreshHeldNoticeAwareness, telegramOriginForwardAwareness, HELD_NOTICE_GATED_SENTENCE, HELD_NOTICE_LEGACY_SENTENCE } =
      await import('../../src/messaging/telegram-origin/OriginAwareness.js');
    const legacy = `row ... routed through <holder>" ${HELD_NOTICE_LEGACY_SENTENCE} Recovery re-forwards ...`;
    const once = refreshHeldNoticeAwareness(legacy);
    expect(once).toContain(HELD_NOTICE_GATED_SENTENCE);
    expect(refreshHeldNoticeAwareness(once)).toBe(once);
    // The shipped row already carries the gated wording, so a fresh install is untouched.
    const fresh = telegramOriginForwardAwareness(4040);
    expect(fresh).toContain(HELD_NOTICE_GATED_SENTENCE);
    expect(refreshHeldNoticeAwareness(fresh)).toBe(fresh);
    expect(refreshHeldNoticeAwareness('no such row')).toBe('no such row');
  });
});
