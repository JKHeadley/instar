import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { mintPasskeyCellBody, signPasskeyCellMandate } from '../../src/core/PasskeyCellMandate.js';
import { OUTBOX_BACKOFF_MS, OUTBOX_BREAKER_MS, OUTBOX_ONLINE_FLOOR_MS, PasskeyRevokeOutbox, type DeliveryOutcome } from '../../src/core/PasskeyRevokeOutbox.js';

// Spec docs/specs/agent-held-google-passkey.md §3.2 / FD15 — a signed revoke is re-delivered
// UNCHANGED on 1h/6h/daily backoff (a peer-online observation pulls it forward, never below a
// 15-minute floor), deduplicated per cell (latest wins), durable across restarts, breakered at 30
// days into ONE aggregated attention item per machine + ONE post-breaker attempt when the peer is
// next online, and closed on the peer's applied ack / dismissal / a permanent refusal.

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'passkey-revoke-outbox.test cleanup' }); });
const T0 = Date.parse('2026-09-23T00:00:00Z');
const H = 60 * 60_000;

function world() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-outbox-')); dirs.push(stateDir);
  const op = crypto.generateKeyPairSync('ed25519');
  let now = T0;
  let outcome: DeliveryOutcome = { kind: 'unreachable', reason: 'no-peer-url' };
  let online = false;
  const deliver = vi.fn(async () => outcome);
  const raise = vi.fn(async () => undefined);
  const onApplied = vi.fn();
  const mk = () => new PasskeyRevokeOutbox({ stateDir, deliver, peerOnline: () => online, raiseIncompleteRevoke: raise, onApplied, now: () => now });
  const bundle = (email = 'a@example.com', target = 'm_peer') => signPasskeyCellMandate(mintPasskeyCellBody({ principal: 'dashboard-pin@m_self', canonicalEmail: email, targetMachineId: target, op: 'revoke', now }), 'm_self', op.privateKey);
  return { stateDir, mk, bundle, deliver, raise, onApplied, setOutcome: (o: DeliveryOutcome) => { outcome = o; }, setOnline: (v: boolean) => { online = v; }, tick: (ms: number) => { now += ms; }, now: () => now };
}

