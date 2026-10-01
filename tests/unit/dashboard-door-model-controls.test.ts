/**
 * Unit — dashboard door + model controls (docs/specs/dashboard-door-model-controls.md §5).
 *
 * Covers, each on both sides of its decision boundary:
 *  - options derivation: enabled ∩ supported, deny-set subtraction, the
 *    null-model option (incl. pi-cli's empty list), tri-state availability
 *    (verified / assumed = fail-open / unavailable), defaultModel normalization;
 *  - validation parity: every `selectable` option passes the write predicate,
 *    every non-selectable one is refused;
 *  - TopicProfileStore.mutateIfAbsent atomicity + `present` on a husk + double submit;
 *  - the seed service's regime filter (model DROPPED + audited, never shadowed);
 *  - the pool seam predicate, claim and settle;
 *  - the spawn thunk's guard contract;
 *  - NewTopicDefaultStore; the CLAUDE.md template line + its own migration sniff.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { TopicProfileStore } from '../../src/core/TopicProfileStore.js';
import { TopicProfileResolver } from '../../src/core/TopicProfileResolver.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { PER_TOKEN_LANE_MODEL_IDS } from '../../src/core/topicProfileValidation.js';
import { KNOWN_MODEL_IDS } from '../../src/core/ModelTierEscalation.js';
import { PostUpdateMigrator, type MigrationResult } from '../../src/core/PostUpdateMigrator.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import {
  buildTopicProfileOptions,
  validateDashboardProfileChoice,
  seedTopicProfileAtCreation,
  NewTopicDefaultStore,
  evaluateSessionPoolLocalClaim,
  claimDashboardCreatedTopic,
  settleDashboardCreatedTopic,
  createSpawnForTopic,
  type DashboardChoiceDeps,
  type ReadyPoolClaimOps,
} from '../../src/core/dashboardTopicProfile.js';
import type { ProfileWriteRegime } from '../../src/core/topicProfileWriteSurface.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-door-model-unit-'));
  fs.mkdirSync(path.join(tmpDir, 'state'), { recursive: true });
});
afterEach(() => {
  SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/dashboard-door-model-controls:cleanup' });
});

function makeStore(): TopicProfileStore {
  return new TopicProfileStore({ stateFilePath: path.join(tmpDir, 'state', 'topic-profiles.json'), isDryRun: () => false });
}

/** A resolver whose door binaries map to: a real file (verified), a missing path (unavailable), or null (assumed). */
function makeResolver(store: TopicProfileStore, bins: Record<string, string | null>): TopicProfileResolver {
  return new TopicProfileResolver({
    store,
    defaultFramework: () => 'claude-code',
    configTopicFrameworks: () => ({}),
    configProfileDefaults: () => ({}),
    frameworkDefaultModels: () => ({}),
    tierEscalationConfig: () => undefined,
    localModelBinding: () => null,
    frameworkBinaryPath: (fw) => (fw in bins ? bins[fw] : null),
  });
}

const PRESENT = process.execPath; // exists on every test machine
const MISSING = '/nonexistent/instar-test/bin/codex';

function deps(resolver: TopicProfileResolver, enabled?: string[]): DashboardChoiceDeps {
  return { enabledFrameworks: () => enabled, doorAdmissibility: (fw) => resolver.doorAdmissibility(fw) };
}

const FULLY_LIVE: ProfileWriteRegime = { enabled: true, dryRun: false };

