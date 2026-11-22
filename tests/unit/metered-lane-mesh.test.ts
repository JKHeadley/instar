/**
 * gemini-payg-metered-lane §6 — submit/poll durability, result tokens, eviction, the
 * designation echo (lease liveness) and conflict judgement.
 */
import { describe, it, expect } from 'vitest';
import {
  HolderCallStore,
  forwardMeteredCall,
  forwardCallId,
  DesignationEchoTracker,
  answerDesignationEcho,
  classifyForwardFailure,
  failoverThresholdAllowsArming,
  WORST_CASE_FENCE_MS,
  sha256Hex,
  type ForwardedCall,
} from '../../src/core/meteredLaneMesh.js';

const call = (over: Partial<ForwardedCall> = {}, token = 'tok-1'): ForwardedCall => ({
  op: 'second-opinion', originMachine: 'm_mama', session: 's', callId: 'c1', requestSha256: 'r1', resultTokenHash: sha256Hex(token), payload: {}, ...over,
});
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('HolderCallStore', () => {
  it('runs a callId once; a resubmit returns the existing state', async () => {
    let runs = 0;
    const s = new HolderCallStore({ run: async () => { runs++; return { status: 200, body: { ok: true } }; }, ledgerLookup: () => null });
    expect(s.submit(call()).state).toBe('running');
    s.submit(call());
    await flush();
    expect(runs).toBe(1);
    expect(s.submit(call()).state).toBe('done');
  });

  it('a resubmit with a different result token is not-yours (a callId is not secret)', async () => {
    const s = new HolderCallStore({ run: async () => ({ status: 200, body: { text: 'paid answer' } }), ledgerLookup: () => null });
    s.submit(call());
    await flush();
    expect(s.submit(call({ resultTokenHash: sha256Hex('attacker') }))).toEqual({ state: 'not-yours', callId: 'c1' });
  });

  it('same callId with a different request → callid-conflict', () => {
    const s = new HolderCallStore({ run: async () => ({ status: 200, body: {} }), ledgerLookup: () => null });
    s.submit(call());
    expect(s.submit(call({ requestSha256: 'other' })).state).toBe('callid-conflict');
  });

  it('a poll without the right result token is not-yours (two sessions share a bearer token)', async () => {
    const s = new HolderCallStore({ run: async () => ({ status: 200, body: { text: 'secret answer' } }), ledgerLookup: () => null });
    s.submit(call());
    await flush();
    expect(s.poll('c1', 'wrong').state).toBe('not-yours');
    expect(s.poll('c1', 'tok-1')).toMatchObject({ state: 'done', status: 200 });
  });

  it('after a restart (ledger knows the callId) a submit or poll is settled-result-lost and never re-dispatches', () => {
    let runs = 0;
    const s = new HolderCallStore({ run: async () => { runs++; return { status: 200, body: {} }; }, ledgerLookup: (id) => (id === 'c1' ? { requestSha256: 'r1', bookedUsd: 0.12 } : null) });
    expect(s.submit(call())).toMatchObject({ state: 'settled-result-lost', bookedUsd: 0.12 });
    expect(s.poll('c1', 'tok-1')).toMatchObject({ state: 'settled-result-lost' });
    expect(runs).toBe(0);
  });

  it('evicts after retention and oldest-first over the byte cap', async () => {
    let t = 0;
    const s = new HolderCallStore({ run: async () => ({ status: 200, body: { pad: 'x'.repeat(100) } }), ledgerLookup: () => null, now: () => t, maxBytes: 250 });
    s.submit(call({ callId: 'a' })); await flush(); t += 1;
    s.submit(call({ callId: 'b' })); await flush(); t += 1;
    s.submit(call({ callId: 'c' })); await flush();
    expect(s.poll('a', 'tok-1').state).toBe('unknown');
    expect(s.poll('c', 'tok-1').state).toBe('done');
    t += 31 * 60 * 1000;
    expect(s.poll('c', 'tok-1').state).toBe('unknown');
  });
});

