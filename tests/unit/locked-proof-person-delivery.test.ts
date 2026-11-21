import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
// @ts-expect-error standalone proof harness
import { classifyPersonReceipt, recordPersonStep, RealTarget } from '../../scripts/locked-proof/driver.mjs';
// @ts-expect-error standalone proof harness
import { CASES, personCue, runCase, judge } from '../../scripts/locked-proof/lib.mjs';

const topic = 138345;
const sent = { status: 0, stdout: `Sent 150 chars to topic ${topic}`, stderr: '' };
const fallback = { status: 0, stdout: `Delivered to topic ${topic} (message id 123); receipt not fully recorded — do not resend`,
  stderr: 'DELIVERED — Telegram accepted this message (message id 123). Do NOT resend it.' };
const c = CASES.find((row: { id: string }) => row.id === '15.10');
const NOW = 1_000_000;

describe('canonical Telegram wrapper receipt contract', () => {
  it('pins the actual wrapper outcomes that deliberately share zero exit status', () => {
    const wrapper = fs.readFileSync(path.resolve(__dirname, '../../src/templates/scripts/telegram-reply.sh'), 'utf8');
    for (const line of ['NOT SENT — advisory', 'AMBIGUOUS: no HTTP outcome', 'AMBIGUOUS (HTTP 408)',
      'AMBIGUOUS (HTTP 409 held)', 'Only part of it reached Telegram', 'Delivered to topic $TOPIC_ID', 'chars to topic $TOPIC_ID']) {
      expect(wrapper).toContain(line);
    }
    expect(wrapper).toMatch(/delivered\|partially-delivered\)/);
    expect(wrapper).toMatch(/NOT SENT — advisory[\s\S]*?exit 0/);
    expect(wrapper).toMatch(/AMBIGUOUS: no HTTP outcome[^\n]*\n\s*exit 0/);
  });
  it('accepts the exact full successful receipts, including known-accepted fallback', () => {
    expect(classifyPersonReceipt(sent, topic)).toBe('confirmed');
    expect(classifyPersonReceipt(fallback, topic)).toBe('confirmed');
  });
  it.each([
    { status: 0, stdout: 'AMBIGUOUS: no HTTP outcome — hold pending authoritative receipt/outbox resolution' },
    { status: 0, stdout: 'AMBIGUOUS (HTTP 408): outcome unknown — hold pending authoritative receipt/outbox resolution' },
    { status: 0, stdout: 'AMBIGUOUS (HTTP 409 held): outcome unknown — do not resend; check the operation outcome' },
    { status: 0, stdout: 'NOT SENT — advisory (fix and re-run, or re-run with --ack-advisory to send unchanged)' },
    { ...fallback, stderr: fallback.stderr + '\nOnly part of it reached Telegram. Check before sending the rest yourself.' },
    { ...sent, stdout: 'Sent 150 chars to topic 42' },
    { status: 0, stdout: '' },
    { status: 1, stdout: 'NOT SENT — suppressed duplicate for topic 138345' },
    { status: 1, stderr: 'Queued for recovery (HTTP 503, delivery_id abc…)' },
    { ...sent, status: null, signal: 'SIGTERM' },
    { ...fallback, stderr: '' },
    { ...sent, stdout: sent.stdout + '\nunknown output' },
  ])('does not mistake unsuccessful or incomplete output for full delivery: %j', result => {
    expect(classifyPersonReceipt(result, topic)).not.toBe('confirmed');
  });
});

function fixture(result = sent, afterSend = 0, notifyTopic: number | undefined = topic) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'proof-person-delivery-'));
  let now = NOW;
  let sends = 0;
  const t = Object.assign(Object.create(RealTarget.prototype), {
    o: { out, notifyTopic }, now: () => now,
    sendPersonStep: () => { sends++; now += afterSend; return result; },
  });
  return { t, out, sends: () => sends, rows: () => fs.readFileSync(path.join(out, 'person-steps.jsonl'), 'utf8').trim().split('\n').map(s => JSON.parse(s)),
    clean: () => SafeFsExecutor.safeRmSync(out, { recursive: true, force: true, operation: 'test fixture cleanup' }) };
}

