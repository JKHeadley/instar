/**
 * Machine-coherence advert (machine-coherence-guard §3.2) — build + receive
 * clamp + registry receipt semantics.
 *
 * Pins the spec's normative transport properties:
 *  - M3: emission is UNCONDITIONAL — an advert builds from a FLEET config
 *    (no developmentAgent, no machineCoherence block) with guard 'dark';
 *  - M4/R5-N3: the receive clamp rejects malformed adverts with a NAMED
 *    reason (rejected ≠ absent), format-clamps every rendered peer string,
 *    drops a malformed alarm MARKER while the advert stands (R3-N9), and
 *    passes clean adverts rebuilt byte-identical;
 *  - M5: the registry stamps advert receipt ONLY on advert-carrying beats —
 *    carry-forward never impersonates freshness; a rejection REPLACES the
 *    stored advert for evaluation until the next clean advert.
 */
import { describe, it, expect } from 'vitest';
import {
  buildCoherenceAdvert,
  clampCoherenceAdvert,
  resolveSelfGuardPosture,
  type CoherenceAdvert,
} from '../../src/core/machineCoherenceAdvert.js';
import {
  selfManifestHash,
  selfProtocolVersion,
  COHERENCE_CRITICAL_FLAGS,
  MC_MARKER_ROWS_MAX,
} from '../../src/core/machineCoherenceManifest.js';
import { MachinePoolRegistry } from '../../src/core/MachinePoolRegistry.js';

const FLEET_CONFIG = {}; // no developmentAgent, no monitoring.machineCoherence block
const DEV_CONFIG = { developmentAgent: true };

function validAdvert(overrides: Partial<CoherenceAdvert> = {}): CoherenceAdvert {
  return {
    instarVersion: '1.3.729',
    protocolVersion: 1,
    manifestHash: 'c'.repeat(64),
    guard: 'live',
    beatSeq: 3,
    flags: { developmentAgent: 'true', 'sessionPool.stage': 'dark' },
    ...overrides,
  };
}

describe('buildCoherenceAdvert — emission is unconditional (M3)', () => {
  it('builds a complete advert from a FLEET config (no dev gate, no machineCoherence block)', () => {
    const advert = buildCoherenceAdvert({ boot: FLEET_CONFIG }, { instarVersion: '1.3.729', beatSeq: 0 });
    expect(advert.instarVersion).toBe('1.3.729');
    expect(advert.protocolVersion).toBe(selfProtocolVersion());
    expect(advert.manifestHash).toBe(selfManifestHash());
    // The guard resolves DARK on the fleet — but the advert still ships (the
    // exact F4 topology: a dark Mini must never be advert-less).
    expect(advert.guard).toBe('dark');
    expect(Object.keys(advert.flags).length).toBe(COHERENCE_CRITICAL_FLAGS.length);
    expect('alarm' in advert).toBe(false);
  });

  it('a built advert round-trips its own receive clamp byte-identical', () => {
    const advert = buildCoherenceAdvert({ boot: DEV_CONFIG }, { instarVersion: '1.3.729', beatSeq: 7 });
    const res = clampCoherenceAdvert(advert);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.advert).toEqual(advert);
  });

  it('resolves the guard posture per the dev-gate + dryRun ladder (N2)', () => {
    expect(resolveSelfGuardPosture({ boot: FLEET_CONFIG })).toBe('dark');
    // Dev agent, no block: gate resolves ON, dryRun defaults TRUE (first rung).
    expect(resolveSelfGuardPosture({ boot: DEV_CONFIG })).toBe('dry-run');
    expect(
      resolveSelfGuardPosture({ boot: { developmentAgent: true, monitoring: { machineCoherence: { dryRun: false } } } }),
    ).toBe('live');
    expect(
      resolveSelfGuardPosture({ boot: { monitoring: { machineCoherence: { enabled: false } } } }),
    ).toBe('dark');
  });
});

describe('clampCoherenceAdvert — the M4 receive clamp (R5-N3 format clamps)', () => {
  it('accepts a clean advert (with a well-formed alarm marker) byte-identical', () => {
    const advert = validAdvert({
      alarm: { episodeId: 'mc-1751500000000', rowIdentityHashes: ['0123456789abcdef', 'fedcba9876543210'] },
    });
    const res = clampCoherenceAdvert(advert);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.advert).toEqual(advert);
      expect(res.markerDropReason).toBeUndefined();
    }
  });

  it.each([
    ['not-an-object', 'nope'],
    ['not-an-object', null],
    ['instar-version-format', validAdvert({ instarVersion: 'v1;rm -rf' })],
    ['instar-version-format', { ...validAdvert(), instarVersion: 42 }],
    ['protocol-version-not-numeric', { ...validAdvert(), protocolVersion: 'one' }],
    ['manifest-hash-format', validAdvert({ manifestHash: 'C'.repeat(64) })], // uppercase = not the lowercase-hex alphabet
    ['guard-posture-format', { ...validAdvert(), guard: 'LIVE!' }],
    ['beat-seq-not-numeric', { ...validAdvert(), beatSeq: -1 }],
    ['flags-not-an-object', { ...validAdvert(), flags: ['live'] }],
    ['flag-key-format', validAdvert({ flags: { '<img>': 'live' } })],
    ['flag-value-format', validAdvert({ flags: { good: 'BAD VALUE!' } })],
  ] as Array<[string, unknown]>)('rejects with reason %s', (reason, raw) => {
    const res = clampCoherenceAdvert(raw);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe(reason);
  });

  it('rejects an advert whose flag map exceeds the entry-count bound', () => {
    const flags: Record<string, string> = {};
    for (let i = 0; i < 65; i++) flags[`k${i}`] = 'live';
    const res = clampCoherenceAdvert(validAdvert({ flags }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('flags-entry-count');
  });

  it('drops a MARKER with a bad episodeId format while the advert stands (R3-N9 — the id renders into operator appends)', () => {
    const res = clampCoherenceAdvert(
      validAdvert({ alarm: { episodeId: 'mc-<script>', rowIdentityHashes: ['0123456789abcdef'] } }),
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.advert.alarm).toBeUndefined();
      expect(res.markerDropReason).toBe('episode-id-format');
      // The advert's other fields stand — a forged-marker campaign cannot
      // knock a peer's whole advert out of the comparison.
      expect(res.advert.instarVersion).toBe('1.3.729');
    }
  });

  it('drops a MARKER whose row hashes are not 16-lowercase-hex', () => {
    const res = clampCoherenceAdvert(
      validAdvert({ alarm: { episodeId: 'mc-1751500000000', rowIdentityHashes: ['not-hex-at-all!!'] } }),
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.advert.alarm).toBeUndefined();
      expect(res.markerDropReason).toBe('row-hash-format');
    }
  });

  it('truncates an over-72-row marker and flags rowsTruncated (receive-clamp honesty — truncation NEVER grants coverage)', () => {
    const rows = Array.from({ length: MC_MARKER_ROWS_MAX + 5 }, (_, i) =>
      i.toString(16).padStart(16, '0'),
    );
    const res = clampCoherenceAdvert(
      validAdvert({ alarm: { episodeId: 'mc-1751500000000', rowIdentityHashes: rows } }),
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.advert.alarm).toBeDefined();
      expect(res.advert.alarm!.rowIdentityHashes).toHaveLength(MC_MARKER_ROWS_MAX);
      expect(res.advert.alarm!.rowsTruncated).toBe(true);
    }
  });
});

