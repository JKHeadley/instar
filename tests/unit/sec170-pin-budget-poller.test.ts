/**
 * SEC-170 part 2 of 2 — the poller that carries acknowledgments (docs/specs/pool-wide-pin-budget.md §4).
 * Replies are signed by the peer over this machine's fresh nonce; anything else counts as no answer.
 */
import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { PinBudgetPoller, stateSigningText, POLL_INTERVAL_MS } from '../../src/core/pinBudgetPoller.js';
import { makeTable, type PeerShareReport } from '../../src/core/PinShareTable.js';

const keys = new Map<string, crypto.KeyObject>();
const pubs = new Map<string, crypto.KeyObject>();
for (const id of ['m_b', 'm_c']) { const k = crypto.generateKeyPairSync('ed25519'); keys.set(id, k.privateKey); pubs.set(id, k.publicKey); }
const signAs = (id: string, text: string) => crypto.sign(null, Buffer.from(text), keys.get(id)!).toString('base64');
const verify = (id: string, text: string, sig: string) => { const p = pubs.get(id); try { return !!p && crypto.verify(null, Buffer.from(text), p, Buffer.from(sig, 'base64')); } catch { return false; } };

describe('SEC-170 part 2 — PinBudgetPoller', () => {
  const t = makeTable(3, ['m_a', 'm_b', 'm_c']);
  const report = (id: string): PeerShareReport => ({ machineId: id, table: t, applied: 7, retired: false, needsShare: false });

  it('accepts a reply signed by the peer over this nonce, and records contact', async () => {
    let now = 1_000_000;
    const p = new PinBudgetPoller({
      self: () => 'm_a', peers: () => ['m_b'], members: () => ['m_a', 'm_b'], verify, now: () => now,
      fetchState: async (id, nonce) => ({ report: report(id), contacts: {}, sig: signAs(id, stateSigningText(nonce, report(id), {})) }),
    });
    expect(p.pollReady()).toBe(false);
    await p.round();
    expect(p.pollReady()).toBe(true);
    expect(p.reports().get('m_b')).toMatchObject({ applied: 7 });
    expect(p.contacts()).toMatchObject({ complete: true });
    expect(p.contacts().map.get('m_b')).toBe(now);
  });

  it('refuses a reply signed over another nonce (replay), by another machine, or claiming another id', async () => {
    const replay = new PinBudgetPoller({ self: () => 'm_a', peers: () => ['m_b'], members: () => ['m_a', 'm_b'], verify,
      fetchState: async (id) => ({ report: report(id), contacts: {}, sig: signAs(id, stateSigningText('00'.repeat(16), report(id), {})) }) });
    await replay.round();
    expect(replay.reports().size).toBe(0);
    expect(replay.contacts().complete).toBe(false);

    const wrongKey = new PinBudgetPoller({ self: () => 'm_a', peers: () => ['m_b'], members: () => ['m_a', 'm_b'], verify,
      fetchState: async (id, nonce) => ({ report: report(id), contacts: {}, sig: signAs('m_c', stateSigningText(nonce, report(id), {})) }) });
    await wrongKey.round();
    expect(wrongKey.reports().size).toBe(0);

    const impostor = new PinBudgetPoller({ self: () => 'm_a', peers: () => ['m_b'], members: () => ['m_a', 'm_b'], verify,
      fetchState: async (_id, nonce) => ({ report: report('m_c'), contacts: {}, sig: signAs('m_c', stateSigningText(nonce, report('m_c'), {})) }) });
    await impostor.round();
    expect(impostor.reports().size).toBe(0);
  });

  it('backs off a failing peer (5 s doubling to 60 s), stops after 24 hours, and resumes when the peer is seen', async () => {
    let now = 0;
    let calls = 0;
    const p = new PinBudgetPoller({ self: () => 'm_a', peers: () => ['m_b'], members: () => ['m_a', 'm_b'], verify, now: () => now,
      fetchState: async () => { calls += 1; throw new Error('down'); } });
    await p.round(); expect(calls).toBe(1);
    now += 4_999; await p.round(); expect(calls).toBe(1);
    now += 1; await p.round(); expect(calls).toBe(2);
    now += 9_999; await p.round(); expect(calls).toBe(2);
    now += 1; await p.round(); expect(calls).toBe(3);
    now += 24 * 60 * 60 * 1000; await p.round();
    const stopped = calls;
    now += 120_000; await p.round();
    expect(calls).toBe(stopped);
    p.noteSeen('m_b');
    await p.round();
    expect(calls).toBe(stopped + 1);
  });

  it('merges peers\' contact records, ignoring times from the future', async () => {
    const now = 5_000_000;
    const contacts = { m_c: now - 10, m_x: now + 10 * 60_000 };
    const p = new PinBudgetPoller({ self: () => 'm_a', peers: () => ['m_b'], members: () => ['m_a', 'm_b', 'm_c'], verify, now: () => now,
      fetchState: async (id, nonce) => ({ report: report(id), contacts, sig: signAs(id, stateSigningText(nonce, report(id), contacts)) }) });
    await p.round();
    expect(p.contacts().map.get('m_c')).toBe(now - 10);
    expect(p.contacts().map.has('m_x')).toBe(false);
    expect(p.contacts().complete).toBe(false); // m_c's own record was not read
    expect(POLL_INTERVAL_MS).toBe(30_000);
  });
});
