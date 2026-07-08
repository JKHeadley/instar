// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Unit tests — RoutingSpendCapsStore + RenderedPlanStore + PinAttemptStore +
 * SpendAlertResolver (routing-control-room-spend Increment B, Surface 2).
 *
 * Pins: the S-F2 structural regression (money state is OUTSIDE every
 * PATCHABLE_CONFIG_KEYS surface), the C4-4 schema validator as an independent
 * boundary, freeze set-true-only + never version-blocked, before+after audit,
 * the S2-3 smuggle test (a field absent from the render cannot commit), nonce
 * single-use + TTL + version drift, durable PIN lockout across restarts, and
 * the alert resolver's ladder + lifeline fallback + edge-latch discipline.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { RoutingSpendCapsStore, validateCapsFile } from '../../src/core/RoutingSpendCapsStore.js';
import { RenderedPlanStore, PlanCommitError } from '../../src/core/RenderedPlanStore.js';
import { PinAttemptStore } from '../../src/core/PinAttemptStore.js';
import { SpendAlertResolver } from '../../src/core/SpendAlertResolver.js';
import { PATCHABLE_CONFIG_KEYS } from '../../src/server/routes.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsm-'));
});
afterEach(() => {
  SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/routing-spend-money-stores.test.ts' });
});

describe('S-F2 — money state is structurally outside PATCH /config', () => {
  it('routingSpend is NOT a PATCHABLE_CONFIG_KEYS key (a Bearer PATCH can never arm/unfreeze/raise)', () => {
    expect(PATCHABLE_CONFIG_KEYS.has('routingSpend')).toBe(false);
  });
  it('the caps store lives in its own state file, not under config.json', () => {
    const store = new RoutingSpendCapsStore({ stateDir: dir });
    store.freeze('t', 'k1', { provider: 'p', lifetimeCapUsd: 1, dailyCapUsd: 1 });
    expect(fs.existsSync(path.join(dir, 'state', 'routing-spend-caps.json'))).toBe(true);
  });
});

describe('RoutingSpendCapsStore', () => {
  it('deny-by-default: an absent store reads as EMPTY (no doors armed)', () => {
    const store = new RoutingSpendCapsStore({ stateDir: dir });
    const f = store.read();
    expect(Object.keys(f.goLive)).toHaveLength(0);
    expect(f.version).toBe(0);
  });

  it('a PRESENT-but-corrupt store throws (fail closed), never silently defaults', () => {
    fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'state', 'routing-spend-caps.json'), '{corrupt');
    const store = new RoutingSpendCapsStore({ stateDir: dir });
    expect(() => store.read()).toThrow();
    expect(store.version()).toBe(-1); // sentinel no plan can match
  });

  it('every write bumps the version; a mismatched expectedVersion refuses (C5-3)', () => {
    const store = new RoutingSpendCapsStore({ stateDir: dir });
    store.adjustCaps('t', 0, 'k1', 'p', { lifetimeCapUsd: 10, dailyCapUsd: 5 });
    expect(store.version()).toBe(1);
    expect(() => store.adjustCaps('t', 0, 'k1', 'p', { lifetimeCapUsd: 20, dailyCapUsd: 5 })).toThrow(/version drift/);
  });

  it('freeze is set-true-only, records the actor, and is NEVER version-blocked', () => {
    const store = new RoutingSpendCapsStore({ stateDir: dir });
    store.adjustCaps('t', 0, 'k1', 'p', { lifetimeCapUsd: 10, dailyCapUsd: 5 });
    const after = store.freeze('bearer:1.2.3.4', 'k1');
    expect(after.caps.k1.frozen).toBe(true);
    expect(after.caps.k1.frozenBy).toBe('bearer:1.2.3.4');
    // No unfreeze via freeze() — only the PIN path can release.
    const again = store.freeze('bearer:x', 'k1');
    expect(again.caps.k1.frozen).toBe(true);
  });

  it('cap-LOWERING bumps the lease epoch (fenced); raising does not', () => {
    const store = new RoutingSpendCapsStore({ stateDir: dir });
    store.adjustCaps('t', 0, 'k1', 'p', { lifetimeCapUsd: 10, dailyCapUsd: 5 });
    const raised = store.adjustCaps('t', 1, 'k1', 'p', { lifetimeCapUsd: 20, dailyCapUsd: 5 });
    const epochAfterRaise = raised.leaseEpoch;
    const lowered = store.adjustCaps('t', 2, 'k1', 'p', { lifetimeCapUsd: 5, dailyCapUsd: 5 });
    expect(lowered.leaseEpoch).toBe(epochAfterRaise + 1);
  });

  it('audit rows carry canonical BEFORE and AFTER state (C4-4)', () => {
    const store = new RoutingSpendCapsStore({ stateDir: dir });
    store.adjustCaps('t', 0, 'k1', 'p', { lifetimeCapUsd: 10, dailyCapUsd: 5 });
    const log = store.auditLog();
    expect(log).toHaveLength(1);
    expect(log[0].before.version).toBe(0);
    expect(log[0].after.caps.k1.lifetimeCapUsd).toBe(10);
  });

  it('C4-4: the schema validator independently rejects malformed money records', () => {
    expect(validateCapsFile({ version: 1, leaseEpoch: 0, caps: { k: { provider: 'p', lifetimeCapUsd: -1, dailyCapUsd: 1, frozen: false } }, goLive: {} })).toMatch(/lifetimeCapUsd/);
    expect(validateCapsFile({ version: 1, leaseEpoch: 0, caps: {}, goLive: { d: { enabled: true, keyRef: '', designatedMachineId: 'm', epoch: 0 } } })).toMatch(/keyRef/);
    expect(validateCapsFile({ version: 1, leaseEpoch: 0, caps: {}, goLive: {} })).toBeNull();
  });

  it('knownKeyRefs/knownDoors clamp writes to real keys/doors', () => {
    const store = new RoutingSpendCapsStore({ stateDir: dir, knownKeyRefs: new Set(['real_key']), knownDoors: new Set(['real-door']) });
    expect(() => store.adjustCaps('t', 0, 'fake_key', 'p', { lifetimeCapUsd: 1, dailyCapUsd: 1 })).toThrow(/unknown keyRef/);
  });
});