describe('forwardMeteredCall', () => {
  it('submits then polls; the token is generated at the origin and only its hash is submitted', async () => {
    const store = new HolderCallStore({ run: async () => ({ status: 200, body: { ok: true, text: 'hi' } }), ledgerLookup: () => null });
    const sent: Array<Record<string, unknown>> = [];
    const send = async (_m: string, cmd: Record<string, unknown>) => {
      sent.push(cmd);
      if (cmd.type === 'metered-gemini-call') return store.submit(cmd as unknown as ForwardedCall);
      await flush();
      return store.poll(cmd.callId as string, cmd.resultToken as string);
    };
    const r = await forwardMeteredCall({ send, holder: () => 'm_studio', originMachine: 'm_mama', sleep: async () => {} }, { op: 'second-opinion', session: 's', requestSha256: 'r', payload: {}, deadlineMs: 5000 });
    expect(r.status).toBe(200);
    const submit = sent.find((c) => c.type === 'metered-gemini-call')!;
    expect(submit.resultTokenHash).toBe(sha256Hex(r.resultToken));
    expect(JSON.stringify(submit)).not.toContain(r.resultToken);
  });

  it('a lost submit acknowledgment still collects the result with one charge', async () => {
    let runs = 0;
    const store = new HolderCallStore({ run: async () => { runs++; return { status: 200, body: { ok: true } }; }, ledgerLookup: () => null });
    let dropAck = true;
    const send = async (_m: string, cmd: Record<string, unknown>) => {
      if (cmd.type === 'metered-gemini-call') { store.submit(cmd as unknown as ForwardedCall); if (dropAck) { dropAck = false; throw new Error('socket hang up'); } }
      await flush();
      return store.poll(cmd.callId as string, cmd.resultToken as string);
    };
    const r = await forwardMeteredCall({ send, holder: () => 'm_studio', originMachine: 'm_mama', sleep: async () => {} }, { op: 'spec-review', session: 's', requestSha256: 'r', payload: {}, deadlineMs: 5000 });
    expect(r.status).toBe(200);
    expect(runs).toBe(1);
  });

  it('no holder → holder-unreachable; an old peer → peer-version; past the deadline → holder-timeout with resume fields', async () => {
    expect((await forwardMeteredCall({ send: async () => ({}), holder: () => null, originMachine: 'm' }, { op: 'second-opinion', session: 's', requestSha256: 'r', payload: {}, deadlineMs: 10 })).body).toMatchObject({ reason: 'holder-unreachable' });
    const old = async () => { throw new Error('403 claim-unauthorized'); };
    expect((await forwardMeteredCall({ send: old, holder: () => 'h', originMachine: 'm', sleep: async () => {} }, { op: 'second-opinion', session: 's', requestSha256: 'r', payload: {}, deadlineMs: 10 })).body).toMatchObject({ reason: 'peer-version' });
    let t = 0;
    const running = async (_m: string, cmd: Record<string, unknown>) => (cmd.type === 'metered-gemini-call' ? { state: 'running' } : { state: 'running' });
    const r = await forwardMeteredCall({ send: running, holder: () => 'h', originMachine: 'm', now: () => t, sleep: async (ms) => { t += ms; } }, { op: 'second-opinion', session: 's', requestSha256: 'r', payload: {}, deadlineMs: 20_000 });
    expect(r.status).toBe(504);
    expect((r.body as { retryWith?: unknown }).retryWith).toEqual({ callId: r.callId, resultToken: r.resultToken });
  });

  it('callId is deterministic in its inputs', () => {
    expect(forwardCallId('a', 'b', 'c', 'd')).toBe(forwardCallId('a', 'b', 'c', 'd'));
    expect(forwardCallId('a', 'b', 'c', 'd')).not.toBe(forwardCallId('a', 'b', 'c', 'e'));
    expect(classifyForwardFailure(new Error('ECONNREFUSED'))).toBe('holder-unreachable');
  });
});

