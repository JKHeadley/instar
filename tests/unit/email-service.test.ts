/**
 * docs/specs/backup-email-sending.md — the email sender end to end against stand-in transports: the outbox
 * transition table (every row), both fallback deadlines, the credential breaker, the budget and the provider's
 * 429, the lease checks at enqueue and fire time, restart and handoff recovery, the relay queue, the 24-hour
 * fallback breaker and its resume, the drain, the credential guard, the fallback-line cadence, and the proof mail
 * with its per-shape rules.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { EmailOutbox } from '../../src/email/EmailOutbox.js';
import { EmailOptInStore } from '../../src/email/emailOptIn.js';
import { EmailService, FALLBACK_BREAKER_MS } from '../../src/email/EmailService.js';
import type { EmailTransport, OutboundEmail } from '../../src/email/transports.js';
import type { Delivery, EmailFixedReason, TransportResult } from '../../src/email/emailCore.js';

const OWNER = 'owner@example.com';
const RESEND = JSON.stringify({ shape: 'A', transport: 'resend', secret: 're_k' });
const GMAIL_B = JSON.stringify({ shape: 'B', transport: 'smtp', preset: 'gmail', username: OWNER, secret: 'pw' });
const ICLOUD_C = JSON.stringify({ shape: 'C', transport: 'smtp', preset: 'icloud', username: 'agent@icloud.com', secret: 'pw' });

interface FakeT {
  kind: 'resend' | 'smtp';
  sends: OutboundEmail[];
  next: TransportResult | (() => TransportResult | Promise<TransportResult>);
  statusAnswer: { delivery: Delivery; reason: EmailFixedReason } | 'pending' | null;
  verifyAnswer: 'pass' | 'fail' | 'unknown';
}

let dir: string;
let secrets: Record<string, string>;
let grant: boolean;
let lease: boolean;
let enabled: boolean;
let topicOk: boolean;
let topicSends: Array<{ id: string; text: string }>;
let relay: Array<{ id: string; text: string }> | null;
let ft: FakeT;
let refusedCalls: number;
let reserve: number;

function transportFor(): EmailTransport {
  return {
    kind: ft.kind,
    recipient: OWNER,
    send: async (m) => { ft.sends.push(m); return typeof ft.next === 'function' ? ft.next() : ft.next; },
    ...(ft.kind === 'resend' ? { status: async () => ft.statusAnswer } : {}),
    verify: async () => ({ result: ft.verifyAnswer, reason: ft.verifyAnswer === 'fail' ? 'credential-refused' : 'ok', detail: ft.verifyAnswer }),
  } as EmailTransport;
}

function build(machineId = 'm_a') {
  const outbox = new EmailOutbox({ stateDir: dir, machineId, now: () => Date.now() });
  const optIn = new EmailOptInStore({ stateDir: dir, machineId, macKey: 'k', now: () => Date.now() });
  const service = new EmailService({
    outbox, optIn, stateDir: dir, machineId, recipientKey: 'k', agentName: 'Echo',
    readSecret: (n) => secrets[n] ?? null,
    enabled: () => enabled, hasGrant: () => grant, holdsLease: () => lease,
    detectCredential: (t) => /sk-ant-[A-Za-z0-9]{20,}/.test(t),
    deliverToTopic: async (row, text) => { if (!topicOk) return { ok: false }; topicSends.push({ id: row.id, text }); return { ok: true, messageId: topicSends.length }; },
    relayEnqueue: relay ? (row, relayId, text) => { if (relay!.some((r) => r.id === relayId)) return false; relay!.push({ id: relayId, text }); return true; } : undefined,
    reservedForReports: () => reserve,
    timezone: () => 'UTC',
    onCredentialRefused: () => { refusedCalls++; },
    transportFor,
    now: () => Date.now(),
  });
  return { outbox, optIn, service };
}

/** Marks the current version proven: delivered (A) or accepted (B/C), with the code where the shape needs one. */
function prove(s: ReturnType<typeof build>, delivery: Delivery = 'delivered') {
  s.optIn.recordProof(s.service.version()!, { result: 'pass', at: Date.now(), delivery });
  const rh = s.service.recipientHashOf(OWNER);
  const { code } = s.optIn.mint(rh);
  s.optIn.check(rh, code);
}