describe('TopicProfileResolver.doorAdmissibility — tri-state', () => {
  it('verified when the probe found the binary, unavailable when it provably did not, assumed when it fell open', () => {
    const r = makeResolver(makeStore(), { 'claude-code': PRESENT, 'codex-cli': MISSING, 'gemini-cli': null });
    expect(r.doorAdmissibility('claude-code')).toEqual({ availability: 'verified', reason: null });
    expect(r.doorAdmissibility('codex-cli')).toEqual({ availability: 'unavailable', reason: 'framework-unlaunchable' });
    expect(r.doorAdmissibility('gemini-cli')).toEqual({ availability: 'assumed', reason: null });
  });

  it('the private binary callers keep fail-open semantics: an assumed door pin still resolves to the pin', async () => {
    const store = makeStore();
    const r = makeResolver(store, { 'gemini-cli': null, 'codex-cli': MISSING });
    await store.mutate('5', { framework: 'gemini-cli', updatedBy: 'api-token' });
    expect(r.resolve('5').framework).toBe('gemini-cli');
    await store.mutate('6', { framework: 'codex-cli', updatedBy: 'api-token' });
    const unavailable = r.resolve('6');
    expect(unavailable.framework).toBe('claude-code');
    expect(unavailable.notices.join(' ')).toContain('isn\'t launchable here');
  });
});

describe('buildTopicProfileOptions (§3.1)', () => {
  const opts = (resolver: TopicProfileResolver, extra: Partial<Parameters<typeof buildTopicProfileOptions>[0]> = {}) =>
    buildTopicProfileOptions({
      ...deps(resolver),
      frameworkDefaultModels: () => ({}),
      regime: () => FULLY_LIVE,
      newTopicDefault: () => null,
      ...extra,
    });

  it('inventory = enabledFrameworks ∩ supported (all supported when unset)', () => {
    const r = makeResolver(makeStore(), {});
    expect(opts(r).doors.map(d => d.framework)).toEqual(['claude-code', 'codex-cli', 'gemini-cli', 'pi-cli', 'grok-build']);
    const narrowed = opts(r, { enabledFrameworks: () => ['codex-cli', 'claude-code', 'not-a-door'] });
    expect(narrowed.doors.map(d => d.framework)).toEqual(['claude-code', 'codex-cli']);
  });

  it('models = known ids minus the per-token deny set; pi-cli has an empty list but the null model stays selectable', () => {
    const r = makeResolver(makeStore(), {});
    const denied = KNOWN_MODEL_IDS['codex-cli'][0];
    const original = PER_TOKEN_LANE_MODEL_IDS['codex-cli'];
    PER_TOKEN_LANE_MODEL_IDS['codex-cli'] = [denied];
    try {
      const codex = opts(r).doors.find(d => d.framework === 'codex-cli')!;
      expect(codex.models).not.toContain(denied);
      expect(codex.models.length).toBe(KNOWN_MODEL_IDS['codex-cli'].length - 1);
    } finally {
      PER_TOKEN_LANE_MODEL_IDS['codex-cli'] = original;
    }
    const pi = opts(r).doors.find(d => d.framework === 'pi-cli')!;
    expect(pi.models).toEqual([]);
    expect(pi.selectable).toBe(true);
  });

  it('an unavailable door is listed (never hidden), non-selectable, chatOnly, with its reason', () => {
    const r = makeResolver(makeStore(), { 'codex-cli': MISSING, 'claude-code': PRESENT });
    const codex = opts(r).doors.find(d => d.framework === 'codex-cli')!;
    expect(codex).toMatchObject({ available: false, availability: 'unavailable', selectable: false, chatOnly: true });
    expect(codex.reason).toContain('isn\'t installed on this machine');
    expect(codex.models).toEqual([]);
    const claude = opts(r).doors.find(d => d.framework === 'claude-code')!;
    expect(claude).toMatchObject({ available: true, availability: 'verified', selectable: true });
    expect(claude.chatOnly).toBeUndefined();
  });

  it('assumed doors are offered (fail-open), reported as assumed', () => {
    const r = makeResolver(makeStore(), {});
    const gemini = opts(r).doors.find(d => d.framework === 'gemini-cli')!;
    expect(gemini).toMatchObject({ available: true, availability: 'assumed', selectable: true });
  });

  it('defaultModel is normalized: a valid configured default is reported, an unknown one is null + defaultModelDropped', () => {
    const r = makeResolver(makeStore(), {});
    const good = KNOWN_MODEL_IDS['codex-cli'][0];
    const o = opts(r, { frameworkDefaultModels: () => ({ 'codex-cli': good, 'claude-code': 'claude-made-up-9' }) });
    expect(o.doors.find(d => d.framework === 'codex-cli')!.defaultModel).toBe(good);
    const claude = o.doors.find(d => d.framework === 'claude-code')!;
    expect(claude.defaultModel).toBeNull();
    expect(claude.defaultModelDropped).toContain('not a known claude-code model id');
  });

  it('regime + newTopicDefault (replication is the literal local-only)', () => {
    const r = makeResolver(makeStore(), {});
    expect(opts(r, { regime: () => ({ enabled: false, dryRun: true }) }).regime).toBe('disabled');
    expect(opts(r, { regime: () => ({ enabled: true, dryRun: true }) }).regime).toBe('dry-run');
    const withDef = opts(r, { newTopicDefault: () => ({ framework: 'codex-cli', model: null, updatedAt: 't', updatedBy: 'api-token' }) });
    expect(withDef.regime).toBe('fully-live');
    expect(withDef.newTopicDefault).toEqual({ framework: 'codex-cli', model: null, updatedAt: 't', updatedBy: 'api-token', replication: 'local-only' });
  });

  it('validation parity: every selectable option passes the write check; every non-selectable one is refused', () => {
    const r = makeResolver(makeStore(), { 'codex-cli': MISSING, 'claude-code': PRESENT });
    const d = deps(r, ['claude-code', 'codex-cli', 'gemini-cli', 'pi-cli']);
    const o = buildTopicProfileOptions({ ...d, frameworkDefaultModels: () => ({}), regime: () => FULLY_LIVE, newTopicDefault: () => null });
    let checked = 0;
    for (const door of o.doors) {
      expect(validateDashboardProfileChoice(d, { framework: door.framework, model: null }).ok).toBe(door.selectable);
      for (const m of door.models) {
        expect(validateDashboardProfileChoice(d, { framework: door.framework, model: m }).ok).toBe(true);
        checked++;
      }
      for (const m of KNOWN_MODEL_IDS[door.framework as keyof typeof KNOWN_MODEL_IDS] ?? []) {
        if (!door.models.includes(m)) expect(validateDashboardProfileChoice(d, { framework: door.framework, model: m }).ok).toBe(false);
      }
    }
    expect(checked).toBeGreaterThan(0);
    // Not in the inventory ⇒ refused.
    expect(validateDashboardProfileChoice(d, { framework: 'grok-build', model: null })).toMatchObject({ ok: false, code: 'framework-not-enabled' });
  });
});

