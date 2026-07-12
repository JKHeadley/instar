import { describe, it, expect } from 'vitest';
import {
  COHERENCE_CRITICAL_FLAGS,
  COHERENCE_MANIFEST_EXCLUSIONS,
  COHERENCE_STATE_SYNC_STORES,
  buildCoherenceFlags,
  resolveFlagValue,
  computeManifestHash,
  selfManifestHash,
  getByPath,
  MC_MAX_ENTRIES,
  MC_FLAGS_BYTES_MAX,
  MC_MARKER_BYTES_MAX,
  MC_BLOCK_BYTES_MAX,
  MC_MARKER_ROWS_MAX,
  MC_ROW_HASH_LEN,
  MC_KEY_MAX,
  MC_VALUE_MAX,
  MC_VALUE_ALPHABET,
  type CoherenceConfigView,
} from '../../src/core/machineCoherenceManifest.js';
import { DEV_GATED_FEATURES } from '../../src/core/devGatedFeatures.js';
import { SEAMLESSNESS_PROTOCOL_VERSION } from '../../src/core/seamlessnessConfig.js';

const view = (boot: Record<string, unknown>, liveGet?: CoherenceConfigView['liveGet']): CoherenceConfigView => ({ boot, liveGet });

describe('machineCoherenceManifest — membership + hash (§3.1)', () => {
  it('the manifest is non-empty and every entry is well-formed', () => {
    expect(COHERENCE_CRITICAL_FLAGS.length).toBeGreaterThan(0);
    for (const e of COHERENCE_CRITICAL_FLAGS) {
      expect(e.key.length).toBeGreaterThan(0);
      expect(e.key.length).toBeLessThanOrEqual(MC_KEY_MAX);
      expect(e.configPath.length).toBeGreaterThan(0);
      expect(['raw', 'dev-gate', 'dev-gate+dryRun']).toContain(e.resolution);
      expect(['boot', 'live']).toContain(e.readSource);
      expect(e.guarantee.length).toBeGreaterThan(0);
    }
  });

  it('carries one entry per WS2 stateSync store', () => {
    for (const store of COHERENCE_STATE_SYNC_STORES) {
      expect(COHERENCE_CRITICAL_FLAGS.some((e) => e.key === `stateSync.${store}.enabled`)).toBe(true);
    }
  });

  it('carries the guard\'s own posture row (N2)', () => {
    expect(COHERENCE_CRITICAL_FLAGS.some((e) => e.key === 'monitoring.machineCoherence')).toBe(true);
  });

  it('keys are unique', () => {
    const keys = COHERENCE_CRITICAL_FLAGS.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('manifestHash is 64 lowercase hex and covers key+resolution+readSource (M7)', () => {
    const h = selfManifestHash();
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    // Same keys, DIFFERENT resolution mode → different hash.
    const mutated = COHERENCE_CRITICAL_FLAGS.map((e, i) =>
      i === 0 ? { ...e, resolution: e.resolution === 'raw' ? ('dev-gate' as const) : ('raw' as const) } : e,
    );
    expect(computeManifestHash(mutated)).not.toBe(h);
    // Reordering entries does NOT change the hash (sorted-entry canonicalization).
    expect(computeManifestHash([...COHERENCE_CRITICAL_FLAGS].reverse())).toBe(h);
  });
});

describe('machineCoherenceManifest — N5 size ratchet (§3.1)', () => {
  it('entry count is within the cap', () => {
    expect(COHERENCE_CRITICAL_FLAGS.length).toBeLessThanOrEqual(MC_MAX_ENTRIES);
  });

  it('the reference advert INCLUDING a worst-case alarm marker holds within the byte budgets (R3-N1)', () => {
    // Build a maximal fleet-config advert.
    const flags = buildCoherenceFlags(view({ developmentAgent: true }));
    const flagsPortion = {
      instarVersion: '1.3.999+dirty',
      protocolVersion: SEAMLESSNESS_PROTOCOL_VERSION,
      manifestHash: selfManifestHash(),
      guard: 'live',
      beatSeq: 999999,
      flags,
    };
    const flagsBytes = Buffer.byteLength(JSON.stringify(flagsPortion), 'utf8');
    expect(flagsBytes).toBeLessThanOrEqual(MC_FLAGS_BYTES_MAX);

    // Worst-case marker: MC_MARKER_ROWS_MAX row hashes, each MC_ROW_HASH_LEN hex.
    const worstMarker = {
      episodeId: `mc-${'9'.repeat(13)}`,
      rowIdentityHashes: Array.from({ length: MC_MARKER_ROWS_MAX }, (_, i) =>
        i.toString(16).padStart(MC_ROW_HASH_LEN, '0').slice(0, MC_ROW_HASH_LEN),
      ),
      rowsTruncated: false,
    };
    const markerBytes = Buffer.byteLength(JSON.stringify(worstMarker), 'utf8');
    expect(markerBytes).toBeLessThanOrEqual(MC_MARKER_BYTES_MAX);

    // Combined block (join bytes measured on the COMBINED serialization — R4-L4).
    const whole = { ...flagsPortion, alarm: worstMarker };
    expect(Buffer.byteLength(JSON.stringify(whole), 'utf8')).toBeLessThanOrEqual(MC_BLOCK_BYTES_MAX);
  });

  it('every flag value is inside the clamp alphabet + length bound', () => {
    const flags = buildCoherenceFlags(view({ developmentAgent: true }));
    for (const v of Object.values(flags)) {
      expect(v.length).toBeLessThanOrEqual(MC_VALUE_MAX);
      expect(v).toMatch(MC_VALUE_ALPHABET);
    }
  });
});

describe('machineCoherenceManifest — N5 membership drift guard (§3.1)', () => {
  it('every multiMachine.* dev-gated feature is either in the manifest or explicitly excluded (with a reason)', () => {
    const manifestPaths = new Set(COHERENCE_CRITICAL_FLAGS.map((e) => e.configPath));
    const excludedPaths = new Set(COHERENCE_MANIFEST_EXCLUSIONS.map((e) => e.configPath));
    const uncovered: string[] = [];
    for (const feat of DEV_GATED_FEATURES) {
      if (!feat.configPath.startsWith('multiMachine.')) continue;
      if (manifestPaths.has(feat.configPath)) continue;
      if (excludedPaths.has(feat.configPath)) continue;
      uncovered.push(feat.configPath);
    }
    // A new coherence-relevant dev-gated flag added without a manifest decision
    // fails HERE — the F4 class cannot be silently re-created.
    expect(uncovered, `undecided multiMachine.* dev-gated flags: ${uncovered.join(', ')}`).toEqual([]);
  });

  it('every exclusion carries a non-trivial reason', () => {
    for (const e of COHERENCE_MANIFEST_EXCLUSIONS) {
      expect(e.reason.length).toBeGreaterThan(20);
    }
  });

  it('no exclusion collides with a manifest entry', () => {
    const manifestPaths = new Set(COHERENCE_CRITICAL_FLAGS.map((e) => e.configPath));
    for (const e of COHERENCE_MANIFEST_EXCLUSIONS) {
      expect(manifestPaths.has(e.configPath)).toBe(false);
    }
  });

  it('provenance.uniformSeam.enabled carries its voluntary exclusion row with the spec §5.7 reason (llm-decision-quality-meter)', () => {
    // NOT multiMachine.* so the N5 sweep does not require it — the row is the
    // deliberate documentation of the manifest decision, pinned here so a
    // future delete is a reviewed choice, not silent drift.
    const row = COHERENCE_MANIFEST_EXCLUSIONS.find((e) => e.configPath === 'provenance.uniformSeam.enabled');
    expect(row).toBeDefined();
    expect(row!.reason).toBe(
      'per-machine observability side write; skew degrades to missing provenance rows on one machine, visible in /decision-quality coverage — no cross-machine data guarantee',
    );
  });
});

describe('machineCoherenceManifest — resolution semantics (§3.3, both sides)', () => {
  it('dev-gate: LIVE on a dev agent, OFF on the fleet (F4 root)', () => {
    const dev = resolveFlagValue(
      COHERENCE_CRITICAL_FLAGS.find((e) => e.key === 'seamlessness.ws44PoolLinks')!,
      view({ developmentAgent: true }),
    );
    const fleet = resolveFlagValue(
      COHERENCE_CRITICAL_FLAGS.find((e) => e.key === 'seamlessness.ws44PoolLinks')!,
      view({ developmentAgent: false }),
    );
    expect(dev).toBe('live');
    expect(fleet).toBe('off');
  });

  it('the F4 case: both configs OMIT the flag, developmentAgent differs → effective values differ', () => {
    const pin = COHERENCE_CRITICAL_FLAGS.find((e) => e.key === 'seamlessness.ws13PinReplicate')!;
    // Both omit multiMachine.seamlessness.ws13PinReplicate; ws13DryRun omitted → defaults dry-run.
    const laptop = resolveFlagValue(pin, view({ developmentAgent: true }));
    const mini = resolveFlagValue(pin, view({ developmentAgent: false }));
    expect(laptop).toBe('dry-run'); // dev-gate resolves on, dryRun default true
    expect(mini).toBe('off');
    expect(laptop).not.toBe(mini);
  });

  it('dev-gate+dryRun folds dryRun:false → live', () => {
    const pin = COHERENCE_CRITICAL_FLAGS.find((e) => e.key === 'seamlessness.ws13PinReplicate')!;
    const v = resolveFlagValue(pin, view({ developmentAgent: true, multiMachine: { seamlessness: { ws13DryRun: false } } }));
    expect(v).toBe('live');
  });

  it('an explicit enabled:false force-darks even a dev agent', () => {
    const links = COHERENCE_CRITICAL_FLAGS.find((e) => e.key === 'seamlessness.ws44PoolLinks')!;
    const v = resolveFlagValue(links, view({ developmentAgent: true, multiMachine: { seamlessness: { ws44PoolLinks: false } } }));
    expect(v).toBe('off');
  });

  it('developmentAgent renders true/false directly', () => {
    const dev = COHERENCE_CRITICAL_FLAGS.find((e) => e.key === 'developmentAgent')!;
    expect(resolveFlagValue(dev, view({ developmentAgent: true }))).toBe('true');
    expect(resolveFlagValue(dev, view({ developmentAgent: false }))).toBe('false');
  });

  it('sessionPool.stage is read via the LIVE getter (M8) when present', () => {
    const stage = COHERENCE_CRITICAL_FLAGS.find((e) => e.key === 'sessionPool.stage')!;
    const boot = { multiMachine: { sessionPool: { stage: 'dark' } } };
    // liveGet reflects a PATCH /config change with no restart.
    const v = resolveFlagValue(stage, view(boot, (p, fb) => (p === 'multiMachine.sessionPool' ? { stage: 'live-transfer' } : fb)));
    expect(v).toBe('live-transfer');
    // Without a liveGet, falls back to boot.
    expect(resolveFlagValue(stage, view(boot))).toBe('dark');
  });

  it('exactlyOnceIngress derives from sessionPool.stage default (live-transfer/rebalance)', () => {
    const eoi = COHERENCE_CRITICAL_FLAGS.find((e) => e.key === 'exactlyOnceIngress')!;
    expect(resolveFlagValue(eoi, view({ multiMachine: { sessionPool: { stage: 'live-transfer' } } }))).toBe('live');
    expect(resolveFlagValue(eoi, view({ multiMachine: { sessionPool: { stage: 'dark' } } }))).toBe('off');
    // explicit override wins
    expect(resolveFlagValue(eoi, view({ multiMachine: { exactlyOnceIngress: true, sessionPool: { stage: 'dark' } } }))).toBe('live');
  });

  it('meshTransport.enabled defaults live (ships enabled), off only on explicit false', () => {
    const mesh = COHERENCE_CRITICAL_FLAGS.find((e) => e.key === 'meshTransport.enabled')!;
    expect(resolveFlagValue(mesh, view({}))).toBe('live');
    expect(resolveFlagValue(mesh, view({ multiMachine: { meshTransport: { enabled: false } } }))).toBe('off');
  });

  it('pollFollowsLease raw fold: enabled+dryRun default false → live; enabled+dryRun true → dry-run; disabled → off', () => {
    const pfl = COHERENCE_CRITICAL_FLAGS.find((e) => e.key === 'pollFollowsLease.enabled')!;
    expect(resolveFlagValue(pfl, view({ multiMachine: { pollFollowsLease: { enabled: true } } }))).toBe('live');
    expect(resolveFlagValue(pfl, view({ multiMachine: { pollFollowsLease: { enabled: true, dryRun: true } } }))).toBe('dry-run');
    expect(resolveFlagValue(pfl, view({ multiMachine: { pollFollowsLease: { enabled: false } } }))).toBe('off');
  });

  it('getByPath reads dotted paths and misses to undefined', () => {
    expect(getByPath({ a: { b: { c: 1 } } }, 'a.b.c')).toBe(1);
    expect(getByPath({ a: {} }, 'a.b.c')).toBeUndefined();
    expect(getByPath(null, 'a')).toBeUndefined();
  });
});
