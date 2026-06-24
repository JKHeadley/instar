/**
 * Tier 3 (E2E "feature is alive") — Ownership Follows Live Work
 * (docs/specs/ownership-follows-live-work.md).
 *
 * This feature adds NO HTTP routes — it is internal ownership-lifecycle wiring
 * gated by the dev-agent dark flag `multiMachine.ownershipFollowsLiveWork`. The
 * "alive vs inert" boundary is therefore proven two ways against PRODUCTION code:
 *
 *  1. FLAG RESOLUTION (alive-on-dev / dark-on-fleet) through the REAL ConfigDefaults
 *     (`applyDefaults` — which must NOT inject the flag) + the REAL resolveDevAgentGate
 *     funnel server.ts uses at every wiring site. A dev config → LIVE; a fleet config
 *     → DARK; an explicit config value always wins.
 *
 *  2. LIFECYCLE REGRESSION (the PR #1258 stale-record scenario, fixed at the source):
 *     a topic transferred here and then completed has its record advanced to
 *     `released` (flag ON) so a peer's reaper closeout reads `topicOwnerElsewhere ===
 *     null` and never even considers a kill — versus (flag OFF) the record stays
 *     `active` (the stale label PR #1258 had to defend against). Driven through the
 *     REAL SessionOwnershipRegistry + the SAME sharedTopicOwnerElsewhere shape the
 *     reaper consumes.
 */
import { describe, it, expect } from 'vitest';
import { applyDefaults, getMigrationDefaults } from '../../src/config/ConfigDefaults.js';
import { resolveDevAgentGate } from '../../src/core/devAgentGate.js';
import {
  SessionOwnershipRegistry,
  InMemorySessionOwnershipStore,
} from '../../src/core/SessionOwnershipRegistry.js';
import {
  shouldReleaseOnComplete,
  ownershipNonce,
} from '../../src/core/ownershipFollowsLiveWork.js';
import { DEV_GATED_FEATURES } from '../../src/core/devGatedFeatures.js';

const SELF = 'm_self';
const PEER = 'm_peer';

// The EXACT resolution expression server.ts uses at every wiring site.
function resolveFlag(config: { developmentAgent?: boolean; multiMachine?: { ownershipFollowsLiveWork?: boolean } }): boolean {
  return resolveDevAgentGate(
    (config.multiMachine as { ownershipFollowsLiveWork?: boolean } | undefined)?.ownershipFollowsLiveWork,
    config,
  );
}

/** Build a config a real agent would run with: REAL defaults applied in place. */
function buildAgentConfig(extra: Record<string, unknown>): Record<string, unknown> {
  const cfg: Record<string, unknown> = { projectName: 't', projectDir: '/tmp/ofw-e2e', stateDir: '/tmp/ofw-e2e', port: 0, authToken: 'x', ...extra };
  applyDefaults(cfg, getMigrationDefaults('standalone'));
  return cfg;
}

describe('E2E: ownership-follows-live-work flag resolution (alive-on-dev / dark-on-fleet)', () => {
  it('ConfigDefaults OMITS the flag (the dev-gate decides at runtime — a literal false would force-dark dev)', () => {
    const defaulted = buildAgentConfig({}) as { multiMachine?: { ownershipFollowsLiveWork?: boolean } };
    expect(defaulted.multiMachine?.ownershipFollowsLiveWork).toBeUndefined();
  });

  it('a developmentAgent:true config resolves the flag LIVE', () => {
    const config = buildAgentConfig({ developmentAgent: true });
    expect(resolveFlag(config as never)).toBe(true);
  });

  it('a fleet config (developmentAgent absent/false) resolves the flag DARK', () => {
    const config = buildAgentConfig({});
    expect(resolveFlag(config as never)).toBe(false);
  });

  it('an explicit config value always WINS (false force-darks even a dev agent)', () => {
    expect(resolveFlag({ developmentAgent: true, multiMachine: { ownershipFollowsLiveWork: false } })).toBe(false);
    expect(resolveFlag({ developmentAgent: false, multiMachine: { ownershipFollowsLiveWork: true } })).toBe(true);
  });

  it('registered in DEV_GATED_FEATURES (rides the gate; NOT a DARK_GATE_EXCLUSION)', () => {
    const entry = DEV_GATED_FEATURES.find((f) => f.name === 'ownershipFollowsLiveWork');
    expect(entry).toBeDefined();
    expect(entry!.configPath).toBe('multiMachine.ownershipFollowsLiveWork');
    expect(entry!.justification.length).toBeGreaterThan(12);
  });
});

