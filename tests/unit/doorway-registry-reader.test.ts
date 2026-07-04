// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Tier-1 unit tests for the Doorway/Model Knowledge Registry read-side reader
 * (docs/specs/DOORWAY-MODEL-KNOWLEDGE-REGISTRY-SPEC.md §D5 / §1.3). Covers:
 *   - the D5 two-state contract at the reader layer (never-run / scanned / no-manifest / corrupt);
 *   - the merged view (canonical topModels overlaid with live reachability, keyed by doorId);
 *   - reachable DERIVED from the clamped probeStatus (P20 tri-state, never the stored boolean);
 *   - the EXHAUSTIVE read-clamp of the untrusted machine-local scan-state (§1.3);
 *   - a mirror-pin asserting the TS clamp constants match the prober's exported source of truth.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readDoorwayRegistry,
  probeStatusToReachable,
  PROBE_STATUS_ENUM,
  NEVER_SCANNED,
} from '../../src/core/DoorwayRegistryReader.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
// The prober is the SOURCE OF TRUTH for the clamp constants the reader mirrors (§1.3).
import {
  PROBE_STATUS_ENUM as PROBER_ENUM,
  probeStatusToReachable as proberReachable,
} from '../../scripts/doorway-scan.mjs';

const MANIFEST = {
  registrySchemaVersion: 2,
  stalenessWindowDays: 45,
  enforcement: 'report',
  doors: {
    'claude-code': {
      name: 'Claude Code CLI',
      status: 'alive',
      probe: { kind: 'cli-version', bin: 'claude', metered: false },
      topModels: [
        { id: 'claude-opus-4-8', role: 'capable-anthropic', frontier: true, pricing: null, verifiedAt: 'carried-over-from-allowlist' },
        { id: 'claude-fable-5', role: 'ultra-anthropic', frontier: true, pricing: null, verifiedAt: 'carried-over-from-allowlist' },
      ],
    },
    'codex-cli': {
      name: 'Codex CLI',
      status: 'alive',
      probe: { kind: 'cli-version', bin: 'codex', metered: false },
      topModels: [{ id: 'gpt-5-codex', role: 'capable-openai', frontier: true, pricing: null, verifiedAt: 'carried-over-from-allowlist' }],
    },
  },
  candidateDoorways: ['claude-code', 'codex-cli', 'openrouter'],
};

function writeManifest(projectDir: string, obj: unknown): void {
  const dir = path.join(projectDir, 'scripts');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'model-registry-freshness.manifest.json'), typeof obj === 'string' ? obj : JSON.stringify(obj));
}
function writeScanState(stateDir: string, obj: unknown): void {
  const dir = path.join(stateDir, 'state');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'doorway-scan.json'), typeof obj === 'string' ? obj : JSON.stringify(obj));
}