describe('PasskeyRevokeOutbox', () => {
  it('enqueues per cell (latest wins), tries immediately, then backs off 1h → 6h → daily re-delivering the SAME bundle; a restart keeps the schedule', async () => {
    const w = world();
    const ob = w.mk();
    const b1 = w.bundle();
    ob.enqueue({ canonicalEmail: 'a@example.com', targetMachineId: 'm_peer', principal: 'p', portable: b1, cutoffSeq: 1 });
    const b2 = w.bundle();
    const e = ob.enqueue({ canonicalEmail: 'a@example.com', targetMachineId: 'm_peer', principal: 'p', portable: b2, cutoffSeq: 2 });
    expect(ob.list()).toHaveLength(1);
    expect(e.nonce).toBe(b2.body.nonce);
    // Attempt 1 now (fails: unreachable) → next in 1h.
    await ob.attemptNow(e.key);
    expect(w.deliver).toHaveBeenCalledTimes(1);
    expect(w.deliver.mock.calls[0][1]).toEqual(b2);
    expect(Date.parse(ob.get(e.key)!.nextAttemptAt) - w.now()).toBe(OUTBOX_BACKOFF_MS[0]);
    // Ticks before it is due do nothing.
    w.tick(H - 1); expect((await ob.tick()).attempted).toEqual([]);
    // Due → attempt 2 → next in 6h. Simulate a RESTART by constructing a fresh outbox on the same file.
    w.tick(1); expect((await w.mk().tick()).attempted).toEqual([e.key]);
    expect(Date.parse(ob.get(e.key)!.nextAttemptAt) - w.now()).toBe(OUTBOX_BACKOFF_MS[1]);
    w.tick(6 * H); expect((await ob.tick()).attempted).toEqual([e.key]);
    expect(Date.parse(ob.get(e.key)!.nextAttemptAt) - w.now()).toBe(OUTBOX_BACKOFF_MS[2]);
    w.tick(24 * H); expect((await ob.tick()).attempted).toEqual([e.key]);
    expect(Date.parse(ob.get(e.key)!.nextAttemptAt) - w.now()).toBe(OUTBOX_BACKOFF_MS[2]); // daily from here
    // Every delivery carried the SAME signed bundle.
    for (const call of w.deliver.mock.calls) expect(call[1]).toEqual(b2);
    expect(ob.get(e.key)).toMatchObject({ state: 'pending', attempts: 4, lastResult: 'unreachable:no-peer-url' });
    expect((fs.statSync(path.join(w.stateDir, 'state', 'passkey-revoke-outbox.json')).mode & 0o777)).toBe(0o600);
  });

  it('the forward pull is EDGE-triggered: an offline→online transition pulls ONCE (never below the 15-minute floor after the last attempt); a peer that stays online-but-refusing follows the plain backoff', async () => {
    const w = world();
    const ob = w.mk();
    const e = ob.enqueue({ canonicalEmail: 'a@example.com', targetMachineId: 'm_peer', principal: 'p', portable: w.bundle(), cutoffSeq: null });
    w.setOnline(true); w.setOutcome({ kind: 'refused', reason: 'issuer-not-trusted' });
    await ob.attemptNow(e.key); // t0 → next at +1h
    // Peer observed OFFLINE at t+10m, ONLINE again at t+14m59s: inside the floor → no pull yet.
    w.setOnline(false); w.tick(10 * 60_000); expect((await ob.tick()).attempted).toEqual([]);
    expect(ob.get(e.key)!.peerSeenOfflineSinceAttempt).toBe(true);
    w.setOnline(true); w.tick(OUTBOX_ONLINE_FLOOR_MS - 10 * 60_000 - 1000); expect((await ob.tick()).attempted).toEqual([]);
    // Past the floor → exactly one pull (attempt 2 at ~t+15m), which re-arms nothing until the peer is seen offline again.
    w.tick(2000); expect((await ob.tick()).attempted).toEqual([e.key]);
    expect(ob.get(e.key)).toMatchObject({ attempts: 2, peerSeenOfflineSinceAttempt: false });
    // Peer stays ONLINE and refusing for the next 3 hours of 10-minute ticks: the plain backoff (6h) holds — no hammering.
    let attempts = 0;
    for (let i = 0; i < 18; i++) { w.tick(10 * 60_000); attempts += (await ob.tick()).attempted.length; }
    expect(attempts).toBe(0);
    expect(ob.get(e.key)!.attempts).toBe(2);
    // The scheduled retry still lands when due.
    w.tick(3 * H); expect((await ob.tick()).attempted).toEqual([e.key]);
  });

  it('a failed escalation raise is retried on the next tick; a second cell escalating later REFRESHES the same machine item with both cells', async () => {
    const w = world();
    const ob = w.mk();
    const a = ob.enqueue({ canonicalEmail: 'a@example.com', targetMachineId: 'm_peer', principal: 'p', portable: w.bundle('a@example.com'), cutoffSeq: 1 });
    // The hub is down for the escalation raise AND the same-tick retry; the next tick's retry lands.
    w.raise.mockRejectedValueOnce(new Error('hub down')).mockRejectedValueOnce(new Error('hub still down'));
    w.tick(OUTBOX_BREAKER_MS + 1);
    expect((await ob.tick()).escalated).toEqual([a.key]);
    expect(ob.get(a.key)).toMatchObject({ state: 'escalated', escalationNotified: false });
    expect(w.raise).toHaveBeenCalledTimes(2);
    w.tick(10 * 60_000);
    await ob.tick();
    expect(ob.get(a.key)!.escalationNotified).toBe(true);
    expect(w.raise).toHaveBeenCalledTimes(3);
    // Cell b escalates 15 days later: the SAME id is raised again with BOTH cells (the sink upserts).
    const b = ob.enqueue({ canonicalEmail: 'b@example.com', targetMachineId: 'm_peer', principal: 'p', portable: w.bundle('b@example.com'), cutoffSeq: 1 });
    w.tick(OUTBOX_BREAKER_MS + 1);
    expect((await ob.tick()).escalated).toEqual([b.key]);
    const last = w.raise.mock.calls.at(-1)![0];
    expect(last.id).toBe('passkey-incomplete-revoke:m_peer');
    expect(last.cells).toEqual(['a@example.com', 'b@example.com']);
  });

  it('attemptNow and tick share one in-flight lane: a route try during a tick never double-sends the same bundle', async () => {
    const w = world();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    w.deliver.mockImplementationOnce(async () => { await gate; return { kind: 'unreachable', reason: 'slow' }; });
    const ob = w.mk();
    const e = ob.enqueue({ canonicalEmail: 'a@example.com', targetMachineId: 'm_peer', principal: 'p', portable: w.bundle(), cutoffSeq: 1 });
    const t = ob.tick(); // takes the lane and blocks in deliver
    await new Promise((r) => setTimeout(r, 5));
    const n = ob.attemptNow(e.key); // must wait for the lane, then see the entry no longer due
    await new Promise((r) => setTimeout(r, 5));
    expect(w.deliver).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([t, n]);
    // The route's try ran AFTER the tick's attempt completed (serialised), so it sent again only once the lane was free.
    expect(w.deliver).toHaveBeenCalledTimes(2);
    expect(ob.get(e.key)!.attempts).toBe(2);
  });

  it('applied ⇒ applied + onApplied; dismissed-at-peer ⇒ closed; a PERMANENT refusal ⇒ closed (re-issue), while issuer-not-trusted keeps backing off', async () => {
    const w = world();
    const ob = w.mk();
    const a = ob.enqueue({ canonicalEmail: 'a@example.com', targetMachineId: 'm_peer', principal: 'p', portable: w.bundle('a@example.com'), cutoffSeq: 1 });
    w.setOutcome({ kind: 'refused', reason: 'issuer-not-trusted' });
    await ob.attemptNow(a.key);
    expect(ob.get(a.key)).toMatchObject({ state: 'pending', attempts: 1, lastResult: 'refused:issuer-not-trusted' });
    w.setOutcome({ kind: 'applied' });
    w.tick(H);
    expect((await ob.tick()).applied).toEqual([a.key]);
    expect(ob.get(a.key)).toMatchObject({ state: 'applied', attempts: 2 });
    expect(w.onApplied).toHaveBeenCalledWith(expect.objectContaining({ key: a.key }));
    const b = ob.enqueue({ canonicalEmail: 'b@example.com', targetMachineId: 'm_peer', principal: 'p', portable: w.bundle('b@example.com'), cutoffSeq: 1 });
    w.setOutcome({ kind: 'dismissed', reason: 'dismissed-by-operator' });
    await ob.attemptNow(b.key);
    expect(ob.get(b.key)).toMatchObject({ state: 'closed', closedReason: 'dismissed-at-peer:dismissed-by-operator' });
    const c = ob.enqueue({ canonicalEmail: 'c@example.com', targetMachineId: 'm_peer', principal: 'p', portable: w.bundle('c@example.com'), cutoffSeq: 1 });
    w.setOutcome({ kind: 'refused', reason: 'bad-signature' });
    await ob.attemptNow(c.key);
    expect(ob.get(c.key)).toMatchObject({ state: 'closed', closedReason: 'permanent-refusal:bad-signature' });
    // Closed / applied entries are never re-attempted.
    w.tick(48 * H);
    expect((await ob.tick()).attempted).toEqual([]);
  });

  it('30-day breaker: escalates ONCE per machine (aggregated cells), stops automatic re-delivery, and spends exactly ONE post-breaker attempt when the peer is next online — a flapping peer cannot re-trigger it', async () => {
    const w = world();
    const ob = w.mk();
    const a = ob.enqueue({ canonicalEmail: 'a@example.com', targetMachineId: 'm_peer', principal: 'p', portable: w.bundle('a@example.com'), cutoffSeq: 1 });
    const b = ob.enqueue({ canonicalEmail: 'b@example.com', targetMachineId: 'm_peer', principal: 'p', portable: w.bundle('b@example.com'), cutoffSeq: 1 });
    // Daily ticks for 30 days: attempts follow the schedule, no escalation yet.
    let attempts = 0;
    for (let d = 0; d < 30; d++) { const r = await ob.tick(); attempts += r.attempted.length; expect(r.escalated).toEqual([]); w.tick(24 * H); }
    expect(attempts).toBeGreaterThan(0);
    // Day 30 → escalate both cells; ONE attention item for the machine listing both.
    const r30 = await ob.tick();
    expect(r30.escalated.sort()).toEqual([a.key, b.key].sort());
    expect(w.raise).toHaveBeenCalledTimes(2); // upsert per escalated entry, same id — the sink dedupes by id
    for (const call of w.raise.mock.calls) expect(call[0].id).toBe('passkey-incomplete-revoke:m_peer');
    expect(w.raise.mock.calls.at(-1)![0].cells.sort()).toEqual(['a@example.com', 'b@example.com']);
    const attemptsAtBreaker = w.deliver.mock.calls.length;
    // Peer stays offline: no more attempts, for weeks.
    for (let d = 0; d < 20; d++) { w.tick(24 * H); expect((await ob.tick()).attempted).toEqual([]); }
    expect(w.deliver).toHaveBeenCalledTimes(attemptsAtBreaker);
    // Peer comes online: ONE attempt per entry, then never again even as it flaps.
    w.setOnline(true);
    const online1 = await ob.tick();
    expect(online1.attempted.sort()).toEqual([a.key, b.key].sort());
    expect(ob.get(a.key)!.postBreakerAttemptAt).toBeTruthy();
    for (let i = 0; i < 5; i++) { w.setOnline(i % 2 === 0); w.tick(H); expect((await ob.tick()).attempted).toEqual([]); }
    expect(w.deliver).toHaveBeenCalledTimes(attemptsAtBreaker + 2);
    // The post-breaker attempt can still succeed.
    const c = ob.enqueue({ canonicalEmail: 'c@example.com', targetMachineId: 'm_peer', principal: 'p', portable: w.bundle('c@example.com'), cutoffSeq: 1 });
    w.setOnline(false);
    w.tick(OUTBOX_BREAKER_MS + H);
    await ob.tick();
    expect(ob.get(c.key)!.state).toBe('escalated');
    w.setOutcome({ kind: 'applied' }); w.setOnline(true);
    expect((await ob.tick()).applied).toEqual([c.key]);
    expect(ob.get(c.key)!.state).toBe('applied');
    // An operator close is honoured and idempotent.
    expect(ob.close(a.key, 'google-side-removed-verified')).toBe(true);
    expect(ob.close(a.key, 'again')).toBe(false);
  });

  it('a tick is single-flight, bounded per pass, and a corrupt file fails CLOSED', async () => {
    const w = world();
    const ob = w.mk();
    for (let i = 0; i < 12; i++) ob.enqueue({ canonicalEmail: `u${i}@example.com`, targetMachineId: 'm_peer', principal: 'p', portable: w.bundle(`u${i}@example.com`), cutoffSeq: 1 });
    const [r1, r2] = await Promise.all([ob.tick(), ob.tick()]);
    expect(r1.attempted.length + r2.attempted.length).toBe(10); // one pass ran (bounded), the concurrent one was a no-op
    fs.writeFileSync(path.join(w.stateDir, 'state', 'passkey-revoke-outbox.json'), '{');
    expect(() => ob.list()).toThrow('passkey-revoke-outbox-unreadable');
    await expect(ob.tick()).rejects.toThrow('passkey-revoke-outbox-unreadable');
  });
});