describe('validateDashboardProfileChoice (§3.5)', () => {
  it('refuses unavailable doors with a machine-readable divergence code; accepts verified + assumed', () => {
    const r = makeResolver(makeStore(), { 'codex-cli': MISSING, 'claude-code': PRESENT });
    const d = deps(r);
    const refused = validateDashboardProfileChoice(d, { framework: 'codex-cli', model: null });
    expect(refused).toEqual({
      ok: false,
      code: 'dashboard-unavailable-door',
      chatPinAllowed: true,
      reason: 'Codex CLI isn\'t installed on this machine — you can still pin it in chat and it will fall back with a notice',
    });
    expect(validateDashboardProfileChoice(d, { framework: 'claude-code', model: null }).ok).toBe(true);
    expect(validateDashboardProfileChoice(d, { framework: 'gemini-cli', model: null }).ok).toBe(true);
  });

  it('refuses off-enum framework / model and a non-string model', () => {
    const d = deps(makeResolver(makeStore(), {}));
    expect(validateDashboardProfileChoice(d, { framework: 'vim' })).toMatchObject({ ok: false, code: 'invalid-framework' });
    expect(validateDashboardProfileChoice(d, { framework: undefined, model: 'x' })).toMatchObject({ ok: false, code: 'invalid-framework' });
    expect(validateDashboardProfileChoice(d, { framework: 'claude-code', model: 'gpt-6-astra' })).toMatchObject({ ok: false, code: 'invalid-model' });
    expect(validateDashboardProfileChoice(d, { framework: 'claude-code', model: 42 })).toMatchObject({ ok: false, code: 'invalid-model' });
  });
});