describe('DesignationEchoTracker (lease liveness)', () => {
  const base = (send: (m: string, c: Record<string, unknown>) => Promise<unknown>, now: () => number, extra: Partial<ConstructorParameters<typeof DesignationEchoTracker>[0]> = {}) =>
    new DesignationEchoTracker({ send, peers: () => ['m_mama'], selfMachineId: 'm_studio', keyRef: 'gemini_api_key_payg', designationEpoch: () => 3, onConflict: () => {}, now, ...extra });

  it('an unreadable peer registry (null) is unknown and fences — never single-machine', () => {
    const t = new DesignationEchoTracker({ send: async () => ({}), peers: () => null, selfMachineId: 's', keyRef: 'k', designationEpoch: () => 1, onConflict: () => {} });
    expect(t.leaseConfirmedAgoMs()).toBeNull();
  });

  it('a single-machine agent trivially self-confirms; unknown fences', () => {
    const lone = new DesignationEchoTracker({ send: async () => ({}), peers: () => [], selfMachineId: 's', keyRef: 'k', designationEpoch: () => 1, onConflict: () => {} });
    expect(lone.leaseConfirmedAgoMs()).toBe(0);
    expect(base(async () => ({}), () => 0).leaseConfirmedAgoMs()).toBeNull();
  });

  it('confirms only on an echo of the fresh nonce, timed on the holder clock', async () => {
    let t = 1000;
    const good = base(async (_m, c) => ({ nonce: c.nonce, seen: null }), () => t);
    await good.tick();
    expect(good.leaseConfirmedAgoMs()).toBe(0);
    t += 30_000;
    expect(good.leaseConfirmedAgoMs()).toBe(30_000);
    const stale = base(async () => ({ nonce: 'a'.repeat(32), seen: null }), () => t);
    await stale.tick();
    expect(stale.leaseConfirmedAgoMs()).toBeNull();
  });

  it('an isolated holder is past the 60s window soon after its last confirmation', async () => {
    let t = 0;
    let up = true;
    const tr = base(async (_m, c) => { if (!up) throw new Error('down'); return { nonce: c.nonce }; }, () => t);
    await tr.tick();
    up = false;
    for (let i = 0; i < 10; i++) { t += 10_000; await tr.tick(); }
    expect(tr.leaseConfirmedAgoMs()!).toBeGreaterThan(60_000);
  });

  it('only a one-key-backed claim with a NEWER epoch naming another machine freezes; anything else only signals', async () => {
    const conflicts: unknown[] = [];
    const stale: unknown[] = [];
    const mk = (seen: unknown) => base(async (_m, c) => ({ nonce: c.nonce, seen }), () => 0, { onConflict: (x) => conflicts.push(x), onStaleClaim: (x) => stale.push(x) });
    await mk({ machineId: 'm_studio', designationEpoch: 9, oneKeyBacked: true }).tick();
    await mk({ machineId: 'm_other', designationEpoch: 9, oneKeyBacked: false }).tick();
    await mk({ machineId: 'm_other', designationEpoch: 2, oneKeyBacked: true }).tick();
    expect(conflicts).toHaveLength(0);
    expect(stale).toHaveLength(2);
    await mk({ machineId: 'm_other', designationEpoch: 4, oneKeyBacked: true }).tick();
    expect(conflicts).toHaveLength(1);
  });

  it('peer answer echoes a valid nonce only', () => {
    expect(answerDesignationEcho({ nonce: 'ab'.repeat(16) }, null)).toEqual({ nonce: 'ab'.repeat(16), seen: null });
    expect(answerDesignationEcho({ nonce: 'x' }, null)).toEqual({ error: 'invalid' });
  });

  it('the arming boot check refuses a failover threshold under twice the worst-case fence', () => {
    expect(WORST_CASE_FENCE_MS).toBe(88_000);
    expect(failoverThresholdAllowsArming(175_000)).toBe(false);
    expect(failoverThresholdAllowsArming(176_000)).toBe(true);
    expect(failoverThresholdAllowsArming(15 * 60_000)).toBe(true);
  });
});
