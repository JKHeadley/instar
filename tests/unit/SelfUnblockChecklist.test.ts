/**
 * Unit tests for SelfUnblockChecklist — the deterministic, code-driven exhaustion
 * checklist that completes the "Self-Unblock Before Escalating" standard
 * (docs/specs/self-unblock-before-escalating.md).
 *
 * Coverage (per the spec's Testing §8):
 *  - probe ORDERING + short-circuit on the first holdsRelevantCred:true
 *  - per-probe timeout → reachable:false (one hung probe degrades, never stalls)
 *  - the stamped structured result
 *  - the deterministic relevance matcher: wildcard + parent-zone match AND
 *    missing/ambiguous metadata fails CLOSED
 *  - the ladder / rung-floor (irreversible / cost-bearing → min rung 1 even with a cred)
 *  - the rung-1 verified-principal resolution
 *  - the durable run store: save + loadRun + skip-corrupt-lines tolerance
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  SelfUnblockChecklist,
  SelfUnblockRunStore,
  isScopeRelevant,
  relevantScopeTags,
  parseScopeTag,
  resolveRung,
  rungToAuthorityCheck,
  actionTriggersRungFloor,
  SELF_UNBLOCK_PROBE_SOURCES,
  type ProbeProviders,
  type SelfUnblockRun,
} from '../../src/monitoring/SelfUnblockChecklist.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'self-unblock-'));
});
afterEach(() => {
  SafeFsExecutor.safeRmSync(tmpDir, {
    recursive: true,
    force: true,
    operation: 'tests/unit/SelfUnblockChecklist.test.ts:afterEach',
  });
});

function makeStore(): SelfUnblockRunStore {
  return new SelfUnblockRunStore({ stateDir: tmpDir });
}

// ─── Relevance matcher ─────────────────────────────────────────────────────────

describe('SelfUnblockChecklist — deterministic relevance matcher', () => {
  it('parses a well-formed service:scope tag and rejects malformed ones', () => {
    expect(parseScopeTag('cloudflare:dawn-tunnel.dev')).toEqual({
      service: 'cloudflare',
      scope: 'dawn-tunnel.dev',
    });
    // malformed → null (treated as ambiguous → fail closed downstream)
    expect(parseScopeTag('no-colon')).toBeNull();
    expect(parseScopeTag(':leading')).toBeNull();
    expect(parseScopeTag('trailing:')).toBeNull();
    expect(parseScopeTag('')).toBeNull();
    expect(parseScopeTag(42)).toBeNull();
    expect(parseScopeTag(undefined)).toBeNull();
  });

  it('matches an exact zone and a parent-zone over a sub-zone target', () => {
    // exact
    expect(isScopeRelevant('cloudflare:dawn-tunnel.dev', 'cloudflare:dawn-tunnel.dev')).toBe(true);
    // parent-zone cred covers a sub-zone target (broader authority)
    expect(isScopeRelevant('cloudflare:dawn-tunnel.dev', 'cloudflare:feedback.dawn-tunnel.dev')).toBe(true);
  });

  it('matches a wildcard tag against a strict sub-domain but NOT the apex', () => {
    expect(isScopeRelevant('cloudflare:*.dawn-tunnel.dev', 'cloudflare:feedback.dawn-tunnel.dev')).toBe(true);
    // wildcard does not match the apex (CA/DNS wildcard semantics)
    expect(isScopeRelevant('cloudflare:*.dawn-tunnel.dev', 'cloudflare:dawn-tunnel.dev')).toBe(false);
  });

  it('does NOT let a sub-zone cred satisfy a parent-zone target (narrower authority)', () => {
    expect(isScopeRelevant('cloudflare:feedback.dawn-tunnel.dev', 'cloudflare:dawn-tunnel.dev')).toBe(false);
  });

  it('never matches across services (a Vercel cred is not relevant to a Cloudflare target)', () => {
    expect(isScopeRelevant('vercel:dawn-tunnel.dev', 'cloudflare:dawn-tunnel.dev')).toBe(false);
  });

  it('matches a non-domain scope only exactly, and a whole-account `*` matches anything for its service', () => {
    expect(isScopeRelevant('vercel:project', 'vercel:project')).toBe(true);
    expect(isScopeRelevant('vercel:project', 'vercel:other')).toBe(false);
    // a deliberate whole-account tag
    expect(isScopeRelevant('vercel:*', 'vercel:project')).toBe(true);
    expect(isScopeRelevant('vercel:*', 'cloudflare:project')).toBe(false); // still service-scoped
  });

  it('FAILS CLOSED on missing/ambiguous metadata', () => {
    // undefined cred tag, undefined target, malformed either side → false
    expect(isScopeRelevant(undefined, 'cloudflare:dawn-tunnel.dev')).toBe(false);
    expect(isScopeRelevant('cloudflare:dawn-tunnel.dev', undefined)).toBe(false);
    expect(isScopeRelevant('garbage', 'cloudflare:dawn-tunnel.dev')).toBe(false);
    expect(isScopeRelevant('cloudflare:dawn-tunnel.dev', 'garbage')).toBe(false);
  });

  it('an evil look-alike domain never matches (label boundary enforced)', () => {
    expect(isScopeRelevant('cloudflare:dawn-tunnel.dev', 'cloudflare:evil-dawn-tunnel.dev')).toBe(false);
  });

  it('relevantScopeTags returns only matching tags and fails closed on an empty/undefined set', () => {
    expect(relevantScopeTags(['cloudflare:*.dawn-tunnel.dev', 'vercel:project'], 'cloudflare:feedback.dawn-tunnel.dev')).toEqual(['cloudflare:*.dawn-tunnel.dev']);
    expect(relevantScopeTags(undefined, 'cloudflare:dawn-tunnel.dev')).toEqual([]);
    expect(relevantScopeTags([], 'cloudflare:dawn-tunnel.dev')).toEqual([]);
  });
});

// ─── Probe ordering + short-circuit + timeout ──────────────────────────────────

describe('SelfUnblockChecklist — probe ordering + short-circuit', () => {
  it('probes in the canonical order and short-circuits on the first relevant cred', async () => {
    const probed: string[] = [];
    const providers: ProbeProviders = {};
    for (const source of SELF_UNBLOCK_PROBE_SOURCES) {
      providers[source] = async () => {
        probed.push(source);
        // The third source (cloud-vercel) advertises the relevant cred.
        if (source === 'cloud-vercel') {
          return { reachable: true, advertisedScopeTags: ['vercel:dawn-tunnel.dev'] };
        }
        return { reachable: true, advertisedScopeTags: [] };
      };
    }
    const checklist = new SelfUnblockChecklist({ providers, store: makeStore() });
    const run = await checklist.run({ target: 'vercel:dawn-tunnel.dev', requiredAttemptType: 'self-fetch' });

    // Ordered: own-vault, owned-identities, org-bitwarden, cloud-vercel — then STOP.
    expect(probed).toEqual(['own-vault', 'owned-identities', 'org-bitwarden', 'cloud-vercel']);
    expect(run.exhausted).toBe(false); // a relevant cred was found
    expect(run.probes[run.probes.length - 1].holdsRelevantCred).toBe(true);
    expect(run.probes[run.probes.length - 1].source).toBe('cloud-vercel');
  });

  it('a fully-exhausted run flags exhausted:true with every probe holdsRelevantCred:false', async () => {
    const providers: ProbeProviders = {};
    for (const source of SELF_UNBLOCK_PROBE_SOURCES) {
      providers[source] = async () => ({ reachable: true, advertisedScopeTags: ['cloudflare:other.dev'] });
    }
    const checklist = new SelfUnblockChecklist({ providers, store: makeStore() });
    const run = await checklist.run({ target: 'cloudflare:dawn-tunnel.dev', requiredAttemptType: 'self-fetch' });

    expect(run.probes).toHaveLength(SELF_UNBLOCK_PROBE_SOURCES.length);
    expect(run.exhausted).toBe(true);
    expect(run.probes.every((p) => !p.holdsRelevantCred)).toBe(true);
  });

  it('a missing provider degrades to reachable:false (graceful), not a crash', async () => {
    // No providers at all — every source is unreachable.
    const checklist = new SelfUnblockChecklist({ providers: {}, store: makeStore() });
    const run = await checklist.run({ target: 'cloudflare:dawn-tunnel.dev', requiredAttemptType: 'self-fetch' });
    expect(run.probes.every((p) => p.reachable === false && p.holdsRelevantCred === false)).toBe(true);
    expect(run.exhausted).toBe(true);
  });

  it('stamps a structured result per probe (source/reachable/holdsRelevantCred/probedAt)', async () => {
    const fixedNow = new Date('2026-06-14T00:00:00.000Z');
    const providers: ProbeProviders = {
      'own-vault': async () => ({ reachable: true, advertisedScopeTags: [] }),
    };
    const checklist = new SelfUnblockChecklist({ providers, store: makeStore(), now: () => fixedNow });
    const run = await checklist.run({ target: 'cloudflare:dawn-tunnel.dev', requiredAttemptType: 'self-fetch' });
    const first = run.probes[0];
    expect(first.source).toBe('own-vault');
    expect(typeof first.reachable).toBe('boolean');
    expect(typeof first.holdsRelevantCred).toBe('boolean');
    expect(first.probedAt).toBe('2026-06-14T00:00:00.000Z');
  });
});

describe('SelfUnblockChecklist — per-probe timeout fails toward reachable:false', () => {
  it('a hung provider times out and is recorded reachable:false (does not stall the path)', async () => {
    const providers: ProbeProviders = {
      // own-vault hangs forever; the runner's hard timeout must kick in.
      'own-vault': () => new Promise(() => {}),
    };
    const checklist = new SelfUnblockChecklist({
      providers,
      store: makeStore(),
      timeoutMs: { local: 20, remote: 20 }, // tiny budgets so the test is fast
    });
    const run = await checklist.run({ target: 'cloudflare:dawn-tunnel.dev', requiredAttemptType: 'self-fetch' });
    const ownVault = run.probes.find((p) => p.source === 'own-vault')!;
    expect(ownVault.reachable).toBe(false);
    expect(ownVault.holdsRelevantCred).toBe(false);
    expect(ownVault.detail).toMatch(/timed out|errored/);
  });

  it('a throwing provider is recorded reachable:false (fail closed)', async () => {
    const providers: ProbeProviders = {
      'own-vault': async () => {
        throw new Error('boom');
      },
    };
    const checklist = new SelfUnblockChecklist({ providers, store: makeStore() });
    const run = await checklist.run({ target: 'cloudflare:dawn-tunnel.dev', requiredAttemptType: 'self-fetch' });
    const ownVault = run.probes.find((p) => p.source === 'own-vault')!;
    expect(ownVault.reachable).toBe(false);
    expect(ownVault.holdsRelevantCred).toBe(false);
  });
});

// ─── Run store ─────────────────────────────────────────────────────────────────

describe('SelfUnblockRunStore — durable, skip-corrupt-lines tolerant', () => {
  it('saves a run and loads it back by runId, and returns null for an unknown id', async () => {
    const store = makeStore();
    const providers: ProbeProviders = { 'own-vault': async () => ({ reachable: false }) };
    const checklist = new SelfUnblockChecklist({ providers, store, mintRunId: () => 'SUN-fixed' });
    const run = await checklist.run({ target: 'cloudflare:dawn-tunnel.dev', requiredAttemptType: 'self-fetch' });
    expect(run.runId).toBe('SUN-fixed');

    const loaded = store.loadRun('SUN-fixed');
    expect(loaded?.runId).toBe('SUN-fixed');
    expect(loaded?.target).toBe('cloudflare:dawn-tunnel.dev');
    expect(store.loadRun('nope')).toBeNull();
    // a fresh store over the same stateDir reads the persisted run
    expect(makeStore().loadRun('SUN-fixed')?.runId).toBe('SUN-fixed');
  });

  it('the runId is the RUNNER\'s — the caller cannot supply one', async () => {
    const store = makeStore();
    let minted = 0;
    const checklist = new SelfUnblockChecklist({
      providers: {},
      store,
      mintRunId: () => `SUN-${++minted}`,
    });
    const a = await checklist.run({ target: 'cloudflare:a.dev', requiredAttemptType: 'self-fetch' });
    const b = await checklist.run({ target: 'cloudflare:b.dev', requiredAttemptType: 'self-fetch' });
    expect(a.runId).toBe('SUN-1');
    expect(b.runId).toBe('SUN-2');
    expect(a.runId).not.toBe(b.runId);
  });

  it('skips a corrupt/partial line rather than failing the whole read', () => {
    const store = makeStore();
    const goodRun: SelfUnblockRun = {
      runId: 'SUN-good',
      target: 'cloudflare:dawn-tunnel.dev',
      requiredAttemptType: 'self-fetch',
      probes: [{ source: 'own-vault', reachable: false, holdsRelevantCred: false, probedAt: '2026-06-14T00:00:00.000Z' }],
      completedAt: '2026-06-14T00:00:00.000Z',
      exhausted: true,
    };
    store.save(goodRun);
    // inject a corrupt line directly
    fs.appendFileSync(store.path, '{ this is not valid json\n');
    store.save({ ...goodRun, runId: 'SUN-good-2' });

    expect(store.loadRun('SUN-good')?.runId).toBe('SUN-good');
    expect(store.loadRun('SUN-good-2')?.runId).toBe('SUN-good-2');
    expect(store.list().map((r) => r.runId)).toEqual(['SUN-good', 'SUN-good-2']);
  });

  it('loadRun returns null when no runs file exists yet', () => {
    expect(makeStore().loadRun('anything')).toBeNull();
    expect(makeStore().list()).toEqual([]);
  });
});

// ─── Ladder + rung floor ───────────────────────────────────────────────────────

describe('SelfUnblockChecklist — ladder + rung floor (§3)', () => {
  function runWith(exhausted: boolean): SelfUnblockRun {
    return {
      runId: 'SUN-x',
      target: 'cloudflare:dawn-tunnel.dev',
      requiredAttemptType: 'self-fetch',
      probes: [{ source: 'own-vault', reachable: true, holdsRelevantCred: !exhausted, probedAt: 't' }],
      completedAt: 't',
      exhausted,
    };
  }

  it('a non-exhausted run (a self-unblock cred exists) → rung 0', () => {
    const res = resolveRung({ run: runWith(false) });
    expect(res.rung).toBe(0);
    expect(res.raisedByFloor).toBe(false);
  });

  it('an exhausted run + operator-only secret → rung 2', () => {
    const res = resolveRung({ run: runWith(true), operatorOnlySecret: true });
    expect(res.rung).toBe(2);
  });

  it('an exhausted run, not an operator-only secret → rung 1 (approval)', () => {
    const res = resolveRung({ run: runWith(true), operatorOnlySecret: false });
    expect(res.rung).toBe(1);
  });

  it('RUNG FLOOR: an irreversible action raises a rung-0 (cred exists) to rung 1', () => {
    const res = resolveRung({ run: runWith(false), action: { irreversible: true } });
    expect(res.rung).toBe(1);
    expect(res.raisedByFloor).toBe(true);
  });

  it('RUNG FLOOR: a cost-bearing-above-threshold action raises rung-0 to rung 1', () => {
    const res = resolveRung({ run: runWith(false), action: { costBearingAboveThreshold: true } });
    expect(res.rung).toBe(1);
    expect(res.raisedByFloor).toBe(true);
  });

  it('RUNG FLOOR: out-of-scope / policy-sensitive each trigger the floor', () => {
    expect(actionTriggersRungFloor({ outOfScope: true })).toBe(true);
    expect(actionTriggersRungFloor({ policySensitive: true })).toBe(true);
    expect(actionTriggersRungFloor({})).toBe(false);
    expect(actionTriggersRungFloor(undefined)).toBe(false);
  });

  it('the floor never LOWERS a rung — an exhausted rung-2 stays 2 under a floor action', () => {
    const res = resolveRung({ run: runWith(true), operatorOnlySecret: true, action: { irreversible: true } });
    expect(res.rung).toBe(2);
    expect(res.raisedByFloor).toBe(false); // base already >= 1, floor adds nothing
  });
});

describe('SelfUnblockChecklist — rung→AuthorityCheck + verified principal', () => {
  it('rung 0 records the agent as holding authority (no human)', () => {
    const resolution = resolveRung({
      run: { runId: 'r', target: 't', requiredAttemptType: 'self-fetch', probes: [], completedAt: 't', exhausted: false },
    });
    const auth = rungToAuthorityCheck({ resolution, principalVerified: false });
    expect(auth.agentHasAuthority).toBe(true);
    expect(auth.userHasAuthority).toBe(false);
  });

  it('rung 1 with a VERIFIED principal records userHasAuthority:true', () => {
    const resolution = resolveRung({
      run: { runId: 'r', target: 't', requiredAttemptType: 'self-fetch', probes: [], completedAt: 't', exhausted: true },
      operatorOnlySecret: false,
    });
    const auth = rungToAuthorityCheck({ resolution, principalVerified: true });
    expect(auth.agentHasAuthority).toBe(false);
    expect(auth.userHasAuthority).toBe(true);
    expect(auth.note).toContain('verified principal');
  });

  it('rung 1 with an UNVERIFIED principal refuses to assert userHasAuthority (Know Your Principal)', () => {
    const resolution = resolveRung({
      run: { runId: 'r', target: 't', requiredAttemptType: 'self-fetch', probes: [], completedAt: 't', exhausted: true },
      operatorOnlySecret: false,
    });
    const auth = rungToAuthorityCheck({ resolution, principalVerified: false });
    expect(auth.userHasAuthority).toBe(false);
    expect(auth.note).toContain('NOT verified');
  });
});
