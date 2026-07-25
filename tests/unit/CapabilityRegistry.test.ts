import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CapabilityRegistryReceiver,
  CapabilityRegistryWriter,
  MAX_ENTRIES_PER_MACHINE,
  canonicalDigest,
  deriveStatus,
  readDoorwaySources,
  validateProjection,
  type CapabilityEntry,
  type CapabilityProjection,
} from '../../src/core/CapabilityRegistry.js';

const entry = (overrides: Partial<CapabilityEntry> = {}): CapabilityEntry => ({
  capabilityId: 'models:claude-code/claude-opus-4-8', capabilityKind: 'model', doorwayId: 'claude-code', machineId: 'm1',
  probeOutcome: 'positive', endpointRef: 'mesh://m1/doorways', observedAt: '2026-07-25T00:00:00Z', receivedAt: '2026-07-25T00:00:01Z',
  source: 'local-doorways', sourceDetail: 'doorway-scan', evidenceClass: 'probe-answered', evidence: { doorwayScanAt: '2026-07-25T00:00:00Z' }, ...overrides,
});
const projection = (overrides: Partial<CapabilityProjection> = {}): CapabilityProjection => ({
  schemaVersion: 1, machineId: 'm1', machineEpoch: 1, projectionSeq: 1, scanStampSecs: 1, scanState: 'observed', truncated: false, entries: [entry()], ...overrides,
});
const peerProjection = (machineId: string, overrides: Partial<CapabilityProjection> = {}): CapabilityProjection => ({
  ...projection(),
  machineId,
  entries: [entry({ machineId, endpointRef: `mesh://${machineId}/doorways` })],
  ...overrides,
});

describe('CapabilityRegistry digest determinism', () => {
  it('rebuilds identical facts to byte-identical digests', () => expect(canonicalDigest(projection())).toBe(canonicalDigest(projection())));
  it('ignores timestamp-only restamps', () => expect(canonicalDigest(projection())).toBe(canonicalDigest(projection({ entries: [entry({ observedAt: '2026-07-25T05:00:00Z', receivedAt: '2026-07-25T05:00:01Z' })] }))));
});

describe('CapabilityRegistry width clamps', () => {
  it('keeps maximum-width envelope digest at or below 64 bytes', () => {
    const p = projection({ machineEpoch: 9_999_999_999, projectionSeq: 9_999_999_999, scanStampSecs: 9_999_999_999 });
    expect(Buffer.byteLength(canonicalDigest(p))).toBeLessThanOrEqual(64);
  });
  it('refuses over-width values at write validation', () => expect(() => validateProjection({ ...projection(), machineEpoch: 10_000_000_000 })).toThrow('machineEpoch-width'));
});

describe('CapabilityRegistry status matrix', () => {
  it('classifies every outcome/evidence/age combination and unknown never expires', () => {
    for (const outcome of ['positive', 'negative', 'unknown'] as const) for (const evidenceClass of ['cli-present', 'probe-answered', 'manifest-only'] as const) {
      const status = deriveStatus([entry({ probeOutcome: outcome, evidenceClass, observedAt: '2020-01-01T00:00:00Z' })], Date.parse('2026-01-01T00:00:00Z'));
      expect(['available', 'unavailable', 'unknown', 'stale']).toContain(status);
      if (outcome === 'unknown' || evidenceClass === 'manifest-only') expect(status).toBe('unknown');
    }
  });
});

describe('CapabilityRegistry own-source conflict', () => {
  it('keeps both source provenances visible and derives conflict', () => {
    const a = entry({ sourceDetail: 'doorway-scan', probeOutcome: 'positive' });
    const b = entry({ sourceDetail: 'doorway-manifest', probeOutcome: 'negative' });
    expect(deriveStatus([a, b])).toBe('conflict');
    expect(new Set([a.sourceDetail, b.sourceDetail])).toEqual(new Set(['doorway-scan', 'doorway-manifest']));
  });
});

