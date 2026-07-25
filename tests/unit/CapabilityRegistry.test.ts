import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
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