describe('TopicProfileStore.mutateIfAbsent', () => {
  it('seeds only when no entry exists; previous is null; a second seed answers present', async () => {
    const store = makeStore();
    expect(await store.mutateIfAbsent('10', { framework: 'codex-cli', model: 'gpt-6-astra', updatedBy: 'system:dashboard-create' })).toBe('seeded');
    expect(store.get('10')).toMatchObject({ previous: null, current: { framework: 'codex-cli', model: 'gpt-6-astra', updatedBy: 'system:dashboard-create' } });
    expect(await store.mutateIfAbsent('10', { framework: 'claude-code', updatedBy: 'system:dashboard-create' })).toBe('present');
    expect(store.resolve('10')?.framework).toBe('codex-cli');
    // Durable: a second store instance reads the seed.
    expect(makeStore().resolve('10')?.model).toBe('gpt-6-astra');
  });

  it('a current:null husk counts as present', async () => {
    const store = makeStore();
    await store.replaceEntry('11', { current: null });
    expect(store.get('11')?.current).toBeNull();
    expect(await store.mutateIfAbsent('11', { framework: 'codex-cli', updatedBy: 'system:new-topic-default' })).toBe('present');
    expect(store.resolve('11')).toBeNull();
  });

  it('is atomic under concurrency — exactly one of N simultaneous seeds wins', async () => {
    const store = makeStore();
    const results = await Promise.all(
      ['claude-code', 'codex-cli', 'gemini-cli', 'pi-cli'].map(fw =>
        store.mutateIfAbsent('12', { framework: fw as 'claude-code', updatedBy: 'system:dashboard-create' })),
    );
    expect(results.filter(r => r === 'seeded')).toHaveLength(1);
    expect(results.filter(r => r === 'present')).toHaveLength(3);
  });

  it('a model-only seed is never written without a framework (omits model when null)', async () => {
    const store = makeStore();
    await store.mutateIfAbsent('13', { framework: 'claude-code', model: null, updatedBy: 'system:dashboard-create' });
    expect(store.resolve('13')).not.toHaveProperty('model');
  });
});

