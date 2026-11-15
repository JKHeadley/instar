/**
 * docs/specs/mobile-pairing-outcome-notice.md §3.2–§3.4: the watch store and reconciler.
 * Real file I/O in a temp dir; fake clock; stub send/escalate.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  PairingOutcomeWatches, classify, type OutcomeWatch, type WatchedDevice, type SendResult, type OperationResult,
  SEND_WINDOW_MS, STALE_DECISION_MS, OUTBOX_DEADLINE_MS,
} from '../../src/core/PairingOutcomeWatches.js';

let dir: string;
let now: number;
let devices: WatchedDevice[];
let readThrows: boolean;
let sends: Array<{ topicId: number; text: string; logical: string; anchor: string | null }>;
let sendResult: SendResult | (() => SendResult);
let opResult: OperationResult;
let escalations: Array<{ topicId: number; lines: string[] }>;
let escalateOk: boolean;
let enabled: boolean;
let epoch: string;

function make() {
  return new PairingOutcomeWatches({
    stateDir: dir, agentName: () => 'Echo', listDevices: () => { if (readThrows) throw new Error('corrupt'); return devices; },
    codeEpoch: () => epoch,
    send: async (topicId, text, logical, anchor) => { sends.push({ topicId, text, logical, anchor }); return typeof sendResult === 'function' ? sendResult() : sendResult; },
    checkOperation: async () => opResult,
    escalate: async (topicId, lines) => { escalations.push({ topicId, lines }); return escalateOk; },
    enabled: () => enabled, now: () => now,
  });
}

function device(over: Partial<WatchedDevice> & { outcomeWatchId: string }): WatchedDevice {
  return { id: 'd1', status: 'pending', deviceName: "Justin's iPhone", label: null, fingerprint: 'ABCD-1234-EF56-7890', ...over };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pow-'));
  now = Date.parse('2026-11-14T22:00:00Z');
  devices = []; readThrows = false; sends = []; sendResult = { kind: 'sent' }; opResult = 'unknown';
  escalations = []; escalateOk = true; enabled = true; epoch = 'boot-A';
});
afterEach(() => { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/PairingOutcomeWatches.test.ts' }); });

function rec(w: PairingOutcomeWatches, anchor: string | null = '100'): string {
  const r = w.record({ topicId: 42, label: 'Justin iPhone', codeExpiresAt: now + 30 * 60_000, anchorInboundId: anchor });
  if (!r.ok) throw new Error(r.reason);
  return r.id;
}

describe('classify (§3.3 table)', () => {
  const base: OutcomeWatch = { id: 'w', topicId: 1, label: null, mintedAt: '', codeExpiresAt: new Date(2e12).toISOString(), codeEpoch: 'A', state: 'watching', attempts: 0 };
  const d = (over: Partial<WatchedDevice>) => device({ outcomeWatchId: 'w', ...over });
  it('maps each registry status', () => {
    expect(classify(base, d({ status: 'active' }), 'A', 0)).toBe('paired');
    expect(classify(base, d({ status: 'revoked', approvedAt: 'x' }), 'A', 0)).toBe('paired');
    expect(classify(base, d({ status: 'revoked' }), 'A', 0)).toBe('ended');
    expect(classify(base, d({ status: 'declined', wrongCodes: ['a', 'b', 'c'] }), 'A', 0)).toBe('declined-wrong-codes');
    expect(classify(base, d({ status: 'declined', wrongCodes: ['a'] }), 'A', 0)).toBe('declined');
    expect(classify(base, d({ status: 'expired', expiresAt: '2026-01-01T00:10:00Z', pendingDeadline: '2026-01-01T00:10:00Z' }), 'A', 0)).toBe('expired');
    expect(classify(base, d({ status: 'expired', expiresAt: '2026-01-01T00:02:00Z', pendingDeadline: '2026-01-01T00:10:00Z' }), 'A', 0)).toBe('interrupted');
    expect(classify(base, d({ status: 'pending' }), 'A', 0)).toBeNull();
    expect(classify(base, d({ status: 'legacy-token' }), 'A', 0)).toBe('unknown');
  });
  it('a missing row is never "not paired" on its own', () => {
    expect(classify({ ...base, approvedSeenAt: 'x' }, undefined, 'A', 0)).toBe('paired');
    expect(classify({ ...base, lastSeen: { status: 'pending', at: 'x' } }, undefined, 'A', 0)).toBe('ended');
    expect(classify({ ...base, takenAt: 'x' }, undefined, 'A', 0)).toBe('ended');
    expect(classify(base, undefined, 'B', 0)).toBe('link-void');
    expect(classify({ ...base, codeExpiresAt: new Date(0).toISOString() }, undefined, 'A', 1000)).toBe('link-expired');
    expect(classify(base, undefined, 'A', 0)).toBeNull();
  });
});

describe('PairingOutcomeWatches', () => {
  it('sends exactly one paired line to the topic, with the anchor and a stable logical id', async () => {
    const w = make(); const id = rec(w);
    expect(await w.pass()).toBe(true);
    expect(sends).toHaveLength(0);
    devices = [device({ outcomeWatchId: id, status: 'active' })];
    await w.pass(); await w.pass(); await w.pass();
    expect(sends).toEqual([{ topicId: 42, text: `A phone named "Justin's iPhone" was paired with Echo (key ABCD-1234-EF56-7890).`, logical: `mobile-pairing-outcome:${id}`, anchor: '100' }]);
    expect(w.get(id)!.state).toBe('sent');
  });

  it('an unreadable registry decides nothing new but still sends decided entries', async () => {
    const w = make(); const a = rec(w); const b = rec(w);
    w.markOutcome(b, 'not-delivered');
    readThrows = true;
    await w.pass();
    expect(w.get(a)!.state).toBe('watching');
    expect(sends.map((s) => s.logical)).toEqual([`mobile-pairing-outcome:${b}`]);
  });

  it('freezes the text when decided', async () => {
    const w = make(); const id = rec(w);
    devices = [device({ outcomeWatchId: id, status: 'declined' })];
    sendResult = { kind: 'retry', error: 'down' };
    await w.pass();
    const text = w.get(id)!.text;
    devices = [device({ outcomeWatchId: id, status: 'active', deviceName: 'Other' })];
    now += 60_000; sendResult = { kind: 'sent' };
    await w.pass();
    expect(sends.at(-1)!.text).toBe(text);
  });

  it('retries with backoff, then fails after the window and raises one attention item', async () => {
    const w = make(); const id = rec(w);
    w.markOutcome(id, 'not-delivered');
    sendResult = { kind: 'retry', error: 'down' };
    await w.pass();
    expect(sends).toHaveLength(1);
    await w.pass();
    expect(sends).toHaveLength(1); // backoff not yet elapsed
    now += 31_000; await w.pass();
    expect(sends).toHaveLength(2);
    now += SEND_WINDOW_MS; await w.pass();
    expect(w.get(id)!.state).toBe('failed');
    expect(escalations).toHaveLength(1);
    expect(escalations[0]!.topicId).toBe(42);
    expect(escalations[0]!.lines[0]).toContain('I could not post that in this conversation.');
    expect(w.get(id)!.escalated).toBe(true);
  });

  it('a final refusal fails at once; a failed attention upsert is retried with backoff', async () => {
    const w = make(); const id = rec(w);
    w.markOutcome(id, 'ended');
    sendResult = { kind: 'failed', error: 'tone' };
    escalateOk = false;
    await w.pass();
    expect(w.get(id)!.state).toBe('failed');
    expect(escalations).toHaveLength(1);
    await w.pass();
    expect(escalations).toHaveLength(1); // backed off
    escalateOk = true; now += 31_000; await w.pass();
    expect(escalations).toHaveLength(2);
    expect(w.get(id)!.escalated).toBe(true);
    expect(w.openCount()).toBe(0);
  });

  it('a send interrupted by a crash is replayed with the same id and text', async () => {
    const w = make(); const id = rec(w);
    w.markOutcome(id, 'not-delivered');
    const file = path.join(dir, 'state', 'mobile-pairing-outcome-watches.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    raw.watches[0].state = 'sending';
    fs.writeFileSync(file, JSON.stringify(raw));
    const w2 = make();
    expect(w2.get(id)!.state).toBe('due');
    await w2.pass();
    expect(sends).toEqual([{ topicId: 42, text: raw.watches[0].text, logical: `mobile-pairing-outcome:${id}`, anchor: '100' }]);
  });

  it('a link whose process restarted reads link-void', async () => {
    const w = make(); const id = rec(w);
    epoch = 'boot-B';
    const w2 = make();
    await w2.pass();
    expect(w2.get(id)!.outcome).toBe('link-void');
  });

  it('a handed-off send follows the outbox, with backoff, up to 6 hours', async () => {
    const w = make(); const id = rec(w);
    w.markOutcome(id, 'not-delivered');
    sendResult = { kind: 'handed-off', operationId: 'op-123456' };
    await w.pass();
    expect(w.get(id)!.state).toBe('handed-off');
    now += 31_000; opResult = 'unknown'; await w.pass();
    expect(w.get(id)!.state).toBe('handed-off');
    now += SEND_WINDOW_MS + 60_000; await w.pass();
    expect(w.get(id)!.state).toBe('handed-off'); // the 1-hour window does not apply
    now += OUTBOX_DEADLINE_MS; await w.pass();
    expect(w.get(id)!.state).toBe('failed');
    expect(escalations[0]!.lines[0]).toContain('I may not have been able to post that');
  });

  it('a handed-off send the outbox delivers is sent; quiet filing depends on the anchor', async () => {
    const w = make(); const a = rec(w, '100'); const b = rec(w, null);
    w.markOutcome(a, 'ended'); w.markOutcome(b, 'ended');
    sendResult = { kind: 'handed-off', operationId: 'op-123456' };
    await w.pass();
    now += 31_000; opResult = 'quiet'; await w.pass();
    expect(w.get(a)!.state).toBe('failed');
    expect(w.get(b)!.state).toBe('sent');
  });

  it('an outcome decided too late is not sent', async () => {
    const w = make(); const id = rec(w);
    now += STALE_DECISION_MS + 60_000;
    devices = [device({ outcomeWatchId: id, status: 'active' })];
    await w.pass();
    expect(sends).toHaveLength(0);
    expect(w.get(id)!.state).toBe('failed');
    expect(escalations).toHaveLength(1);
  });

  it('the kill switch stops passes', async () => {
    const w = make(); const id = rec(w);
    w.markOutcome(id, 'ended');
    enabled = false;
    expect(await w.pass()).toBe(false);
    expect(sends).toHaveLength(0);
  });

  it('re-entrant passes do not double-send', async () => {
    const w = make(); const id = rec(w);
    w.markOutcome(id, 'ended');
    let release!: () => void;
    sendResult = () => ({ kind: 'sent' });
    const gate = new Promise<void>((r) => { release = r; });
    const slow = new PairingOutcomeWatches({
      stateDir: dir, agentName: () => 'Echo', listDevices: () => devices, codeEpoch: () => epoch,
      send: async (topicId, text, logical, anchor) => { sends.push({ topicId, text, logical, anchor }); await gate; return { kind: 'sent' }; },
      checkOperation: async () => 'unknown', escalate: async () => true, enabled: () => true, now: () => now,
    });
    const p1 = slow.pass(); const p2 = slow.pass();
    expect(await p2).toBe(false);
    release(); await p1;
    expect(sends).toHaveLength(1);
  });

  it('an idle pass reads no file', async () => {
    const w = make();
    const spy = vi.fn(() => devices);
    (w as unknown as { deps: { listDevices: () => WatchedDevice[] } }).deps.listDevices = spy;
    expect(await w.pass()).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('caps open watches and reports the reason', () => {
    const w = make();
    for (let i = 0; i < 50; i++) rec(w);
    const r = w.record({ topicId: 1, label: null, codeExpiresAt: now + 1000, anchorInboundId: null });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/Too many pairing links/);
  });

  it('persists across a new instance and lists outcomes newest first', async () => {
    const w = make(); const a = rec(w); now += 1000; const b = rec(w);
    w.markOutcome(a, 'ended');
    const w2 = make();
    expect(w2.outcomes().map((o) => o.watchId)).toEqual([b, a]);
    expect(w2.get(a)!.outcome).toBe('ended');
    expect(fs.statSync(path.join(dir, 'state', 'mobile-pairing-outcome-watches.json')).mode & 0o777).toBe(0o600);
  });
});