const submitReport = (s: ReturnType<typeof build>, id = 'em-run-00000001', extra: Partial<Parameters<EmailService['submit']>[0]> = {}) =>
  s.service.submit({ id, kind: 'report', subject: 'Daily: Done', ownerText: 'the full owner report', topicText: 'topic copy', fallbackTopicId: 9, ...extra });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse('2026-11-08T12:00:00Z'));
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'email-svc-'));
  secrets = { email_sending: RESEND, email_recipient: OWNER };
  grant = true; lease = true; enabled = true; topicOk = true; relay = null; refusedCalls = 0; reserve = 0;
  topicSends = [];
  ft = { kind: 'resend', sends: [], next: { outcome: 'accepted', providerId: 'msg_1', reason: 'ok' }, statusAnswer: 'pending', verifyAnswer: 'pass' };
});
afterEach(() => {
  vi.useRealTimers();
  SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/email-service.test.ts' });
});

describe('the happy paths', () => {
  it('Resend: pending → sent → delivered, one attempt, the row id as idempotency key, the budget reserved, owner text gone', async () => {
    const s = build(); prove(s);
    expect(submitReport(s)).toEqual({ ok: true, id: 'em-run-00000001', status: 'pending' });
    await s.service.idle();
    expect(ft.sends).toHaveLength(1);
    expect(ft.sends[0]).toMatchObject({ to: OWNER, subject: 'Echo: Daily: Done', text: 'the full owner report', idempotencyKey: 'em-run-00000001' });
    expect(s.outbox.get('em-run-00000001')).toMatchObject({ status: 'sent', attempts: 1, providerId: 'msg_1' });
    expect(s.outbox.budget('2026-11-08')).toEqual({ day: '2026-11-08', attempts: 1 });
    ft.statusAnswer = { delivery: 'delivered', reason: 'ok' };
    await vi.advanceTimersByTimeAsync(5_000);
    expect(s.outbox.get('em-run-00000001')?.status).toBe('delivered');
    expect(s.outbox.readOwnerText('em-run-00000001')).toBeNull();
    expect(topicSends).toHaveLength(0);
  });
  it('SMTP: a 250 is accepted, terminal, and never upgraded or fallen back', async () => {
    secrets.email_sending = GMAIL_B; ft.kind = 'smtp'; ft.next = { outcome: 'accepted', reason: 'ok' };
    const s = build(); prove(s, 'accepted-unproven');
    submitReport(s);
    await s.service.idle();
    expect(s.outbox.get('em-run-00000001')?.status).toBe('accepted');
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(topicSends).toHaveLength(0);
  });
  it('a repeated id answers the existing row and sends nothing more', async () => {
    const s = build(); prove(s);
    submitReport(s);
    await s.service.idle();
    expect(submitReport(s)).toMatchObject({ ok: true, status: 'sent' });
    await s.service.idle();
    expect(ft.sends).toHaveLength(1);
  });
});