describe('seedTopicProfileAtCreation (§3.2)', () => {
  function seedDeps(store: TopicProfileStore, regime: ProfileWriteRegime) {
    const audits: Array<Record<string, unknown>> = [];
    const disclosed: Array<{ key: string; text: string }> = [];
    const resolver = makeResolver(store, { 'claude-code': PRESENT, 'codex-cli': PRESENT });
    return {
      audits,
      disclosed,
      deps: {
        ...deps(resolver),
        store,
        regime: () => regime,
        audit: (e: Record<string, unknown>) => { audits.push(e); },
        disclose: async (key: string, text: string) => { disclosed.push({ key, text }); },
      },
    };
  }

  it('fully-live: writes framework + model, audits, posts ONE disclosure line', async () => {
    const store = makeStore();
    const t = seedDeps(store, FULLY_LIVE);
    const r = await seedTopicProfileAtCreation(t.deps, '20', 'dashboard-create', { framework: 'codex-cli', model: 'gpt-6-astra' });
    expect(r).toEqual({ outcome: 'seeded', framework: 'codex-cli', model: 'gpt-6-astra', modelDropped: null });
    expect(store.resolve('20')).toMatchObject({ framework: 'codex-cli', model: 'gpt-6-astra', updatedBy: 'system:dashboard-create' });
    expect(t.disclosed).toEqual([{ key: '20', text: 'This topic starts on Codex CLI · gpt-6-astra — chosen at creation' }]);
    expect(t.audits).toEqual([expect.objectContaining({ type: 'creation-seed', outcome: 'seeded', topic: '20', principal: 'system:dashboard-create', model: 'gpt-6-astra' })]);
  });

  it.each([
    [{ enabled: true, dryRun: true }, 'dry-run'],
    [{ enabled: false, dryRun: true }, 'disabled'],
  ] as const)('regime %j: the model axis is DROPPED (never shadowed) and audited as model-not-applied', async (regime, name) => {
    const store = makeStore();
    const t = seedDeps(store, regime);
    const r = await seedTopicProfileAtCreation(t.deps, '21', 'new-topic-default', { framework: 'codex-cli', model: 'gpt-6-astra' });
    expect(r).toMatchObject({ outcome: 'seeded', model: null, modelDropped: name });
    expect(store.resolve('21')).toEqual(expect.objectContaining({ framework: 'codex-cli', updatedBy: 'system:new-topic-default' }));
    expect(store.resolve('21')).not.toHaveProperty('model');
    expect(store.get('21')?.intendedProfile).toBeNull();
    expect(t.audits[0]).toMatchObject({ note: `model-not-applied:${name}`, droppedModel: 'gpt-6-astra' });
    expect(t.disclosed[0].text).toBe('This topic starts on Codex CLI — chosen at creation (model not applied on this install)');
  });

  it('present (husk or prior seed): no write, no disclosure, audit says present', async () => {
    const store = makeStore();
    const t = seedDeps(store, FULLY_LIVE);
    await seedTopicProfileAtCreation(t.deps, '22', 'dashboard-create', { framework: 'codex-cli', model: null });
    const again = await seedTopicProfileAtCreation(t.deps, '22', 'dashboard-create', { framework: 'claude-code', model: null });
    expect(again).toEqual({ outcome: 'present' });
    expect(t.disclosed).toHaveLength(1);
    expect(t.audits[1]).toMatchObject({ outcome: 'present' });
    expect(store.resolve('22')?.framework).toBe('codex-cli');
  });

  it('validation lives INSIDE the service: an invalid choice is refused before any write', async () => {
    const store = makeStore();
    const t = seedDeps(store, FULLY_LIVE);
    const r = await seedTopicProfileAtCreation(t.deps, '23', 'dashboard-create', { framework: 'claude-code', model: 'gpt-6-astra' });
    expect(r).toMatchObject({ outcome: 'refused', code: 'invalid-model' });
    expect(store.get('23')).toBeNull();
    expect(t.disclosed).toEqual([]);
  });

  it('a failing disclosure never fails the seed', async () => {
    const store = makeStore();
    const t = seedDeps(store, FULLY_LIVE);
    const r = await seedTopicProfileAtCreation({ ...t.deps, disclose: async () => { throw new Error('held'); } }, '24', 'dashboard-create', { framework: 'claude-code' });
    expect(r.outcome).toBe('seeded');
  });
});