describe('RenderedPlanStore — S2-3/C3-4', () => {
  it('commit returns EXACTLY the rendered fields (a smuggled request field cannot land)', () => {
    const store = new RenderedPlanStore();
    const plan = store.render('caps-adjust', 'text', { keyRef: 'k', lifetimeCapUsd: 10 }, { capsStore: 3 });
    const committed = store.commit(plan.planId, plan.nonce, { capsStore: 3 });
    expect(committed.fields).toEqual({ keyRef: 'k', lifetimeCapUsd: 10 });
    // The commit surface takes only (planId, nonce) — there is no parameter through
    // which extra request fields could reach the apply step. Structural by shape.
  });

  it('nonce is single-use — a second commit refuses (no replay)', () => {
    const store = new RenderedPlanStore();
    const plan = store.render('go-live', 't', { door: 'd' }, { capsStore: 1 });
    store.commit(plan.planId, plan.nonce, { capsStore: 1 });
    expect(() => store.commit(plan.planId, plan.nonce, { capsStore: 1 })).toThrow(PlanCommitError);
  });

  it('an expired plan refuses; a fresh render is required', () => {
    let t = 1000;
    const store = new RenderedPlanStore({ now: () => t, ttlMs: 500 });
    const plan = store.render('unfreeze', 't', { keyRef: 'k' }, { capsStore: 1 });
    t += 501;
    expect(() => store.commit(plan.planId, plan.nonce, { capsStore: 1 })).toThrow(/expired/);
  });

  it('version drift refuses deterministically (approve-what-you-saw)', () => {
    const store = new RenderedPlanStore();
    const plan = store.render('caps-adjust', 't', { keyRef: 'k' }, { capsStore: 1 });
    expect(() => store.commit(plan.planId, plan.nonce, { capsStore: 2 })).toThrow(/changed since the plan was rendered/);
  });

  it('a wrong nonce refuses', () => {
    const store = new RenderedPlanStore();
    const plan = store.render('caps-adjust', 't', { keyRef: 'k' }, { capsStore: 1 });
    expect(() => store.commit(plan.planId, 'wrong', { capsStore: 1 })).toThrow(/nonce/);
  });
});

describe('PinAttemptStore — durable lockout (S2-1)', () => {
  it('lockout survives a restart (the whole point)', () => {
    let t = 1_000_000;
    const a = new PinAttemptStore({ stateDir: dir, maxAttempts: 3, now: () => t });
    a.recordFailure('1.2.3.4');
    a.recordFailure('1.2.3.4');
    a.recordFailure('1.2.3.4');
    expect(a.blocked('1.2.3.4')).toBe(true);
    const b = new PinAttemptStore({ stateDir: dir, maxAttempts: 3, now: () => t }); // "restart"
    expect(b.blocked('1.2.3.4')).toBe(true);
  });

  it('the window expiry clears the counter; success clears immediately', () => {
    let t = 1_000_000;
    const a = new PinAttemptStore({ stateDir: dir, maxAttempts: 2, windowMs: 100, now: () => t });
    a.recordFailure('ip1');
    a.recordFailure('ip1');
    expect(a.blocked('ip1')).toBe(true);
    t += 101;
    expect(a.blocked('ip1')).toBe(false);
    a.recordFailure('ip2');
    a.recordSuccess('ip2');
    expect(a.blocked('ip2')).toBe(false);
  });
});