describe('fallback', () => {
  it('an explicit refusal falls back to the topic within 120 s, with one plain line', async () => {
    ft.next = { outcome: 'refused', reason: 'provider-error' };
    const s = build(); prove(s);
    submitReport(s);
    await s.service.idle();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(s.outbox.get('em-run-00000001')).toMatchObject({ status: 'fallen-back', messageId: '1' });
    expect(topicSends[0].text).toBe('topic copy\n\nThe email didn’t go through, so here it is instead.');
  });
  it('a transport unknown (a timeout) falls back within 120 s and says why there may be two copies', async () => {
    ft.next = { outcome: 'unknown', reason: 'timeout' };
    const s = build(); prove(s);
    submitReport(s);
    await s.service.idle();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(s.outbox.get('em-run-00000001')?.status).toBe('fallen-back');
    expect(topicSends[0].text).toMatch(/couldn’t be sure the email arrived/);
  });
  it('a sent message still unknown at the end of its 30-minute window falls back then, not before', async () => {
    const s = build(); prove(s);
    submitReport(s);
    await s.service.idle();
    await vi.advanceTimersByTimeAsync(29 * 60_000);
    expect(s.outbox.get('em-run-00000001')?.status).toBe('sent');
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(s.outbox.get('em-run-00000001')).toMatchObject({ status: 'fallen-back', reason: 'status-window-ended' });
  });
  it('a bounce falls back', async () => {
    const s = build(); prove(s);
    submitReport(s);
    await s.service.idle();
    ft.statusAnswer = { delivery: 'failed', reason: 'bounced' };
    await vi.advanceTimersByTimeAsync(6_000);
    expect(s.outbox.get('em-run-00000001')).toMatchObject({ status: 'fallen-back', reason: 'bounced' });
  });
  it('email not set up, or not set up on this machine, falls back with its own line', async () => {
    delete secrets.email_sending;
    const s = build();
    submitReport(s);
    await vi.advanceTimersByTimeAsync(1000);
    expect(topicSends[0].text).toMatch(/email isn’t set up, so/);
    secrets.email_sending = RESEND; grant = false;
    submitReport(s, 'em-run-00000002');
    await vi.advanceTimersByTimeAsync(1000);
    expect(topicSends[1].text).toMatch(/machine sending it/);
    expect(ft.sends).toHaveLength(0);
  });
  it('unproven email (no code yet) never sends', async () => {
    const s = build();
    s.optIn.recordProof(s.service.version()!, { result: 'pass', at: Date.now(), delivery: 'delivered' });
    submitReport(s);
    await vi.advanceTimersByTimeAsync(1000);
    expect(ft.sends).toHaveLength(0);
    expect(topicSends[0].text).toMatch(/isn’t confirmed working yet/);
  });
  it('the line is said once a day per cause and reason, and re-armed when the reason changes', async () => {
    ft.next = { outcome: 'refused', reason: 'provider-error' };
    const s = build(); prove(s);
    submitReport(s, 'em-run-00000001');
    await s.service.idle(); await vi.advanceTimersByTimeAsync(1000);
    submitReport(s, 'em-run-00000002');
    await s.service.idle(); await vi.advanceTimersByTimeAsync(1000);
    expect(topicSends[1].text).toBe('topic copy');
    ft.next = { outcome: 'refused', reason: 'provider-rate-limited' };
    submitReport(s, 'em-run-00000003');
    await s.service.idle(); await vi.advanceTimersByTimeAsync(1000);
    expect(topicSends[2].text).toMatch(/limit/);
  });
  it('a failed direct send goes to the relay queue (relay-queued, not terminal), and the sentinel’s delivery ends it', async () => {
    ft.next = { outcome: 'refused', reason: 'provider-error' };
    relay = [];
    topicOk = false;
    const s = build(); prove(s);
    submitReport(s);
    await s.service.idle(); await vi.advanceTimersByTimeAsync(1000);
    expect(s.outbox.get('em-run-00000001')).toMatchObject({ status: 'relay-queued', relayId: 'em-run-00000001-r1' });
    expect(relay[0].id).toBe('em-run-00000001-r1');
    s.service.relayDelivered('em-run-00000001');
    expect(s.outbox.get('em-run-00000001')?.status).toBe('relay-queued');
    s.service.relayDelivered('em-run-00000001-r1');
    expect(s.outbox.get('em-run-00000001')?.status).toBe('fallen-back');
  });
  it('with Telegram and the relay down it retries 1, 2, 4, 8, 15 minutes, stops after a day, and a reconnect resumes it', async () => {
    ft.next = { outcome: 'refused', reason: 'provider-error' };
    topicOk = false;
    const s = build(); prove(s);
    submitReport(s);
    await s.service.idle(); await vi.advanceTimersByTimeAsync(100);
    expect(s.outbox.get('em-run-00000001')?.fallbackTries).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(s.outbox.get('em-run-00000001')?.fallbackTries).toBe(2);
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(s.outbox.get('em-run-00000001')?.fallbackTries).toBe(3);
    await vi.advanceTimersByTimeAsync(FALLBACK_BREAKER_MS + 60 * 60_000);
    const tries = s.outbox.get('em-run-00000001')!.fallbackTries!;
    expect(tries).toBeGreaterThan(90);
    expect(tries).toBeLessThan(110);
    await vi.advanceTimersByTimeAsync(6 * 60 * 60_000);
    expect(s.outbox.get('em-run-00000001')!.fallbackTries).toBe(tries);
    expect(s.outbox.get('em-run-00000001')?.status).toBe('falling-back');
    topicOk = true;
    s.service.resume();
    await vi.advanceTimersByTimeAsync(100);
    expect(s.outbox.get('em-run-00000001')?.status).toBe('fallen-back');
  });
});