describe('pool seam (§3.3 2b)', () => {
  function ops(log: string[], placeOk = true): ReadyPoolClaimOps {
    return {
      place: (sk) => { log.push(`place:${sk}`); return placeOk ? { ok: true } : { ok: false, reason: 'not-released' }; },
      confirm: (sk) => { log.push(`confirm:${sk}`); return true; },
      release: (sk) => { log.push(`release:${sk}`); return true; },
    };
  }
  const holder = () => ({ machineId: 'm-b', nickname: 'Laptop' });

  it('dark when the router is not live', () => {
    expect(evaluateSessionPoolLocalClaim({ routerLive: () => false, replicationOn: true, holdsLease: () => true, holder, ops: ops([]) })).toEqual({ kind: 'dark' });
  });

  it('router-live with NO lease accessor is not-authoritative with a null holder (never the fail-open true)', () => {
    expect(evaluateSessionPoolLocalClaim({ routerLive: () => true, replicationOn: true, holdsLease: null, holder, ops: ops([]) }))
      .toEqual({ kind: 'not-authoritative', holderMachineId: null, holderNickname: null });
  });

  it('replication off, or not the lease holder ⇒ not-authoritative naming the holder', () => {
    expect(evaluateSessionPoolLocalClaim({ routerLive: () => true, replicationOn: false, holdsLease: () => true, holder, ops: ops([]) }))
      .toEqual({ kind: 'not-authoritative', holderMachineId: 'm-b', holderNickname: 'Laptop' });
    expect(evaluateSessionPoolLocalClaim({ routerLive: () => true, replicationOn: true, holdsLease: () => false, holder, ops: ops([]) }))
      .toEqual({ kind: 'not-authoritative', holderMachineId: 'm-b', holderNickname: 'Laptop' });
  });

  it('ready only when router-live AND replication on AND holding the lease', () => {
    expect(evaluateSessionPoolLocalClaim({ routerLive: () => true, replicationOn: true, holdsLease: () => true, holder, ops: ops([]) }).kind).toBe('ready');
  });

  it('claim re-evaluates the seam; settle uses the SAME ops: spawn-threw ⇒ release, otherwise confirm', () => {
    const log: string[] = [];
    let leaseHeld = true;
    const seam = () => evaluateSessionPoolLocalClaim({ routerLive: () => true, replicationOn: true, holdsLease: () => leaseHeld, holder, ops: ops(log) });
    const claim = claimDashboardCreatedTopic(seam, '30');
    expect(claim.kind).toBe('placed');
    leaseHeld = false; // lease moves after place — settle must still confirm with the placing ops
    expect(settleDashboardCreatedTopic(claim, '30', 'spawned')).toBe('confirmed');
    expect(settleDashboardCreatedTopic(claim, '30', 'spawn-threw')).toBe('released');
    expect(settleDashboardCreatedTopic(claim, '30', 'register-failed')).toBe('confirmed');
    expect(settleDashboardCreatedTopic(claim, '30', 'spawn-in-flight')).toBe('confirmed');
    expect(log).toEqual(['place:30', 'confirm:30', 'release:30', 'confirm:30', 'confirm:30']);
    // A lease that moved BEFORE place ⇒ not-authoritative, nothing placed.
    expect(claimDashboardCreatedTopic(seam, '31')).toMatchObject({ kind: 'not-authoritative', holderNickname: 'Laptop' });
    expect(log).not.toContain('place:31');
  });

  it('refused place ⇒ refused; dark / absent seam ⇒ dark and nothing to settle', () => {
    const log: string[] = [];
    const seam = () => evaluateSessionPoolLocalClaim({ routerLive: () => true, replicationOn: true, holdsLease: () => true, holder, ops: ops(log, false) });
    expect(claimDashboardCreatedTopic(seam, '32')).toEqual({ kind: 'refused', reason: 'not-released' });
    const dark = claimDashboardCreatedTopic(undefined, '33');
    expect(dark).toEqual({ kind: 'dark' });
    expect(settleDashboardCreatedTopic(dark, '33', 'spawn-threw')).toBe('none');
  });
});