describe('DoorwayRegistryReader — D5 two-state contract + merged view + §1.3 read-clamp', () => {
  let tmp: string;
  let projectDir: string;
  let stateDir: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'doorway-reader-'));
    projectDir = path.join(tmp, 'proj');
    stateDir = path.join(projectDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/unit/doorway-registry-reader.test.ts' });
  });

  it('mirror-pin: the reader clamp constants match the prober source of truth', () => {
    expect([...PROBE_STATUS_ENUM]).toEqual([...PROBER_ENUM]);
    for (const s of PROBER_ENUM) {
      expect(probeStatusToReachable(s as never)).toBe(proberReachable(s));
    }
  });

  it('no manifest → status:no-manifest (a non-instar-source install)', () => {
    const r = readDoorwayRegistry({ projectDir, stateDir });
    expect(r.status).toBe('no-manifest');
  });

  it('manifest present but unparseable → status:corrupt', () => {
    writeManifest(projectDir, '{ this is not json ');
    const r = readDoorwayRegistry({ projectDir, stateDir });
    expect(r.status).toBe('corrupt');
  });

  it('manifest present but missing doors object → status:corrupt', () => {
    writeManifest(projectDir, { registrySchemaVersion: 2 });
    const r = readDoorwayRegistry({ projectDir, stateDir });
    expect(r.status).toBe('corrupt');
  });

  it('D5(a) never-run: manifest present, no scan-state → 200-shape, scanState:never-run, honest-empty live fields + canonical topModels', () => {
    writeManifest(projectDir, MANIFEST);
    const r = readDoorwayRegistry({ projectDir, stateDir });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.body.scanState).toBe('never-run');
    expect(r.body.lastScanAt).toBeNull();
    expect(r.body.doorways.map((d) => d.doorId).sort()).toEqual(['claude-code', 'codex-cli']);
    const cc = r.body.doorways.find((d) => d.doorId === 'claude-code')!;
    expect(cc.reachable).toBeNull();
    expect(cc.probeStatus).toBe(NEVER_SCANNED);
    expect(cc.lastScannedAt).toBeNull();
    // canonical topModels are projected (never fabricated empty).
    expect(cc.topModels.map((m) => m.id)).toEqual(['claude-opus-4-8', 'claude-fable-5']);
    expect(cc.topModels[0].frontier).toBe(true);
    expect(cc.topModels[0].verifiedAt).toBe('carried-over-from-allowlist');
  });

  it('scan-state file present but lastScanAt null (freshScanState) → still never-run', () => {
    writeManifest(projectDir, MANIFEST);
    writeScanState(stateDir, { schemaVersion: 1, lastScanAt: null, doorways: [] });
    const r = readDoorwayRegistry({ projectDir, stateDir });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.body.scanState).toBe('never-run');
  });

  it('D5(b) scanned: merged view; reachable DERIVED from clamped probeStatus (P20 tri-state)', () => {
    writeManifest(projectDir, MANIFEST);
    writeScanState(stateDir, {
      schemaVersion: 1,
      machineId: 'mac-mini',
      lastScanAt: '2026-07-04T10:00:00.000Z',
      doorways: [
        { id: 'claude-code', reachable: true, probeStatus: 'ok', lastScannedAt: '2026-07-04T10:00:00.000Z' },
        { id: 'codex-cli', reachable: false, probeStatus: 'timeout', lastScannedAt: '2026-07-04T10:00:00.000Z' },
      ],
    });
    const r = readDoorwayRegistry({ projectDir, stateDir });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.body.scanState).toBe('scanned');
    expect(r.body.lastScanAt).toBe('2026-07-04T10:00:00.000Z');
    expect(r.body.machineId).toBe('mac-mini');
    const cc = r.body.doorways.find((d) => d.doorId === 'claude-code')!;
    expect(cc.probeStatus).toBe('ok');
    expect(cc.reachable).toBe(true); // ok → true
    const cx = r.body.doorways.find((d) => d.doorId === 'codex-cli')!;
    expect(cx.probeStatus).toBe('timeout');
    // timeout is UNKNOWN (P20) → reachable null even though the poisoned stored boolean said false.
    expect(cx.reachable).toBeNull();
  });

  it('reachable mapping per definitive status: not-installed / http-4xx → false; malformed-response → true (parse-drift)', () => {
    writeManifest(projectDir, MANIFEST);
    writeScanState(stateDir, {
      schemaVersion: 1,
      lastScanAt: '2026-07-04T10:00:00.000Z',
      doorways: [
        { id: 'claude-code', probeStatus: 'not-installed', lastScannedAt: '2026-07-04T10:00:00.000Z' },
        { id: 'codex-cli', probeStatus: 'malformed-response', lastScannedAt: '2026-07-04T10:00:00.000Z' },
      ],
    });
    const r = readDoorwayRegistry({ projectDir, stateDir });
    if (r.status !== 'ok') throw new Error('expected ok');
    expect(r.body.doorways.find((d) => d.doorId === 'claude-code')!.reachable).toBe(false);
    // parse-drift on a door that DID answer → stays reachable:true.
    expect(r.body.doorways.find((d) => d.doorId === 'codex-cli')!.reachable).toBe(true);
  });

  it('§1.3 read-clamp: poisoned scan-state is contained (bad enum → malformed, injection door-id dropped, bad ts → null, unknown door dropped)', () => {
    writeManifest(projectDir, MANIFEST);
    writeScanState(stateDir, {
      schemaVersion: 1,
      lastScanAt: '2026-07-04T10:00:00.000Z',
      machineId: 'evil id',
      doorways: [
        // out-of-enum probeStatus → clamped to 'malformed-response'; bad timestamp → null.
        { id: 'claude-code', reachable: 'yes', probeStatus: 'HACKED<script>', lastScannedAt: 'not-a-date' },
        // door id with shell metacharacters → dropped entirely (falls back to never-scanned).
        { id: 'codex-cli; rm -rf /', probeStatus: 'ok', lastScannedAt: '2026-07-04T10:00:00.000Z' },
        // an id matching no known candidate → dropped.
        { id: 'totally-unknown-door', probeStatus: 'ok', lastScannedAt: '2026-07-04T10:00:00.000Z' },
      ],
    });
    const r = readDoorwayRegistry({ projectDir, stateDir });
    if (r.status !== 'ok') throw new Error('expected ok');
    // machineId control chars stripped.
    expect(r.body.machineId).toBe('evilid');
    const cc = r.body.doorways.find((d) => d.doorId === 'claude-code')!;
    expect(cc.probeStatus).toBe('malformed-response'); // out-of-enum coerced
    expect(cc.reachable).toBe(true); // derived from clamped 'malformed-response' — the poisoned string 'yes' is never trusted
    expect(cc.lastScannedAt).toBeNull(); // bad timestamp dropped
    // codex-cli had a metachar id → dropped → falls back to never-scanned honest-empty.
    const cx = r.body.doorways.find((d) => d.doorId === 'codex-cli')!;
    expect(cx.probeStatus).toBe(NEVER_SCANNED);
    expect(cx.reachable).toBeNull();
    // no fabricated 'totally-unknown-door' door appears.
    expect(r.body.doorways.some((d) => d.doorId === 'totally-unknown-door')).toBe(false);
  });

  it('corrupt scan-state never crashes the read → degrades to never-run', () => {
    writeManifest(projectDir, MANIFEST);
    writeScanState(stateDir, '{ not json at all ');
    const r = readDoorwayRegistry({ projectDir, stateDir });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.body.scanState).toBe('never-run');
    expect(r.body.doorways.every((d) => d.probeStatus === NEVER_SCANNED)).toBe(true);
  });
});