describe('breaker, budget and the provider’s refusals', () => {
  it('one credential refusal stops sends until a verify passes, and asks for the re-check', async () => {
    ft.next = { outcome: 'refused', reason: 'credential-refused' };
    const s = build(); prove(s);
    submitReport(s);
    await s.service.idle();
    expect(s.service.breakerOpen()).toBe(true);
    expect(refusedCalls).toBe(1);
    ft.next = { outcome: 'accepted', providerId: 'msg_2', reason: 'ok' };
    submitReport(s, 'em-run-00000002');
    await s.service.idle();
    expect(ft.sends).toHaveLength(1);
    expect(s.outbox.get('em-run-00000002')?.reason).toBe('breaker-open');
    expect((await s.service.verifyCredential()).result).toBe('pass');
    expect(s.service.breakerOpen()).toBe(false);
    submitReport(s, 'em-run-00000003');
    await s.service.idle();
    expect(ft.sends).toHaveLength(2);
  });
  it('the provider’s 429 is the hard cap: exhausted for the rest of the day', async () => {
    ft.next = { outcome: 'refused', reason: 'provider-rate-limited' };
    const s = build(); prove(s);
    submitReport(s);
    await s.service.idle();
    ft.next = { outcome: 'accepted', providerId: 'msg_2', reason: 'ok' };
    submitReport(s, 'em-run-00000002');
    await s.service.idle();
    expect(ft.sends).toHaveLength(1);
    expect(s.outbox.get('em-run-00000002')?.reason).toBe('budget-exhausted');
    expect(s.service.breakerOpen()).toBe(false);
  });
  it('the recipient-restriction 403 is not a credential refusal: no breaker, the row goes unproven', async () => {
    ft.next = { outcome: 'refused', reason: 'provider-recipient-refused' };
    const s = build(); prove(s);
    submitReport(s);
    await s.service.idle();
    expect(s.service.breakerOpen()).toBe(false);
    expect(s.service.readiness().state).toBe('unproven');
  });
  it('the local reservation never exceeds the cap on one holder; one-offs leave the reports’ reserve', async () => {
    const s = build(); prove(s);
    for (let i = 0; i < 97; i++) s.outbox.reserve('2026-11-08');
    reserve = 3;
    s.service.submit({ id: 'em-oneoff-0001', kind: 'one-off', subject: 's', ownerText: 't', topicText: 't', fallbackTopicId: 9 });
    await s.service.idle();
    expect(ft.sends).toHaveLength(0);
    expect(s.outbox.get('em-oneoff-0001')?.reason).toBe('budget-exhausted');
    submitReport(s);
    await s.service.idle();
    expect(ft.sends).toHaveLength(1);
    for (let i = 0; i < 5; i++) s.outbox.reserve('2026-11-08');
    submitReport(s, 'em-run-00000002');
    await s.service.idle();
    expect(ft.sends).toHaveLength(1);
  });
});