describe('createSpawnForTopic (§3.3 steps 4+5)', () => {
  function guard() {
    const live = new Map<number, string>();
    let n = 0;
    return {
      live,
      has: (t: number) => live.has(t),
      add: (t: number) => { const tok = `t${++n}`; live.set(t, tok); return tok; },
      clear: (t: number, tok: string) => { if (live.get(t) === tok) live.delete(t); },
    };
  }
  function tg(mapped: Record<number, string> = {}) {
    const registered: Array<[number, string, string | undefined]> = [];
    return {
      registered,
      getSessionForTopic: (t: number) => mapped[t] ?? null,
      registerTopicSession: (t: number, s: string, name?: string) => { registered.push([t, s, name]); },
    };
  }

  it('null guard or adapter ⇒ telegram-routing-not-wired, nothing spawned', async () => {
    let spawned = 0;
    const f = createSpawnForTopic({ guard: () => null, telegram: () => tg(), spawn: async () => { spawned++; return 's'; } });
    expect(await f(1, 'n')).toEqual({ ok: false, code: 'telegram-routing-not-wired' });
    expect(spawned).toBe(0);
  });

  it('a topic with a registered session ⇒ topic-has-session; one mid-spawn ⇒ topic-spawning', async () => {
    const g = guard();
    g.add(2);
    const f = createSpawnForTopic({ guard: () => g, telegram: () => tg({ 1: 'existing' }), spawn: async () => 'x' });
    expect(await f(1, 'n')).toEqual({ ok: false, code: 'topic-has-session' });
    expect(await f(2, 'n')).toEqual({ ok: false, code: 'topic-spawning' });
  });

  it('spawn + register run under ONE token, cleared in finally', async () => {
    const g = guard();
    const t = tg();
    let heldDuringSpawn = false;
    const f = createSpawnForTopic({ guard: () => g, telegram: () => t, spawn: async (id) => { heldDuringSpawn = g.has(id); return 'sess-3'; } });
    expect(await f(3, 'my topic')).toEqual({ ok: true, session: 'sess-3', registered: true });
    expect(heldDuringSpawn).toBe(true);
    expect(t.registered).toEqual([[3, 'sess-3', 'my topic']]);
    expect(g.has(3)).toBe(false);
  });

  it('a spawn throw propagates and still clears the guard; a register throw reports registered:false', async () => {
    const g = guard();
    const boom = createSpawnForTopic({ guard: () => g, telegram: () => tg(), spawn: async () => { throw new Error('spawn died'); } });
    await expect(boom(4, 'n')).rejects.toThrow('spawn died');
    expect(g.has(4)).toBe(false);
    const badTg = { getSessionForTopic: () => null, registerTopicSession: () => { throw new Error('adapter down'); } };
    const f = createSpawnForTopic({ guard: () => g, telegram: () => badTg, spawn: async () => 'sess-5' });
    expect(await f(5, 'n')).toEqual({ ok: true, session: 'sess-5', registered: false, registerError: 'adapter down' });
    expect(g.has(5)).toBe(false);
  });
});

describe('NewTopicDefaultStore', () => {
  it('absent ⇒ null; write/read round-trips; clear deletes; corrupt/invalid ⇒ null', () => {
    const s = new NewTopicDefaultStore(tmpDir);
    expect(s.read()).toBeNull();
    s.write({ framework: 'codex-cli', model: 'gpt-6-astra', updatedAt: '2026-09-27T00:00:00.000Z', updatedBy: 'api-token' });
    expect(s.read()).toEqual({ framework: 'codex-cli', model: 'gpt-6-astra', updatedAt: '2026-09-27T00:00:00.000Z', updatedBy: 'api-token' });
    expect(s.clear()).toBe(true);
    expect(fs.existsSync(s.filePath)).toBe(false);
    expect(s.clear()).toBe(false);
    fs.writeFileSync(s.filePath, '{not json');
    expect(s.read()).toBeNull();
    fs.writeFileSync(s.filePath, JSON.stringify({ framework: 'vim' }));
    expect(s.read()).toBeNull();
  });
});