describe('SpendAlertResolver — ladder + lifeline fallback + edge latch', () => {
  function deps(over: Partial<import('../../src/core/SpendAlertResolver.js').SpendAlertResolverDeps> = {}) {
    const sent: Array<{ topicId: number; text: string }> = [];
    const d = {
      configuredTopicId: () => undefined as number | undefined,
      readPersistedTopicId: () => undefined as number | undefined,
      persistTopicId: () => {},
      servingLeaseConfirmedAgoMs: () => 0 as number | null,
      createTopic: async () => 777,
      sendToTopic: async (topicId: number, text: string) => {
        sent.push({ topicId, text });
        return true;
      },
      lifelineTopicId: () => 999 as number | undefined,
      ...over,
    };
    return { d, sent };
  }
  const ALERT = { kind: 'stale-price' as const, dedupeKey: 'k', text: 'msg' };

  it('rung 1: a configured id wins — nothing is created', async () => {
    let created = 0;
    const { d, sent } = deps({ configuredTopicId: () => 42, createTopic: async () => { created++; return 1; } });
    const r = new SpendAlertResolver(d);
    expect(await r.emit(ALERT)).toBe('sent');
    expect(sent[0].topicId).toBe(42);
    expect(created).toBe(0);
  });

  it('rung 2: a persisted id wins over creation', async () => {
    const { d, sent } = deps({ readPersistedTopicId: () => 55 });
    const r = new SpendAlertResolver(d);
    await r.emit(ALERT);
    expect(sent[0].topicId).toBe(55);
  });

  it('rung 3: a CONFIRMED serving-lease holder creates ONCE (single-flight) and persists', async () => {
    let created = 0;
    let persisted: number | undefined;
    const { d, sent } = deps({
      createTopic: async () => { created++; return 777; },
      persistTopicId: (id) => { persisted = id; },
    });
    const r = new SpendAlertResolver(d);
    await Promise.all([r.emit({ ...ALERT, dedupeKey: 'a' }), r.emit({ ...ALERT, dedupeKey: 'b' })]);
    expect(created).toBe(1); // burst of first-alerts → exactly one createForumTopic
    expect(persisted).toBe(777);
    expect(sent.every((s) => s.topicId === 777)).toBe(true);
  });

  it('an UNCONFIRMED holder never creates — falls back to the lifeline', async () => {
    let created = 0;
    const { d, sent } = deps({ servingLeaseConfirmedAgoMs: () => null, createTopic: async () => { created++; return 1; } });
    const r = new SpendAlertResolver(d);
    expect(await r.emit(ALERT)).toBe('sent-lifeline');
    expect(created).toBe(0);
    expect(sent[0].topicId).toBe(999);
  });

  it('a failed dedicated send falls back to the lifeline (a set-but-wrong id is not a black hole)', async () => {
    const { d, sent } = deps({
      configuredTopicId: () => 42,
      sendToTopic: async (topicId: number, text: string) => {
        if (topicId === 42) throw new Error('topic deleted');
        sent.push({ topicId, text });
        return true;
      },
    });
    const r = new SpendAlertResolver(d);
    expect(await r.emit(ALERT)).toBe('sent-lifeline');
    expect(sent[0].topicId).toBe(999);
  });

  it('edge latch: a CONFIRMED emission suppresses re-sends; a FAILED one stays eligible', async () => {
    let t = 1_000_000;
    let fail = true;
    const { d } = deps({
      configuredTopicId: () => 42,
      lifelineTopicId: () => undefined,
      sendToTopic: async () => {
        if (fail) throw new Error('down');
        return true;
      },
      now: () => t,
    });
    const r = new SpendAlertResolver(d);
    expect(await r.emit(ALERT)).toBe('failed'); // transient failure — NOT latched
    fail = false;
    expect(await r.emit(ALERT)).toBe('sent'); // still eligible, now latches
    expect(await r.emit(ALERT)).toBe('suppressed'); // deduped within the re-arm window
    t += 25 * 60 * 60 * 1000;
    expect(await r.emit(ALERT)).toBe('sent'); // re-armed after the window
  });
});