describe('the one voice', () => {
  it('a standby never writes a row: it is told to forward', () => {
    lease = false;
    const s = build(); prove(s);
    expect(submitReport(s)).toEqual({ ok: false, reason: 'forward-required' });
    expect(s.outbox.rows()).toHaveLength(0);
  });
  it('a lease lost between enqueue and fire leaves the row for the successor', async () => {
    const s = build(); prove(s);
    let calls = 0;
    const real = lease;
    s.service.submit({ id: 'em-run-00000001', kind: 'report', subject: 's', ownerText: 't', topicText: 't', fallbackTopicId: 9 });
    lease = false;
    await s.service.idle();
    expect(ft.sends).toHaveLength(0);
    expect(s.outbox.get('em-run-00000001')).toMatchObject({ status: 'pending', attempts: 0 });
    lease = real; calls++;
    expect(calls).toBe(1);
  });
  it('restart and handoff: an attempted pending row falls back; an unattempted one is sent if this holder has its text', async () => {
    const a = build(); prove(a);
    lease = false;
    a.outbox.admit({ id: 'em-run-attempted', kind: 'report', subjectHash: 'h', textHash: 'h', topicText: 'copy A', statusLine: 'x', fallbackTopicId: 9, ownerText: 'Echo: s\u0000t' });
    a.outbox.update('em-run-attempted', { attempts: 1 });
    a.outbox.admit({ id: 'em-run-fresh0001', kind: 'report', subjectHash: 'h', textHash: 'h', topicText: 'copy B', statusLine: 'x', fallbackTopicId: 9, ownerText: 'Echo: s\u0000t' });
    lease = true;
    const b = build();
    b.service.recover();
    await b.service.idle(); await vi.advanceTimersByTimeAsync(1000);
    expect(b.outbox.get('em-run-attempted')?.status).toBe('fallen-back');
    expect(b.outbox.get('em-run-fresh0001')?.status).toBe('sent');
    expect(ft.sends).toHaveLength(1);
  });
  it('a successor without the owner text falls back with the topic copy', async () => {
    const peerDir = dir;
    const a = build('m_a'); prove(a);
    a.outbox.admit({ id: 'em-run-handoff01', kind: 'report', subjectHash: 'h', textHash: 'h', topicText: 'copy', statusLine: 'x', fallbackTopicId: 9, ownerText: 'Echo: s\u0000t' });
    a.outbox.deleteOwnerText('em-run-handoff01');
    const b = build('m_b');
    b.service.recover();
    await vi.advanceTimersByTimeAsync(1000);
    expect(b.outbox.get('em-run-handoff01')?.status).toBe('fallen-back');
    expect(topicSends[0].text.startsWith('copy')).toBe(true);
    expect(peerDir).toBe(dir);
  });
  it('a handoff with a sent row resumes polling for the rest of the absolute window', async () => {
    const a = build(); prove(a);
    submitReport(a);
    await a.service.idle();
    a.service.stop();
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    const b = build();
    b.service.recover();
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    expect(b.outbox.get('em-run-00000001')?.status).toBe('sent');
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(b.outbox.get('em-run-00000001')?.status).toBe('fallen-back');
  });
  it('a copy another machine queued in its relay is sent by the successor itself', async () => {
    const a = build('m_a'); prove(a);
    a.outbox.admit({ id: 'em-run-relayed01', kind: 'report', subjectHash: 'h', textHash: 'h', topicText: 'copy', statusLine: 'x', fallbackTopicId: 9 });
    a.outbox.update('em-run-relayed01', { status: 'relay-queued', relayId: 'em-run-relayed01' });
    const b = build('m_b');
    b.service.recover();
    await vi.advanceTimersByTimeAsync(1000);
    expect(b.outbox.get('em-run-relayed01')?.status).toBe('fallen-back');
  });
});

describe('review fixes', () => {
  it('a queued copy the relay sentinel gave up on goes back to falling-back and is sent again', async () => {
    ft.next = { outcome: 'refused', reason: 'provider-error' };
    relay = []; topicOk = false;
    const s = build(); prove(s);
    submitReport(s);
    await s.service.idle(); await vi.advanceTimersByTimeAsync(1000);
    expect(s.outbox.get('em-run-00000001')?.status).toBe('relay-queued');
    // Given up while Telegram is still down: a NEW relay entry, never the ignored old id.
    s.service.relayFailed('em-run-00000001-r1');
    expect(s.outbox.get('em-run-00000001')?.status).toBe('falling-back');
    await vi.advanceTimersByTimeAsync(61_000);
    expect(s.outbox.get('em-run-00000001')).toMatchObject({ status: 'relay-queued', relayId: 'em-run-00000001-r2' });
    topicOk = true;
    s.service.relayFailed('em-run-00000001-r2');
    await vi.advanceTimersByTimeAsync(61_000);
    expect(s.outbox.get('em-run-00000001')?.status).toBe('fallen-back');
  });
  it('rows retired from the relay queue by topic go back to falling-back', async () => {
    const s = build(); prove(s);
    s.outbox.admit({ id: 'em-run-retired01', kind: 'report', subjectHash: 'h', textHash: 'h', topicText: 'c', statusLine: 's', fallbackTopicId: 9 });
    s.outbox.update('em-run-retired01', { status: 'relay-queued', relayId: 'em-run-retired01-r1' });
    s.service.relayRetiredForTopics([8]);
    expect(s.outbox.get('em-run-retired01')?.status).toBe('relay-queued');
    s.service.relayRetiredForTopics([9]);
    expect(s.outbox.get('em-run-retired01')?.status).toBe('falling-back');
  });
  it('a stored address that is not the one the yes recorded never sends', async () => {
    const s = build(); prove(s);
    const svc = new EmailService({ ...(s.service as unknown as { deps: ConstructorParameters<typeof EmailService>[0] }).deps, grantRecipientHash: () => 'f'.repeat(64) });
    expect(svc.readiness().state).toBe('unproven');
    const ok = new EmailService({ ...(s.service as unknown as { deps: ConstructorParameters<typeof EmailService>[0] }).deps, grantRecipientHash: () => s.service.recipientHashOf(OWNER) });
    expect(ok.readiness().state).toBe('working');
  });
  it('a report holding a live secret replicates only its status line', async () => {
    const s = build(); prove(s);
    submitReport(s, 'em-run-secret001', { ownerText: `sk-ant-${'b'.repeat(30)}`, topicText: `report sk-ant-${'b'.repeat(30)}` });
    expect(s.outbox.get('em-run-secret001')?.topicText).toBe('Echo: Daily: Done');
  });
  it('the reconciliation floor is recorded once and kept', () => {
    const s = build();
    const first = s.service.wiredSince();
    vi.advanceTimersByTime(60_000);
    expect(build().service.wiredSince()).toBe(first);
  });
});