describe('MachinePoolRegistry — advert receipt semantics (M5 carry-forward honesty + M4 rejection)', () => {
  function makeRegistry(nowRef: { t: number }) {
    return new MachinePoolRegistry({
      listMachines: () => [{ machineId: 'm_peer' }],
      clockSkewToleranceMs: 300_000,
      failoverThresholdMs: 90_000,
      now: () => nowRef.t,
    });
  }

  it('stamps coherenceAdvertReceivedAt ONLY on advert-carrying beats; a sparse beat carries the advert forward with its ORIGINAL receipt time', () => {
    const nowRef = { t: 1_751_500_000_000 };
    const reg = makeRegistry(nowRef);
    const advert = validAdvert();

    reg.recordHeartbeat({ machineId: 'm_peer', selfReportedLastSeen: new Date(nowRef.t).toISOString(), coherenceAdvert: advert });
    const first = reg.getCapacity('m_peer')!;
    expect(first.coherenceAdvert).toEqual(advert);
    expect(first.coherenceAdvertReceivedAt).toBe(new Date(1_751_500_000_000).toISOString());

    // 60s later: a sparse liveness beat with NO advert (the git-beat shape that
    // refreshes routerReceivedAt WITHOUT carrying an advert — the exact gap M5
    // closes: liveness freshness must not impersonate advert freshness).
    nowRef.t += 60_000;
    reg.recordHeartbeat({ machineId: 'm_peer', selfReportedLastSeen: new Date(nowRef.t).toISOString() });
    const second = reg.getCapacity('m_peer')!;
    expect(second.coherenceAdvert).toEqual(advert); // carried forward
    expect(second.coherenceAdvertReceivedAt).toBe(new Date(1_751_500_000_000).toISOString()); // NOT refreshed
    expect(second.online).toBe(true); // liveness DID refresh
  });

  it('a rejection marker REPLACES the stored advert for evaluation; the next clean advert clears it', () => {
    const nowRef = { t: 1_751_500_000_000 };
    const reg = makeRegistry(nowRef);
    const advert = validAdvert();

    reg.recordHeartbeat({ machineId: 'm_peer', selfReportedLastSeen: new Date(nowRef.t).toISOString(), coherenceAdvert: advert });

    nowRef.t += 30_000;
    reg.recordHeartbeat({
      machineId: 'm_peer',
      selfReportedLastSeen: new Date(nowRef.t).toISOString(),
      coherenceAdvertRejected: { atMs: nowRef.t, reason: 'flag-value-format' },
    });
    const rejected = reg.getCapacity('m_peer')!;
    // Rejected ≠ absent AND rejected ≠ last-good: the malformed sender cannot
    // sit permanently misrepresented as coherent by its old advert.
    expect(rejected.coherenceAdvert).toBeUndefined();
    expect(rejected.coherenceAdvertRejected).toEqual({ atMs: nowRef.t, reason: 'flag-value-format' });

    nowRef.t += 30_000;
    reg.recordHeartbeat({ machineId: 'm_peer', selfReportedLastSeen: new Date(nowRef.t).toISOString(), coherenceAdvert: advert });
    const healed = reg.getCapacity('m_peer')!;
    expect(healed.coherenceAdvert).toEqual(advert);
    expect(healed.coherenceAdvertRejected).toBeUndefined();
    expect(healed.coherenceAdvertReceivedAt).toBe(new Date(nowRef.t).toISOString());
  });

  it('a machine with no advert EVER received carries none of the three fields (pre-guard peer = honestly absent)', () => {
    const nowRef = { t: 1_751_500_000_000 };
    const reg = makeRegistry(nowRef);
    reg.recordHeartbeat({ machineId: 'm_peer', selfReportedLastSeen: new Date(nowRef.t).toISOString() });
    const cap = reg.getCapacity('m_peer')!;
    expect('coherenceAdvert' in cap).toBe(false);
    expect('coherenceAdvertReceivedAt' in cap).toBe(false);
    expect('coherenceAdvertRejected' in cap).toBe(false);
  });
});