describe('bounded person cues', () => {
  it('includes case/run identity and a human-visible absolute start-by deadline', () => {
    const cue = personCue(c, 'test-run', NOW, NOW - 30_000);
    expect(cue.caseId).toBe('15.10'); expect(cue.runId).toBe('test-run');
    expect(cue.validUntil).toBe(NOW + 30_000);
    expect(cue.text).toContain('START BY'); expect(cue.text).toContain(cue.validUntilUtc);
    expect(cue.text).toContain('If that time has passed, or this run has stopped, do not act.');
    expect(cue.text).toContain('now');
  });
  it('bounds an inside-watch start deadline and refuses a window too small to act safely', () => {
    expect(personCue(c, 'r', NOW, NOW - 110_000).validUntil).toBe(NOW + 9_000);
    expect(() => personCue(c, 'r', NOW, NOW - 115_000)).toThrow('no safe start window');
  });
  it('does not call the sender for a stale prompt', async () => {
    const f = fixture();
    try {
      await expect(f.t.askPerson('stale', { validUntil: NOW - 1 })).rejects.toThrow('no safe start window');
      expect(f.sends()).toBe(0);
    } finally { f.clean(); }
  });
  it('logs an ambiguous result and aborts without retrying it', async () => {
    const f = fixture({ status: 0, stdout: 'AMBIGUOUS: no HTTP outcome', stderr: '' });
    try {
      const cue = personCue(c, 'r', NOW, NOW - 30_000);
      await expect(f.t.askPerson(cue.text, cue)).rejects.toThrow('retained messages may still arrive');
      expect(f.sends()).toBe(1);
      expect(f.rows()[0]).toMatchObject({ channel: 'telegram', outcome: 'ambiguous', sent: false, validUntil: cue.validUntil, runId: 'r' });
    } finally { f.clean(); }
  });
  it('does not accept a full receipt that only returns after the start-by deadline', async () => {
    const f = fixture(sent, 30_000);
    try {
      const cue = personCue(c, 'r', NOW, NOW - 30_000);
      await expect(f.t.askPerson(cue.text, cue)).rejects.toThrow('after its start-by deadline');
      expect(f.sends()).toBe(1); expect(f.rows()[0]).toMatchObject({ sent: true, validity: 'expired' }); // Delivered, but too late for this cue.
    } finally { f.clean(); }
  });
  it('records a thrown sender as unconfirmed instead of losing the attempt', async () => {
    const f = fixture();
    f.t.sendPersonStep = () => { throw new Error('spawn failed'); };
    try {
      const cue = personCue(c, 'r', NOW, NOW - 30_000);
      await expect(f.t.askPerson(cue.text, cue)).rejects.toThrow('unconfirmed');
      expect(f.rows()[0]).toMatchObject({ sent: false, outcome: 'unconfirmed' });
    } finally { f.clean(); }
  });
  it('records console-only mode explicitly and never invokes the sender', async () => {
    const f = fixture(sent, 0, undefined);
    // Default parameter above is useful for Telegram fixtures; select console explicitly here.
    f.t.o.notifyTopic = undefined;
    try {
      const cue = personCue(c, 'r', NOW, NOW - 30_000);
      expect(await f.t.askPerson(cue.text, cue)).toMatchObject({ channel: 'console', outcome: 'console-only', sent: false });
      expect(f.sends()).toBe(0);
    } finally { f.clean(); }
  });
  it('runCase does not complete a cue or continue sampling after delivery throws', async () => {
    let time = NOW;
    const simple = { ...c, password: false, inject: [], person: { text: 'Act now.', until: 'unlocked' } };
    let recovered = 0, snapshots = 0;
    const target = { now: () => time, prepare: async () => {}, openGrant: async () => ({}),
      snapshot: async () => { snapshots++; return { now: time, lockState: 'locked', markers: {} }; },
      askPerson: async () => { time += 100; throw new Error('person cue delivery unconfirmed: ambiguous'); },
      recover: async () => { recovered++; return []; } };
    const ev = await runCase(simple, target);
    expect(ev.error).toContain('unconfirmed'); expect(ev.person.cueCompletedAt).toBeUndefined();
    expect(ev.verdict.pass).toBe(false); expect(recovered).toBe(1); expect(snapshots).toBe(2);
  });
  it('the verdict rejects expired cue confirmation independently of the runner', () => {
    const ev = { fired: [], unfired: [], samples: [], final: { lockState: 'locked', markers: {} },
      person: { doneAt: NOW, validUntil: NOW, cueCompletedAt: NOW, delivery: { channel: 'telegram', outcome: 'confirmed', sent: true } } };
    expect(judge(c, ev).reasons).toContain('person cue was not confirmed before its start-by deadline');
  });
});