describe('the hourly checkpoint', () => {
  it('is paced at ten records a second and re-queues an emit the journal dropped', async () => {
    const emitted: string[] = [];
    let refuseOnce = false;
    const outbox = new EmailOutbox({ stateDir: dir, machineId: 'm_a', now: () => Date.now(), emit: (r) => {
      if (refuseOnce && r.recordKey === 'em-live-00000003') { refuseOnce = false; return false; }
      emitted.push(r.recordKey); return true;
    } });
    for (let i = 0; i < 25; i++) outbox.admit({ id: `em-live-${String(i).padStart(8, '0')}`, kind: 'report', subjectHash: 'h', textHash: 'h', topicText: 't', statusLine: 's', fallbackTopicId: 9 });
    await vi.advanceTimersByTimeAsync(5_000);
    emitted.length = 0;
    refuseOnce = true;
    const optIn = new EmailOptInStore({ stateDir: dir, machineId: 'm_a', macKey: 'k' });
    const svc = new EmailService({ outbox, optIn, stateDir: dir, machineId: 'm_a', recipientKey: 'k', agentName: 'Echo', readSecret: () => null,
      enabled: () => true, hasGrant: () => true, holdsLease: () => true, detectCredential: () => false, deliverToTopic: async () => ({ ok: false }), timezone: () => 'UTC' });
    svc.hourly();
    // Ten a second at most; one of them may be the dropped one, re-queued for a later tick.
    expect(emitted.length).toBeGreaterThanOrEqual(9);
    expect(emitted.length).toBeLessThanOrEqual(10);
    await vi.advanceTimersByTimeAsync(1000);
    expect(emitted.length).toBeLessThanOrEqual(20);
    await vi.advanceTimersByTimeAsync(2000);
    expect(new Set(emitted).size).toBe(25);
    expect(emitted).toContain('em-live-00000003');
    svc.stop();
  });
});

describe('the guard, the switch and the drain', () => {
  it('a live secret: a one-off is refused with nothing stored; a report goes to its topic only', async () => {
    const s = build(); prove(s);
    const secret = `sk-ant-${'a'.repeat(30)}`;
    expect(s.service.submit({ id: 'em-oneoff-0002', kind: 'one-off', subject: 's', ownerText: `key ${secret}`, topicText: 't', fallbackTopicId: 9 })).toEqual({ ok: false, reason: 'credential-exposure' });
    expect(s.outbox.rows()).toHaveLength(0);
    submitReport(s, 'em-run-00000001', { ownerText: `key ${secret}` });
    await vi.advanceTimersByTimeAsync(1000);
    expect(ft.sends).toHaveLength(0);
    expect(s.outbox.get('em-run-00000001')).toMatchObject({ status: 'fallen-back', reason: 'credential-exposure' });
    expect(fs.readFileSync(path.join(dir, 'state', 'email-outbox', 'outbox.jsonl'), 'utf8')).not.toContain(secret);
  });
  it('switching off drains: every live row reaches its topic, and with Telegram down they stay for the next start', async () => {
    const s = build(); prove(s);
    submitReport(s, 'em-run-00000001');
    await s.service.idle();
    topicOk = false;
    enabled = false;
    expect(await s.service.drain()).toBe(1);
    expect(s.outbox.get('em-run-00000001')?.status).toBe('falling-back');
    s.service.stop();
    topicOk = true;
    enabled = true;
    const b = build();
    b.service.recover();
    await vi.advanceTimersByTimeAsync(1000);
    expect(b.outbox.get('em-run-00000001')?.status).toBe('fallen-back');
  });
  it('the reconciliation sweep’s row goes straight to the topic', async () => {
    const s = build(); prove(s);
    s.service.submit({ id: 'em-run-reconcile', kind: 'report', subject: 'Daily: Done', ownerText: 'Daily: Done', topicText: 'status line', fallbackTopicId: 9, forceFallback: true });
    await vi.advanceTimersByTimeAsync(1000);
    expect(ft.sends).toHaveLength(0);
    expect(s.outbox.get('em-run-reconcile')?.status).toBe('fallen-back');
  });
});