describe('Agent awareness + migration parity', () => {
  const MARKER = '- **Dashboard door + model controls**';

  function runClaudeMd(projectDir: string): MigrationResult {
    const stateDir = path.join(projectDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    const migrator = new PostUpdateMigrator({ projectDir, stateDir, port: 4042, hasTelegram: false, projectName: 'test' });
    const result: MigrationResult = { upgraded: [], errors: [], skipped: [] };
    (migrator as unknown as { migrateClaudeMd: (r: MigrationResult) => void }).migrateClaudeMd(result);
    return result;
  }

  it('the template carries the line inside the Topic Profile section, with the options route', () => {
    const md = generateClaudeMd('test', 'TestAgent', 4042, false);
    expect(md).toContain(MARKER);
    expect(md).toContain('http://localhost:4042/topic-profile/options');
    expect(md.indexOf(MARKER)).toBeGreaterThan(md.indexOf('**Topic Profile (per-topic model'));
  });

  it('an existing agent whose Topic Profile section predates the line gets it (own sniff), exactly once', () => {
    const projectDir = path.join(tmpDir, 'agent');
    fs.mkdirSync(projectDir);
    const md = generateClaudeMd('test', 'TestAgent', 4042, false);
    const lines = md.split('\n').filter(l => !l.includes(MARKER));
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), lines.join('\n'));
    const first = runClaudeMd(projectDir);
    expect(first.upgraded).toContain('CLAUDE.md: added dashboard door + model controls line to Topic Profile section');
    const after = fs.readFileSync(path.join(projectDir, 'CLAUDE.md'), 'utf-8');
    expect(after.split(MARKER).length - 1).toBe(1);
    // Placed right after the section's Config bullet.
    const cfg = after.indexOf('- Config: `.instar/config.json` → `topicProfiles`');
    expect(after.indexOf(MARKER)).toBeGreaterThan(cfg);
    expect(after.slice(cfg, after.indexOf(MARKER)).split('\n').length).toBe(2);
    const second = runClaudeMd(projectDir);
    expect(second.upgraded).not.toContain('CLAUDE.md: added dashboard door + model controls line to Topic Profile section');
    expect(fs.readFileSync(path.join(projectDir, 'CLAUDE.md'), 'utf-8').split(MARKER).length - 1).toBe(1);
  });

  it('framework shadows (AGENTS.md) that already carry the Topic Profile section receive the line once, with no stray fragment', () => {
    const projectDir = path.join(tmpDir, 'codex-agent');
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    const md = generateClaudeMd('test', 'TestAgent', 4042, false);
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), md);
    const tpStart = md.indexOf('**Topic Profile (per-topic model');
    const tpOld = md.slice(tpStart, md.indexOf(MARKER)).trimEnd();
    fs.writeFileSync(path.join(projectDir, 'AGENTS.md'), `# AGENTS.md\n\n${tpOld}\n`);
    const migrator = new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'), port: 4042, hasTelegram: false, projectName: 'test' });
    const run = () => {
      const r: MigrationResult = { upgraded: [], errors: [], skipped: [] };
      (migrator as unknown as { migrateFrameworkShadowCapabilities: (x: MigrationResult) => void }).migrateFrameworkShadowCapabilities(r);
      return r;
    };
    run();
    run();
    const agents = fs.readFileSync(path.join(projectDir, 'AGENTS.md'), 'utf-8');
    expect(agents.split(MARKER).length - 1).toBe(1);
    expect(agents).toContain('/topic-profile/options');
    // The line lands whole ("- **Dashboard…"), and the Topic Profile slice
    // around it carries no stray list fragment.
    const lines = agents.split('\n');
    const at = lines.findIndex(l => l.includes(MARKER));
    expect(lines[at].startsWith(MARKER)).toBe(true);
    expect(lines.slice(Math.max(0, at - 2), at + 2).some(l => l.trim() === '-')).toBe(false);
    const tp = lines.findIndex(l => l.includes('**Topic Profile (per-topic model'));
    const tpEnd = lines.findIndex((l, i) => i > tp && l.trim() === '');
    expect(lines.slice(tp, tpEnd).some(l => l.trim() === '-')).toBe(false);
  });

  it('a template-generated CLAUDE.md is not modified by this migration', () => {
    const projectDir = path.join(tmpDir, 'fresh');
    fs.mkdirSync(projectDir);
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), generateClaudeMd('test', 'TestAgent', 4042, false));
    const r = runClaudeMd(projectDir);
    expect(r.upgraded).not.toContain('CLAUDE.md: added dashboard door + model controls line to Topic Profile section');
  });
});
