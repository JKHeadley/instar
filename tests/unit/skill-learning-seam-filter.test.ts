// safe-fs-allow: test fixture cleanup uses SafeFsExecutor.
/**
 * Skill Learning Sentinel — SeamFilter (Tier 1). Spec §3.1 with the design corrections: the Telegram
 * filter is `fromUser && !forwarded && telegramUserId === TopicOperatorStore.getOperator(topicId)?.uid`;
 * Slack rows come only from the live adapter chain, admin-matched, `identity: 'asserted'`; every drop
 * reason is counted; message text is never stored; catch-up rows are support-only; the hook chain still
 * calls the prior links when the sentinel link throws.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { Ledger } from '../../src/monitoring/skillLearning/Ledger.js';
import {
  SeamFilter, attachSkillLearningSeams, installSkillLearningSeamFilter, skillLearningUnlinkedMessages,
  skillLearningTelegramLink, skillLearningSlackLink, skillLearningLinkErrors,
  type SeamEvent, type SeamFilterDeps, type TelegramLoggedEntry,
} from '../../src/monitoring/skillLearning/SeamFilter.js';
import type { LogEntry } from '../../src/messaging/shared/MessageLogger.js';

const OPERATOR_UID = '555001';
let stateDir: string;
let ledger: Ledger;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skl-seam-'));
  ledger = new Ledger({ stateDir, machineId: 'm_alpha' });
  ledger.startSync();
});
afterEach(() => {
  ledger.close();
  installSkillLearningSeamFilter(null);
  SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'tests/unit/skill-learning-seam-filter.test.ts' });
});

function makeFilter(over: Partial<SeamFilterDeps> = {}, events: SeamEvent[] = []): SeamFilter {
  return new SeamFilter({
    ledger,
    machineId: 'm_alpha',
    operatorUidForTopic: (topicId) => (String(topicId) === '7' ? OPERATOR_UID : null),
    slackAdminUser: (uid) => uid === 'U_ADMIN',
    slackTopicId: (channelId) => `9${channelId.length}`,
    hasOutstandingConfirmation: (topicId) => topicId === '8',
    detector: { classify: (text) => (/\bthat'?s wrong\b/i.test(text) ? { category: 'factual-correction' } : null) },
    onEvent: (e) => events.push(e),
    ...over,
  });
}

let mid = 100;
function tg(over: Partial<TelegramLoggedEntry> = {}): TelegramLoggedEntry {
  mid += 1;
  return {
    messageId: mid, topicId: 7, text: 'please run the weekly CI health report', fromUser: true,
    timestamp: new Date(Date.UTC(2026, 10, 6, 12, 0, mid % 60)).toISOString(), sessionName: 'echo-7', telegramUserId: Number(OPERATOR_UID), forwarded: false, ...over,
  };
}
function slack(over: Partial<LogEntry> = {}): LogEntry {
  mid += 1;
  return {
    messageId: `17${mid}.000100`, channelId: 'C123', text: 'post the deploy summary', fromUser: true,
    timestamp: new Date(Date.UTC(2026, 10, 6, 12, 1, mid % 60)).toISOString(), sessionName: 'echo-slack', platformUserId: 'U_ADMIN', platform: 'slack', forwarded: false, ...over,
  };
}

describe('SeamFilter — Telegram structural filter', () => {
  it('admits a verified operator message as a pending request row with a run and the detector category; the ledger holds the SOURCE, never the text', () => {
    const events: SeamEvent[] = [];
    const f = makeFilter({}, events);
    const row = f.observeTelegram(tg({ text: "that's wrong, the report should cover last week" }));
    expect(row).toMatchObject({ kind: 'request', identity: 'verified', state: 'pending', topicId: '7', channel: 'telegram', detectorCategory: 'factual-correction', sessionName: 'echo-7' });
    expect(row?.runId).toMatch(/^run-/);
    expect(row?.source).toEqual({ channel: 'telegram', chatId: '7', messageId: String(mid) });
    const raw = fs.readFileSync(ledger.segmentPath(0), 'utf-8');
    expect(raw).not.toContain('report should cover');
    expect(raw).not.toContain('"text"');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'request', topicId: '7' });
    expect(f.counters()).toMatchObject({ observed: 1, appended: 1, 'not-user': 0, forwarded: 0, 'not-operator': 0, 'confirmation-reply': 0 });
  });

  it('counts every drop reason: not-user (and forwards it as a reply event), forwarded, not-operator (no binding / wrong uid / no uid), confirmation-reply', () => {
    const events: SeamEvent[] = [];
    const f = makeFilter({}, events);
    expect(f.observeTelegram(tg({ fromUser: false }))).toBeNull();
    expect(f.observeTelegram(tg({ forwarded: true }))).toBeNull();
    expect(f.observeTelegram(tg({ topicId: 12 }))).toBeNull(); // no verified binding on topic 12
    expect(f.observeTelegram(tg({ telegramUserId: 999 }))).toBeNull(); // wrong sender
    expect(f.observeTelegram(tg({ telegramUserId: undefined }))).toBeNull(); // unknown sender
    expect(f.observeTelegram(tg({ topicId: 8, telegramUserId: undefined }))).toBeNull(); // not-operator wins before confirmation on topic 8 (no binding)
    const c = f.counters();
    expect(c['not-user']).toBe(1);
    expect(c.forwarded).toBe(1);
    expect(c['not-operator']).toBe(4);
    expect(c.appended).toBe(0);
    expect(events).toEqual([expect.objectContaining({ kind: 'reply', topicId: '7' })]);
    expect(ledger.pendingCount()).toBe(0);
  });

  it('drops a reply to an outstanding PendingConfirmation (confirmation-reply) from a verified operator', () => {
    const f = makeFilter({ operatorUidForTopic: () => OPERATOR_UID });
    expect(f.observeTelegram(tg({ topicId: 8, text: 'yes' }))).toBeNull();
    expect(f.counters()['confirmation-reply']).toBe(1);
    expect(f.observeTelegram(tg({ topicId: 7, text: 'yes' }))).not.toBeNull();
    expect(f.filtered()).toEqual({ 'not-user': 0, forwarded: 0, 'not-operator': 0, 'confirmation-reply': 1, 'slack-asserted': 0 });
  });

  it('a message without a topic is ignored entirely (no counter, no row)', () => {
    const f = makeFilter();
    expect(f.observeTelegram(tg({ topicId: null }))).toBeNull();
    expect(f.counters().observed).toBe(0);
  });

  it('a detector that throws never blocks admission', () => {
    const f = makeFilter({ detector: { classify: () => { throw new Error('boom'); } } });
    expect(f.observeTelegram(tg())?.detectorCategory).toBeUndefined();
    expect(ledger.pendingCount()).toBe(1);
  });
});

describe('SeamFilter — Slack (support-only, asserted)', () => {
  it('keeps an admin-matched Slack message as identity asserted, counted slack-asserted, under the synthetic topic id', () => {
    const f = makeFilter();
    const row = f.observeSlack(slack());
    expect(row).toMatchObject({ identity: 'asserted', channel: 'slack', topicId: '94', state: 'pending' });
    expect(row?.source).toEqual({ channel: 'slack', chatId: 'C123', messageId: `17${mid}.000100` });
    expect(f.counters()['slack-asserted']).toBe(1);
  });

  it('drops a Slack sender that is not an admin profile, a missing user id, or when no resolver is wired', () => {
    const f = makeFilter();
    expect(f.observeSlack(slack({ platformUserId: 'U_GUEST' }))).toBeNull();
    expect(f.observeSlack(slack({ platformUserId: undefined }))).toBeNull();
    expect(f.counters()['not-operator']).toBe(2);
    const noResolver = makeFilter({ slackAdminUser: undefined });
    expect(noResolver.observeSlack(slack())).toBeNull();
    expect(noResolver.counters()['not-operator']).toBe(1);
  });

  it('a Slack agent line is a reply event; a forwarded Slack line is dropped', () => {
    const events: SeamEvent[] = [];
    const f = makeFilter({}, events);
    expect(f.observeSlack(slack({ fromUser: false }))).toBeNull();
    expect(f.observeSlack(slack({ forwarded: true }))).toBeNull();
    expect(events).toEqual([expect.objectContaining({ kind: 'reply', channel: 'slack', topicId: '94' })]);
    expect(f.counters()).toMatchObject({ 'not-user': 1, forwarded: 1 });
  });
});

describe('SeamFilter — TopicMemory catch-up', () => {
  it('admits missed BOUND-operator rows as unverified-catchup: no run, no request event, deduped against the ledger, watermark advanced', () => {
    const events: SeamEvent[] = [];
    const uid = Number(OPERATOR_UID);
    const seen = { messageId: 501, topicId: 7, text: 'already observed live', fromUser: true, timestamp: '2026-11-06T10:00:00.000Z', sessionName: 'echo-7', forwarded: false, telegramUserId: uid };
    const missed = { messageId: 502, topicId: 7, text: 'run the CI report again', fromUser: true, timestamp: '2026-11-06T10:05:00.000Z', sessionName: 'echo-7', telegramUserId: uid };
    const agent = { messageId: 503, topicId: 7, text: 'done', fromUser: false, timestamp: '2026-11-06T10:06:00.000Z', sessionName: 'echo-7' };
    const fwd = { messageId: 504, topicId: 7, text: 'fwd', fromUser: true, timestamp: '2026-11-06T10:07:00.000Z', sessionName: 'echo-7', forwarded: true, telegramUserId: uid };
    const f = makeFilter({ topicMemory: { getMessagesSince: () => ({ messages: [seen, missed, agent, fwd], complete: true }) } }, events);
    f.observeTelegram(tg({ messageId: 501, timestamp: seen.timestamp }));
    const before = f.counters();
    const r = f.catchUp(7, '2026-11-06T09:00:00.000Z');
    expect(r).toEqual({ admitted: 1, complete: true });
    const row = ledger.requestBySource({ channel: 'telegram', chatId: '7', messageId: '502' });
    expect(row).toMatchObject({ identity: 'unverified-catchup', state: 'pending' });
    expect(row?.runId).toBeUndefined();
    expect(events.filter((e) => e.kind === 'request')).toHaveLength(1); // only the live row opened a run
    expect(events.filter((e) => e.kind === 'reply')).toHaveLength(0); // catch-up never replays reply events
    const after = f.counters();
    expect(after.catchup).toBe(1);
    expect(after['not-user'] - before['not-user']).toBe(1); // the agent line
    expect(after.forwarded - before.forwarded).toBe(1);
    expect(f.catchUpWatermarks()).toEqual({ '7': '2026-11-06T10:07:00.000Z' });
    expect(ledger.openRuns().map((x) => x.source.messageId)).toEqual(['501']);
  });

  it('catch-up applies the SAME structural filter as the live link: an unbound sender, a missing uid, or an unbound topic is dropped + counted not-operator and its text never reaches a row; a bound operator is admitted as unverified-catchup', () => {
    const uid = Number(OPERATOR_UID);
    const stranger = { messageId: 601, topicId: 7, text: 'stranger asks: wipe the production db', fromUser: true, timestamp: '2026-11-06T10:01:00.000Z', sessionName: 'echo-7', telegramUserId: 999 };
    const noUid = { messageId: 602, topicId: 7, text: 'legacy row with no sender id', fromUser: true, timestamp: '2026-11-06T10:02:00.000Z', sessionName: 'echo-7' };
    const bound = { messageId: 603, topicId: 7, text: 'run the CI report', fromUser: true, timestamp: '2026-11-06T10:03:00.000Z', sessionName: 'echo-7', telegramUserId: uid };
    const f = makeFilter({ topicMemory: { getMessagesSince: () => ({ messages: [stranger, noUid, bound], complete: true }) } });
    expect(f.catchUp(7, '2026-11-06T09:00:00.000Z')).toEqual({ admitted: 1, complete: true });
    expect(f.counters()).toMatchObject({ 'not-operator': 2, catchup: 1, appended: 1 });
    expect(ledger.requestBySource({ channel: 'telegram', chatId: '7', messageId: '601' })).toBeNull();
    expect(ledger.requestBySource({ channel: 'telegram', chatId: '7', messageId: '602' })).toBeNull();
    expect(ledger.requestBySource({ channel: 'telegram', chatId: '7', messageId: '603' })).toMatchObject({ identity: 'unverified-catchup' });
    expect(ledger.pendingCount()).toBe(1);
    // A topic with no verified binding admits nothing, even from a sender who is the operator elsewhere.
    const unboundTopic = makeFilter({ topicMemory: { getMessagesSince: () => ({ messages: [{ ...bound, messageId: 604, topicId: 12 }], complete: true }) } });
    expect(unboundTopic.catchUp(12, '2026-11-06T09:00:00.000Z')).toEqual({ admitted: 0, complete: true });
    expect(unboundTopic.counters()['not-operator']).toBe(1);
  });

  it('without a TopicMemory the catch-up is an honest no-op (complete:false)', () => {
    expect(makeFilter().catchUp(7, '2026-11-06T09:00:00.000Z')).toEqual({ admitted: 0, complete: false });
  });
});

describe('attachSkillLearningSeams — hook chain', () => {
  it('calls the prior link first, then the sentinel link; a throw inside the sentinel is caught + counted and the prior link still ran', () => {
    const order: string[] = [];
    const telegram = { onMessageLogged: ((e: TelegramLoggedEntry) => { order.push(`prior:${e.messageId}`); }) as ((e: TelegramLoggedEntry) => void) | null };
    const slackAdapter = { onMessageLogged: ((e: LogEntry) => { order.push(`prior-slack:${e.messageId}`); }) as ((e: LogEntry) => void) | null };
    const throwing = { observeTelegram: () => { throw new Error('sentinel exploded'); }, observeSlack: () => { throw new Error('sentinel exploded'); } } as unknown as SeamFilter;
    const attached = attachSkillLearningSeams({ telegram, slack: slackAdapter, filter: throwing });
    expect(attached).toMatchObject({ telegram: true, slack: true });
    expect(() => telegram.onMessageLogged!(tg({ messageId: 1 }))).not.toThrow();
    expect(() => slackAdapter.onMessageLogged!(slack({ messageId: 's1' }))).not.toThrow();
    expect(order).toEqual(['prior:1', 'prior-slack:s1']);
    expect(attached.errors()).toBe(2);
  });

  it('with no prior link the sentinel link alone runs; a later link chained after ours still sees every message', () => {
    const events: SeamEvent[] = [];
    const f = makeFilter({}, events);
    const telegram = { onMessageLogged: null as ((e: TelegramLoggedEntry) => void) | null };
    attachSkillLearningSeams({ telegram, filter: f });
    const later: number[] = [];
    const before = telegram.onMessageLogged;
    telegram.onMessageLogged = (e) => { before?.(e); later.push(e.messageId); };
    telegram.onMessageLogged(tg({ messageId: 77 }));
    expect(later).toEqual([77]);
    expect(f.counters().appended).toBe(1);
  });

  it('resolves the installed filter per message: nothing installed ⇒ counted no-op; installed later ⇒ live at once', () => {
    const telegram = { onMessageLogged: null as ((e: TelegramLoggedEntry) => void) | null };
    attachSkillLearningSeams({ telegram });
    const unlinkedBefore = skillLearningUnlinkedMessages();
    telegram.onMessageLogged!(tg());
    expect(skillLearningUnlinkedMessages()).toBe(unlinkedBefore + 1);
    expect(ledger.pendingCount()).toBe(0);
    const f = makeFilter();
    installSkillLearningSeamFilter(f);
    telegram.onMessageLogged!(tg());
    expect(ledger.pendingCount()).toBe(1);
    expect(f.counters().appended).toBe(1);
  });
});

describe('server links — skillLearningTelegramLink / skillLearningSlackLink (called inside the adapters\' existing callbacks)', () => {
  it('is a no-op while the kill switch is off or no filter is installed; live once both hold', () => {
    const f = makeFilter();
    const unlinkedBefore = skillLearningUnlinkedMessages();
    skillLearningTelegramLink(tg(), false);
    skillLearningTelegramLink(tg(), undefined);
    expect(skillLearningUnlinkedMessages()).toBe(unlinkedBefore); // switched off ⇒ not even counted as unlinked
    skillLearningTelegramLink(tg(), true);
    expect(skillLearningUnlinkedMessages()).toBe(unlinkedBefore + 1); // on, but nothing installed ⇒ counted
    installSkillLearningSeamFilter(f);
    skillLearningTelegramLink(tg(), true);
    skillLearningSlackLink(slack(), true);
    expect(f.counters()).toMatchObject({ appended: 2, 'slack-asserted': 1 });
    expect(ledger.pendingCount()).toBe(2);
  });

  it('a throw inside the installed filter is caught + counted, never propagated to the adapter callback', () => {
    const errorsBefore = skillLearningLinkErrors();
    installSkillLearningSeamFilter({ observeTelegram: () => { throw new Error('boom'); }, observeSlack: () => { throw new Error('boom'); } } as unknown as SeamFilter);
    expect(() => skillLearningTelegramLink(tg(), true)).not.toThrow();
    expect(() => skillLearningSlackLink(slack(), true)).not.toThrow();
    expect(skillLearningLinkErrors()).toBe(errorsBefore + 2);
  });
});