describe('the proof mail', () => {
  it('shape A: sends a code, waits for delivery and the code, then passes; never re-sends a passing proof', async () => {
    const s = build();
    const first = await s.service.prove();
    expect(first).toMatchObject({ result: 'waiting', awaitingCode: true });
    expect(ft.sends[0].text).toMatch(/Your code is \d{6}/);
    expect(ft.sends[0].subject).toBe('Echo: Your agent can now email you');
    ft.statusAnswer = { delivery: 'delivered', reason: 'ok' };
    expect((await s.service.prove()).result).toBe('waiting');
    expect(s.service.awaitingCode()).toBe(true);
    const code = ft.sends[0].text.match(/(\d{6})/)![1];
    expect(s.service.enterCode(code)).toBe('ok');
    expect(s.service.proven().proven).toBe(true);
    expect((await s.service.prove()).result).toBe('pass');
    expect(ft.sends).toHaveLength(1);
    expect(s.service.readiness().state).toBe('working');
  });
  it('shape B: the mail server’s acceptance is the proof, said as accepted, not delivered; no code', async () => {
    secrets.email_sending = GMAIL_B; ft.kind = 'smtp'; ft.next = { outcome: 'accepted', reason: 'ok' };
    const s = build();
    const r = await s.service.prove();
    expect(r).toMatchObject({ result: 'pass', delivery: 'accepted-unproven' });
    expect(r.detail).toMatch(/accepted, not proven delivered/);
    expect(ft.sends[0].text).not.toMatch(/code/);
    expect(s.service.readiness().state).toBe('working');
  });
  it('shape C: accepted plus the code', async () => {
    secrets.email_sending = ICLOUD_C; ft.kind = 'smtp'; ft.next = { outcome: 'accepted', reason: 'ok' };
    const s = build();
    expect((await s.service.prove()).result).toBe('waiting');
    expect(s.service.readiness().state).toBe('unproven');
    s.service.enterCode(ft.sends[0].text.match(/(\d{6})/)![1]);
    expect(s.service.readiness().state).toBe('working');
  });
  it('a failed proof may be retried ten minutes apart, inside the day’s bound for an unconfirmed address', async () => {
    secrets.email_sending = ICLOUD_C; ft.kind = 'smtp'; ft.next = { outcome: 'refused', reason: 'provider-error' };
    const s = build();
    expect((await s.service.prove()).result).toBe('fail');
    expect((await s.service.prove()).result).toBe('unknown');
    expect(ft.sends).toHaveLength(1);
    vi.advanceTimersByTime(10 * 60_000);
    await s.service.prove();
    vi.advanceTimersByTime(10 * 60_000);
    await s.service.prove();
    vi.advanceTimersByTime(10 * 60_000);
    const fourth = await s.service.prove();
    expect(ft.sends).toHaveLength(3);
    expect(fourth.detail).toMatch(/limit/);
  });
  it('shape A’s signup mail counts against the same day’s bound', () => {
    const s = build();
    expect(s.service.countSignupMail()).toBe('ok');
    expect(s.service.countSignupMail()).toBe('ok');
    expect(s.service.countSignupMail()).toBe('ok');
    expect(s.service.countSignupMail()).toBe('proof-mail-limit');
  });
  it('no grant here, or not the holder: nothing is sent', async () => {
    grant = false;
    const s = build();
    expect((await s.service.prove()).result).toBe('fail');
    grant = true; lease = false;
    expect((await s.service.prove()).result).toBe('unknown');
    expect(ft.sends).toHaveLength(0);
  });
});