describe('CapabilityRegistry adapter reality', () => {
  it('reads canonical manifest and scan-state data rather than returning a stub', () => {
    const projectDir = process.cwd();
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-reg-state-'));
    fs.mkdirSync(path.join(stateDir, 'state'));
    fs.writeFileSync(path.join(stateDir, 'state/doorway-scan.json'), JSON.stringify({ lastScanAt: '2026-07-25T00:00:00Z', doorways: [{ id: 'claude-code', probeStatus: 'ok', lastScannedAt: '2026-07-25T00:00:00Z' }] }));
    const result = readDoorwaySources(projectDir, stateDir, '2026-07-25T00:00:01Z');
    expect(() => validateProjection({ schemaVersion: 1, machineId: 'local', machineEpoch: 1, projectionSeq: 1, scanStampSecs: result.scanStampSecs, scanState: result.scanState, truncated: false, entries: result.entries })).not.toThrow();
    expect(result.scanStampSecs).toBe(Math.floor(Date.parse('2026-07-25T00:00:00Z') / 1000));
    expect(result.scanState).toBe('observed');
    expect(result.entries.length).toBeGreaterThan(2);
    expect(result.entries.map(e => e.sourceDetail)).toEqual(expect.arrayContaining(['doorway-scan', 'doorway-manifest']));
    expect(result.entries.find(e => e.sourceDetail === 'doorway-manifest')?.evidence.manifestVerifiedAt).toBeTruthy();
    expect(result.entries.find(e => e.sourceDetail === 'doorway-scan')).toMatchObject({ capabilityId: expect.stringMatching(/^models:claude-code\//), probeOutcome: 'positive' });
    fs.writeFileSync(path.join(stateDir, 'state/doorway-scan.json'), JSON.stringify({ lastScanAt: null, doorways: [] }));
    expect(readDoorwaySources(projectDir, stateDir).scanState).toBe('never-observed');
    fs.writeFileSync(path.join(stateDir, 'state/doorway-scan.json'), '{not-json');
    expect(readDoorwaySources(projectDir, stateDir).scanState).toBe('source-unavailable');
  });
});

describe('CapabilityRegistry manifest freshness', () => {
  it('marks a fresh scan row stale when manifest verification is old', () => {
    const scan = entry({ observedAt: '2026-07-25T00:00:00Z', evidenceClass: 'probe-answered', evidence: { doorwayScanAt: '2026-07-25T00:00:00Z', manifestVerifiedAt: '2026-06-01T00:00:00Z' } });
    expect(deriveStatus([scan], Date.parse('2026-07-25T01:00:00Z'))).toBe('stale');
  });
});

describe('CapabilityRegistry Increment 1 synthetic receiver fixtures', () => {
  it('local doorway joins validate through projection clamps and never expose raw endpoints', () => {
    const p = projection();
    expect(validateProjection(p).entries[0].endpointRef).toBe('mesh://m1/doorways');
    expect(() => validateProjection({ ...p, entries: [entry({ endpointRef: 'https://token@example.test/doorways' })] })).toThrow('endpoint-ref-invalid');
  });

  it('receiver TTL clamping covers ingest, matching-digest sequence, signed-time, and nonce pull arms', () => {
    const now = Date.parse('2026-07-25T00:00:00Z');
    const r = new CapabilityRegistryReceiver({ remoteTtlCeilingMs: 100 });
    const p = peerProjection('m2');
    expect(r.ingestProjection('m2', p, now)).toMatchObject({ status: 'accepted' });
    expect(r.classifyMachine('m2', now + 101)[0]).toMatchObject({ kind: 'capability', status: 'stale' });
    const digest = canonicalDigest({ ...p, entries: p.entries.map(e => ({ ...e, receivedAt: new Date(now).toISOString() })) });
    expect(r.ingestHeartbeat('m2', digest, now + 120, { kind: 'sequence', value: 1 })).toMatchObject({ status: 'noop' });
    expect(r.classifyMachine('m2', now + 200)[0]).toMatchObject({ kind: 'capability', status: 'stale' });
    expect(r.ingestHeartbeat('m2', digest, now + 220, { kind: 'signed-time', value: now + 220 })).toMatchObject({ status: 'noop' });
    expect(r.classifyMachine('m2', now + 300)[0]).toMatchObject({ kind: 'capability', status: 'stale' });
    expect(r.ingestPullResponse('m2', { nonce: 'n2', projection: p }, 'n2', now + 320)).toMatchObject({ status: 'noop' });
    expect(r.classifyMachine('m2', now + 400)[0]).toMatchObject({ kind: 'capability', status: 'stale' });
    expect(r.ingestPullResponse('m2', { nonce: 'wrong', projection: p }, 'n2', now + 420)).toEqual({ status: 'rejected', reason: 'malformed' });
  });

  it('origin-mismatch rejects the whole peer projection', () => {
    const r = new CapabilityRegistryReceiver();
    expect(r.ingestProjection('m2', peerProjection('m1'))).toEqual({ status: 'rejected', reason: 'origin-mismatch' });
    expect(r.classifyMachine('m2')[0]).toMatchObject({ kind: 'failure', reason: 'origin-mismatch' });
  });

  it('epoch/seq replay rejects lower pairs and equal-pair different digests', () => {
    const r = new CapabilityRegistryReceiver();
    expect(r.ingestProjection('m2', peerProjection('m2', { machineEpoch: 5, projectionSeq: 10 }))).toMatchObject({ status: 'accepted' });
    expect(r.ingestProjection('m2', peerProjection('m2', { machineEpoch: 5, projectionSeq: 9 }))).toEqual({ status: 'rejected', reason: 'stale-projection' });
    const changed = peerProjection('m2', { machineEpoch: 5, projectionSeq: 10, scanStampSecs: 2 });
    expect(r.ingestProjection('m2', changed)).toEqual({ status: 'rejected', reason: 'stale-projection' });
  });

  it('epoch supersession recovers after origin reinitialization', () => {
    const r = new CapabilityRegistryReceiver();
    expect(r.ingestProjection('m2', peerProjection('m2', { machineEpoch: 5, projectionSeq: 10 }))).toMatchObject({ status: 'accepted' });
    expect(r.ingestProjection('m2', peerProjection('m2', { machineEpoch: 6, projectionSeq: 0 }))).toMatchObject({ status: 'accepted' });
  });

  it('epoch sanity clamp rejects far-future origin epochs', () => {
    const now = Date.parse('2026-07-25T00:00:00Z');
    const r = new CapabilityRegistryReceiver({ epochClampBoundMs: 1_000 });
    expect(r.ingestProjection('m2', peerProjection('m2', { machineEpoch: Math.floor((now + 5_000) / 1000) }), now)).toEqual({ status: 'rejected', reason: 'clock-skew' });
  });

  it('watermark aging heals a locked-out origin after the receiver-owned bound', () => {
    const now = Date.parse('2026-07-25T00:00:00Z');
    const r = new CapabilityRegistryReceiver({ watermarkMaxAgeMs: 1_000 });
    expect(r.ingestProjection('m2', peerProjection('m2', { machineEpoch: 50, projectionSeq: 0 }), now)).toMatchObject({ status: 'accepted' });
    expect(r.ingestProjection('m2', peerProjection('m2', { machineEpoch: 40, projectionSeq: 0 }), now + 500)).toEqual({ status: 'rejected', reason: 'stale-projection' });
    expect(r.ingestProjection('m2', peerProjection('m2', { machineEpoch: 40, projectionSeq: 0 }), now + 1_001)).toMatchObject({ status: 'accepted' });
  });

  it('timestamp-excluded digest stays stable across observed, received, and evidence restamps', () => {
    const a = projection();
    const b = projection({ entries: [entry({ observedAt: '2026-07-25T01:00:00Z', receivedAt: '2026-07-25T01:00:01Z', evidence: { doorwayScanAt: '2026-07-25T01:00:00Z', manifestVerifiedAt: '2026-07-24T00:00:00Z' } })] });
    expect(canonicalDigest(a)).toBe(canonicalDigest(b));
  });

  it('received over-limit projections reject whole, while the local writer marks deterministic truncation', () => {
    const many = Array.from({ length: MAX_ENTRIES_PER_MACHINE + 1 }, (_, i) => entry({ capabilityId: `models:claude-code/model-${i}`, doorwayId: 'claude-code' }));
    expect(() => validateProjection(projection({ entries: many }))).toThrow('over-limit');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-reg-writer-'));
    const writer = new CapabilityRegistryWriter(path.join(tmp, 'state/capability-registry.json'), 'm1');
    const written = writer.write({ schemaVersion: 1, machineEpoch: 1, projectionSeq: 1, scanStampSecs: 1, scanState: 'observed', truncated: false, entries: many });
    expect(written.truncated).toBe(true);
    expect(written.entries.length).toBe(MAX_ENTRIES_PER_MACHINE);
  });

  it('malformed rows and unsupported versions classify with closed failure reasons', () => {
    const r = new CapabilityRegistryReceiver();
    expect(r.ingestProjection('m2', peerProjection('m2', { entries: [{ ...peerProjection('m2').entries[0], sourceDetail: 'unknown-source' as never }] }))).toEqual({ status: 'rejected', reason: 'malformed' });
    expect(r.ingestProjection('m2', { ...peerProjection('m2'), schemaVersion: 2 })).toEqual({ status: 'rejected', reason: 'version-unsupported' });
  });

  it('digest determinism ignores entry order for identical fact state', () => {
    const a = entry({ capabilityId: 'models:claude-code/a' });
    const b = entry({ capabilityId: 'models:claude-code/b' });
    expect(canonicalDigest(projection({ entries: [a, b] }))).toBe(canonicalDigest(projection({ entries: [b, a] })));
  });

  it('not-participating classification is distinct from no-data-yet', () => {
    const r = new CapabilityRegistryReceiver();
    r.ingestHeartbeat('m2', undefined);
    expect(r.classifyPool(['m2', 'm3']).filter(row => row.kind === 'failure')).toEqual(expect.arrayContaining([
      { kind: 'failure', machineId: 'm2', reason: 'not-participating' },
      { kind: 'failure', machineId: 'm3', reason: 'no-data-yet' },
    ]));
  });

  it('digest-flap brake suppresses pulls after repeated validation failures', () => {
    const r = new CapabilityRegistryReceiver({ pullFailureBreakerThreshold: 2, pullBreakerMs: 1_000 });
    const base = peerProjection('m2');
    r.ingestProjection('m2', base, 1_000);
    const changed1 = canonicalDigest(peerProjection('m2', { projectionSeq: 2, scanStampSecs: 2 }));
    expect(r.ingestHeartbeat('m2', changed1, 1_010, { kind: 'sequence', value: 1 })).toMatchObject({ status: 'pull-required' });
    r.recordPullFailure('m2', 'malformed', 1_011);
    const changed2 = canonicalDigest(peerProjection('m2', { projectionSeq: 3, scanStampSecs: 3 }));
    expect(r.ingestHeartbeat('m2', changed2, 1_020, { kind: 'sequence', value: 2 })).toMatchObject({ status: 'pull-required' });
    r.recordPullFailure('m2', 'malformed', 1_021);
    const changed3 = canonicalDigest(peerProjection('m2', { projectionSeq: 4, scanStampSecs: 4 }));
    expect(r.ingestHeartbeat('m2', changed3, 1_030, { kind: 'sequence', value: 3 })).toEqual({ status: 'pull-suppressed', reason: 'timeout' });
  });

  it('partial pool failures preserve good rows beside participating-peer failures', () => {
    const r = new CapabilityRegistryReceiver();
    r.ingestProjection('m1', peerProjection('m1'));
    r.ingestHeartbeat('m2', undefined);
    const rows = r.classifyPool(['m1', 'm2', 'm3']);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'capability', machineId: 'm1', status: 'available' }),
      { kind: 'failure', machineId: 'm2', reason: 'not-participating' },
      { kind: 'failure', machineId: 'm3', reason: 'no-data-yet' },
    ]));
  });

  it('replayed identical heartbeat leaves lastConfirmedAt unchanged so the row goes stale on schedule', () => {
    const now = Date.parse('2026-07-25T00:00:00Z');
    const r = new CapabilityRegistryReceiver({ remoteTtlCeilingMs: 100 });
    const p = peerProjection('m2');
    r.ingestProjection('m2', p, now);
    const digest = canonicalDigest({ ...p, entries: p.entries.map(e => ({ ...e, receivedAt: new Date(now).toISOString() })) });
    r.ingestHeartbeat('m2', digest, now + 10, { kind: 'sequence', value: 1 });
    expect(r.getLastConfirmedAt('m2')).toBe(now);
    r.ingestHeartbeat('m2', digest, now + 20, { kind: 'sequence', value: 1 });
    expect(r.getLastConfirmedAt('m2')).toBe(now);
    expect(r.classifyMachine('m2', now + 111)[0]).toMatchObject({ kind: 'capability', status: 'stale' });
  });

  it('replayed pull response leaves lastConfirmedAt unchanged and wrong nonce classifies malformed', () => {
    const now = Date.parse('2026-07-25T00:00:00Z');
    const r = new CapabilityRegistryReceiver({ remoteTtlCeilingMs: 100 });
    const p = peerProjection('m2');
    r.ingestProjection('m2', p, now);
    r.ingestPullResponse('m2', { nonce: 'n1', projection: p }, 'n1', now + 10);
    expect(r.getLastConfirmedAt('m2')).toBe(now);
    expect(r.ingestPullResponse('m2', { nonce: 'n1', projection: p }, 'n2', now + 20)).toEqual({ status: 'rejected', reason: 'malformed' });
    expect(r.getLastConfirmedAt('m2')).toBe(now);
    expect(r.getFailureReason('m2')).toBe('malformed');
    expect(r.classifyMachine('m2', now + 111)[0]).toMatchObject({ kind: 'capability', status: 'stale' });
  });
});