describe('E2E: lifecycle regression — release-on-complete removes the stale record at the source', () => {
  function makeRegistry() {
    const seen = new Set<string>();
    return new SessionOwnershipRegistry({
      store: new InMemorySessionOwnershipStore(),
      seenNonce: (k) => seen.has(k),
      recordNonce: (k) => seen.add(k),
    });
  }

  // The SAME shape the reaper consumes (sharedTopicOwnerElsewhere, server.ts):
  // owner && owner !== self.
  function topicOwnerElsewhere(reg: SessionOwnershipRegistry, sk: string, self: string): boolean {
    const owner = reg.ownerOf(sk);
    return !!owner && owner !== self;
  }

  it('flag ON: a transferred-here topic that COMPLETES becomes released → ownerOf null → reaper sees no elsewhere-owner', () => {
    const reg = makeRegistry();
    // Topic transferred to THIS machine (SELF) and active here.
    reg.cas({ type: 'place', machineId: PEER }, { sessionKey: '900', sender: PEER, nonce: ownershipNonce(PEER, 'place', '900') });
    reg.cas({ type: 'claim', machineId: PEER }, { sessionKey: '900', sender: PEER, nonce: ownershipNonce(PEER, 'claim', '900') });
    reg.cas({ type: 'transfer', to: SELF }, { sessionKey: '900', sender: PEER, nonce: ownershipNonce(PEER, 'transfer', '900') });
    reg.cas({ type: 'claim', machineId: SELF }, { sessionKey: '900', sender: SELF, nonce: ownershipNonce(SELF, 'claim', '900') });
    expect(reg.ownerOf('900')).toBe(SELF);

    // The session COMPLETES. The flag-ON release-on-complete (single-sourced helper)
    // decides to release, the wiring performs the CAS.
    const rec = reg.read('900');
    expect(shouldReleaseOnComplete({ enabled: true, selfMachineId: SELF, record: rec, completingStartedAt: 's', liveStartedAt: null })).toBe(true);
    const r = reg.cas({ type: 'release', machineId: SELF }, { sessionKey: '900', sender: SELF, nonce: ownershipNonce(SELF, 'rel-complete', '900') });
    expect(r.ok).toBe(true);

    // The record is now released → no stale `active`. From a PEER's reaper viewpoint
    // (self = PEER), topicOwnerElsewhere is null/false → no kill ever considered.
    expect(reg.ownerOf('900')).toBeNull();
    expect(topicOwnerElsewhere(reg, '900', PEER)).toBe(false);
  });

  it('flag OFF: the record stays active(SELF) (the stale label PR #1258 had to defend against)', () => {
    const reg = makeRegistry();
    reg.cas({ type: 'place', machineId: SELF }, { sessionKey: '901', sender: SELF, nonce: ownershipNonce(SELF, 'place', '901') });
    reg.cas({ type: 'claim', machineId: SELF }, { sessionKey: '901', sender: SELF, nonce: ownershipNonce(SELF, 'claim', '901') });

    // flag OFF → the gate withholds the release entirely (no CAS performed).
    const rec = reg.read('901');
    expect(shouldReleaseOnComplete({ enabled: false, selfMachineId: SELF, record: rec, completingStartedAt: 's', liveStartedAt: null })).toBe(false);
    // The record is unchanged: still active(SELF) — the stale-`active`-after-complete
    // state. A PEER's reaper still sees an elsewhere-owner (the compensated-for hazard).
    expect(reg.ownerOf('901')).toBe(SELF);
    expect(topicOwnerElsewhere(reg, '901', PEER)).toBe(true);
  });
});
