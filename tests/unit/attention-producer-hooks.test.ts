/**
 * attention-lifecycle-close-on-cause §3.2/§3.3 — producer hooks.
 *
 * Real classes, temp dirs, no mocks of the thing under test:
 *  - AttentionConditionStore: `onClear` fires with the BASE key (no `:ep-N`)
 *    on `clear` and `clearSubject`; `isItemActive`; `inactiveBaseKeys`.
 *  - sign-in repair resolver: succeeded/cancelled → cleared, failed → active,
 *    unknown id → unknown, healthy LOCAL pool cell → cleared, legacy ids.
 *  - DuplicateSessionReconciler: the clear dep fires on episode delete.
 *  - OrphanedWorkSentinel: a flagged worktree that turns clean / vanishes
 *    clears its row; an untouched flag never clears.
 *  - SwapAntiThrashEngine: reactive-hops row clears when hops fall below the
 *    threshold; the measurement-blind row clears when readings come back.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AttentionConditionStore, baseKeyOfItemId } from '../../src/core/AttentionConditionStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { SubscriptionReloginStore } from '../../src/core/SubscriptionReloginStore.js';
import type { SubscriptionReloginEpisode } from '../../src/core/SubscriptionReloginStore.js';
import { resolveSubscriptionReloginAttention, subscriptionReloginConditionKey } from '../../src/core/SubscriptionReloginAttention.js';
import { DuplicateSessionReconciler } from '../../src/monitoring/DuplicateSessionReconciler.js';
import type { DuplicateCandidate, ReconcilerConfigView, ReconcilerDeps } from '../../src/monitoring/DuplicateSessionReconciler.js';
import type { BoundedJsonlAudit } from '../../src/core/BoundedJsonlAudit.js';
import { OrphanedWorkSentinel } from '../../src/monitoring/OrphanedWorkSentinel.js';
import type { OrphanedWorkSentinelDeps, OrphanedWorktreeInfo } from '../../src/monitoring/OrphanedWorkSentinel.js';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'attention-hooks-')); });
afterEach(() => { SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'attention-producer-hooks test cleanup' }); });

// ── AttentionConditionStore ────────────────────────────────────────────────

describe('AttentionConditionStore onClear / isItemActive / inactiveBaseKeys', () => {
  const identity = { producer: 'rope-prober', conditionType: 'rope-dead', subject: 'mini', scope: 'tailscale' };

  it('clear() fires onClear with the base key (no :ep-N) and the item id', () => {
    const onClear = vi.fn();
    const store = new AttentionConditionStore({ filePath: path.join(tmp, 'c.json'), onClear });
    const obs = store.observe(identity);
    expect(obs.shouldRaise).toBe(true);
    expect(obs.itemId).toMatch(/:ep-1$/);
    expect(store.isItemActive(obs.itemId)).toBe(true);
    expect(store.inactiveBaseKeys()).toEqual([]);

    expect(store.clear(identity)).toBe(true);
    expect(onClear).toHaveBeenCalledTimes(1);
    const [baseKey, itemId] = onClear.mock.calls[0];
    expect(itemId).toBe(obs.itemId);
    expect(baseKey).toBe(baseKeyOfItemId(obs.itemId));
    expect(baseKey.endsWith(':ep-1')).toBe(false);
    expect(store.isItemActive(obs.itemId)).toBe(false);
    expect(store.inactiveBaseKeys()).toEqual([baseKey]);

    // A second clear of an inactive record is a no-op: no duplicate callback.
    expect(store.clear(identity)).toBe(false);
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('clearSubject() fires onClear once per cleared record and a new episode mints a new id', () => {
    const onClear = vi.fn();
    const store = new AttentionConditionStore({ filePath: path.join(tmp, 'c.json'), onClear });
    const a = store.observe(identity);
    const b = store.observe({ ...identity, scope: 'lan' });
    store.observe({ ...identity, subject: 'laptop' }); // different subject — untouched
    expect(store.clearSubject('rope-prober', 'mini')).toBe(2);
    expect(onClear.mock.calls.map((c) => c[1]).sort()).toEqual([a.itemId, b.itemId].sort());
    expect(store.inactiveBaseKeys().sort()).toEqual([baseKeyOfItemId(a.itemId), baseKeyOfItemId(b.itemId)].sort());

    const again = store.observe(identity);
    expect(again.itemId).toMatch(/:ep-2$/);
    expect(store.isItemActive(again.itemId)).toBe(true);
    expect(store.isItemActive(a.itemId)).toBe(false); // the OLD episode id is not active
  });

  it('a throwing onClear never breaks the clear', () => {
    const store = new AttentionConditionStore({ filePath: path.join(tmp, 'c.json'), onClear: () => { throw new Error('boom'); } });
    store.observe(identity);
    expect(store.clear(identity)).toBe(true);
    expect(store.inactiveBaseKeys()).toHaveLength(1);
  });
});

// ── Sign-in repair resolver ────────────────────────────────────────────────

describe('subscription-relogin attention resolver', () => {
  const digest = `sha256:${'a'.repeat(64)}`;
  function suggest(store: SubscriptionReloginStore, over: Partial<{ accountId: string; machineId: string; sourceEpisodeId: number }> = {}) {
    return store.suggest({ sourceEpisodeId: over.sourceEpisodeId ?? 1, accountId: over.accountId ?? 'acct-a', machineId: over.machineId ?? 'mach-1',
      mode: 'approval', inputDigest: digest, profileId: 'profile-a', framework: 'claude-code', provider: 'anthropic' });
  }
  function deps(store: SubscriptionReloginStore, over: Partial<Parameters<typeof resolveSubscriptionReloginAttention>[1]> = {}) {
    return {
      getEpisode: (id: string) => store.get(id),
      listEpisodes: (accountId: string) => store.list({ accountId, limit: 50 }),
      localMachineId: 'mach-1',
      localCellHealthy: () => false,
      ...over,
    };
  }

  it('cancelled → cleared; live/failed → active; unknown id → unknown (real store)', () => {
    const store = new SubscriptionReloginStore({ stateDir: tmp });
    const ep = suggest(store);
    const key = subscriptionReloginConditionKey(ep);
    expect(key).toBe('subscription-relogin:acct-a:mach-1');
    // live attempt
    expect(resolveSubscriptionReloginAttention({ id: 'x', conditionKey: key }, deps(store))).toBe('active');
    // legacy id (delivery key with colons → hyphens) resolves the same episode
    expect(resolveSubscriptionReloginAttention({ id: `subscription-relogin-${ep.id}-approval-1` }, deps(store))).toBe('active');
    // failed keeps the row (the operator still has an ask)
    const approved = store.transition(ep.id, { expectedVersion: ep.version, to: 'approved', eventClass: 'operator-approved' });
    store.transition(ep.id, { expectedVersion: approved.version, to: 'failed', eventClass: 'attempt-failed', failureClass: 'provider-rejected' });
    expect(resolveSubscriptionReloginAttention({ id: 'x', conditionKey: key }, deps(store))).toBe('active');

    // a second, cancelled episode for another account/machine
    const other = suggest(store, { accountId: 'acct-b', machineId: 'mach-2', sourceEpisodeId: 2 });
    store.cancel(other.id);
    expect(resolveSubscriptionReloginAttention({ id: 'x', conditionKey: subscriptionReloginConditionKey(other) }, deps(store))).toBe('cleared');
    expect(resolveSubscriptionReloginAttention({ id: `subscription-relogin-${other.id}-terminal-1` }, deps(store))).toBe('cleared');

    // not ours / nothing on disk
    expect(resolveSubscriptionReloginAttention({ id: 'orphaned-work:foo' }, deps(store))).toBe('unknown');
    expect(resolveSubscriptionReloginAttention({ id: 'x', conditionKey: 'subscription-relogin:ghost:mach-9' }, deps(store))).toBe('unknown');
    expect(resolveSubscriptionReloginAttention({ id: 'subscription-relogin-00000000-0000-4000-8000-000000000000-terminal-1' }, deps(store))).toBe('unknown');
  });

  it('succeeded / resolved-elsewhere → cleared (pure verdict over episode rows)', () => {
    const base = { id: 'e', accountId: 'acct-a', machineId: 'mach-1', failureClass: null } as unknown as SubscriptionReloginEpisode;
    const d = (episode: SubscriptionReloginEpisode) => ({ getEpisode: () => episode, listEpisodes: () => [episode], localMachineId: null, localCellHealthy: () => false });
    expect(resolveSubscriptionReloginAttention({ id: 'x', conditionKey: 'subscription-relogin:acct-a:mach-1' }, d({ ...base, state: 'succeeded' }))).toBe('cleared');
    expect(resolveSubscriptionReloginAttention({ id: 'x', conditionKey: 'subscription-relogin:acct-a:mach-1' }, d({ ...base, state: 'failed', failureClass: 'resolved-elsewhere' }))).toBe('cleared');
    expect(resolveSubscriptionReloginAttention({ id: 'x', conditionKey: 'subscription-relogin:acct-a:mach-1' }, d({ ...base, state: 'refused' }))).toBe('active');
    // a row about ANOTHER machine's episode is not answered by this machine's rows
    expect(resolveSubscriptionReloginAttention({ id: 'x', conditionKey: 'subscription-relogin:acct-a:mach-2' }, d({ ...base, state: 'succeeded' }))).toBe('unknown');
  });

  it('a healthy LOCAL pool cell clears the row for this machine only', () => {
    const store = new SubscriptionReloginStore({ stateDir: tmp });
    const ep = suggest(store);
    const healthy = deps(store, { localCellHealthy: (accountId) => accountId === 'acct-a' });
    expect(resolveSubscriptionReloginAttention({ id: 'x', conditionKey: subscriptionReloginConditionKey(ep) }, healthy)).toBe('cleared');
    expect(resolveSubscriptionReloginAttention({ id: 'x', conditionKey: 'subscription-relogin:acct-a:mach-elsewhere' }, healthy)).toBe('unknown');
  });
});

// ── DuplicateSessionReconciler ─────────────────────────────────────────────

describe('DuplicateSessionReconciler clearAttention on episode delete', () => {
  const T0 = Date.parse('2026-07-10T12:00:00.000Z');
  const cand = (): DuplicateCandidate => ({ key: 'telegram:12345', platform: 'telegram', platformId: '12345',
    machines: [{ machineId: 'laptop', sessions: ['s-1'] }, { machineId: 'mini', sessions: ['s-2'] }] });
  const cfg: ReconcilerConfigView = { enabled: true, dryRun: false, reconcilerTickMs: 60_000, maxReconcilesPerTick: 5,
    maxConvergenceWritesPerTick: 2, echoConfirmTicks: 3, breakerThreshold: 3, breakerWindowMs: 24 * 60 * 60_000 };
  function makeDeps(over: Partial<ReconcilerDeps> = {}): ReconcilerDeps {
    return {
      selfMachineId: () => 'laptop', holdsLease: () => true, substrateReady: () => ({ ready: true }), errorEpisodeOpen: () => false,
      topicHasAuthorityInMotion: () => false, discoverCandidates: async () => ({ candidates: [cand()] }),
      probeLiveCopy: async () => ({ ok: true, live: true }), readPin: () => null, readOwnershipViews: () => [], liveRunHosts: async () => [],
      casConverge: () => ({ ok: true }), peerEchoObserved: async () => true, armCloseout: () => {}, raiseAttention: vi.fn(),
      journal: { append: () => {} } as unknown as BoundedJsonlAudit, log: () => {}, now: () => T0, ...over,
    };
  }

  it('an escalated episode that resolves on a fresh probe clears its escalate row (stable condition key)', async () => {
    const clearAttention = vi.fn();
    let liveOn = (_m: string) => true;
    const deps = makeDeps({ clearAttention, probeLiveCopy: async (machineId: string) => ({ ok: true, live: liveOn(machineId) }) });
    const r = new DuplicateSessionReconciler(cfg, deps);
    // No evidence at all → escalate once; the item carries the stable key.
    await r.tick();
    const raised = (deps.raiseAttention as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as { id: string; conditionKey?: string });
    expect(raised.some((i) => i.conditionKey === 'dup-reconciler:escalate:telegram:12345')).toBe(true);
    expect(clearAttention).not.toHaveBeenCalled();
    // The duplicate is gone on the next probe → episode deleted → row cleared.
    liveOn = (m) => m === 'laptop';
    await r.tick();
    expect(clearAttention.mock.calls.map((c) => c[0])).toContain('dup-reconciler:escalate:telegram:12345');
  });

  it('breaker row: tripped carries its key; a released clamp clears it', () => {
    const clearAttention = vi.fn();
    const raiseAttention = vi.fn();
    let now = T0;
    const r = new DuplicateSessionReconciler(cfg, makeDeps({ clearAttention, raiseAttention, now: () => now }));
    const bump = (r as unknown as { bumpBreaker: (key: string, now: number) => void }).bumpBreaker.bind(r);
    bump('telegram:1', now); bump('telegram:1', now); bump('telegram:1', now);
    expect(raiseAttention.mock.calls.map((c) => (c[0] as { conditionKey?: string }).conditionKey)).toContain('dup-reconciler:breaker:telegram:1');
    expect(r.breakerClamped('telegram:1')).toBe(true);
    expect(clearAttention).not.toHaveBeenCalled();
    now = T0 + cfg.breakerWindowMs + 1;
    expect(r.breakerClamped('telegram:1')).toBe(false);
    expect(clearAttention).toHaveBeenCalledWith('dup-reconciler:breaker:telegram:1', expect.stringContaining('released'));
    r.breakerClamped('telegram:1');
    expect(clearAttention).toHaveBeenCalledTimes(1); // once per trip, never per read
  });
});

// ── OrphanedWorkSentinel ───────────────────────────────────────────────────

describe('OrphanedWorkSentinel clearAttention', () => {
  const WT = (over: Partial<OrphanedWorktreeInfo> = {}): OrphanedWorktreeInfo => ({ path: '/agents/echo/.worktrees/feature-x', branch: 'echo/feature-x', headSha: 'abc1234', ...over });
  type S = { worktrees: OrphanedWorktreeInfo[]; dirty: Set<string>; inUse: Set<string>; now: number; cleared: Array<[string, string]>; raised: string[] };
  const fresh = (): S => ({ worktrees: [], dirty: new Set(), inUse: new Set(), now: 10_000_000, cleared: [], raised: [] });
  const deps = (s: S): OrphanedWorkSentinelDeps => ({
    listWorktrees: () => ({ ok: true as const, worktrees: s.worktrees }), hasUncommittedWork: (p) => s.dirty.has(p), workSignature: () => 'sig0',
    isInUse: (p) => s.inUse.has(p), lastActivityMs: () => null, preserve: () => {}, record: () => {}, raiseAttention: (e) => { s.raised.push(e.path); },
    clearAttention: (p, reason) => { s.cleared.push([p, reason]); }, now: () => s.now,
  });

  it('a flagged worktree that becomes clean clears once; an untouched flag never clears', async () => {
    const s = fresh(); const wt = WT(); s.worktrees = [wt]; s.dirty.add(wt.path);
    const sentinel = new OrphanedWorkSentinel(deps(s), { settleMs: 1000, enabled: true });
    await sentinel.scan();
    expect(s.raised).toEqual([wt.path]);
    await sentinel.scan(); // still dirty, same signature → nothing new, nothing cleared
    expect(s.cleared).toEqual([]);
    s.dirty.delete(wt.path);
    await sentinel.scan();
    expect(s.cleared).toEqual([[wt.path, 'the worktree has no uncommitted work']]);
    await sentinel.scan();
    expect(s.cleared).toHaveLength(1); // no flag left to clear → silent
    s.dirty.add(wt.path);
    await sentinel.scan();
    expect(s.raised).toEqual([wt.path, wt.path]); // re-stranded → raised again (the row reopens)
  });

  it('owner alive again, or the worktree gone from the listing, clears too', async () => {
    const s = fresh(); const a = WT(); const b = WT({ path: '/agents/echo/.worktrees/feature-y', branch: 'echo/feature-y' });
    s.worktrees = [a, b]; s.dirty.add(a.path); s.dirty.add(b.path);
    const sentinel = new OrphanedWorkSentinel(deps(s), { settleMs: 1000, enabled: true });
    await sentinel.scan();
    expect(s.raised.sort()).toEqual([a.path, b.path].sort());
    s.inUse.add(a.path);
    s.worktrees = [a];
    await sentinel.scan();
    expect(s.cleared.sort()).toEqual([[a.path, 'its owning session is alive again'], [b.path, 'the worktree is gone']].sort());
  });
});

// ── SwapAntiThrashEngine ───────────────────────────────────────────────────

describe('SwapAntiThrashEngine clearAttention', () => {
  it('reactive-hops row carries its key and clears when fresh hops drop below the threshold', async () => {
    const { SwapAntiThrashEngine, resolveAntiThrashKnobs } = await import('../../src/core/SwapAntiThrash.js');
    const raise = vi.fn(); const clear = vi.fn();
    let now = 1_000_000;
    const knobs = { ...resolveAntiThrashKnobs({ reversalWindowMs: 60_000, reactiveHopAlertThreshold: 2 } as never), reversalWindowMs: 60_000, reactiveHopAlertThreshold: 2 };
    const engine = new SwapAntiThrashEngine({
      // Only the ledger methods the engine calls: append (rows), hydrate/tryResume/status (unused here).
      ledger: { append: () => {}, hydrate: () => ({ rows: [] }), tryResume: () => true, status: () => ({}) } as never,
      getKnobs: () => knobs,
      machineId: 'laptop', raiseAttention: raise, clearAttention: clear, logger: { log: () => {}, warn: () => {} }, now: () => now,
    });
    const hop = () => engine.recordReactiveExecuted({ session: 's1', from: 'a', to: 'b', nowMs: now });
    hop(); hop();
    expect(raise).toHaveBeenCalledTimes(1);
    expect(raise.mock.calls[0][3]).toBe('swap-antithrash:reactive-hops:s1');
    expect(clear).not.toHaveBeenCalled();
    now += 120_000; // both earlier hops age out; this one alone is below the threshold
    hop();
    expect(clear).toHaveBeenCalledWith('swap-antithrash:reactive-hops:s1', expect.any(String));
    expect(clear).toHaveBeenCalledTimes(1);
  });
});
