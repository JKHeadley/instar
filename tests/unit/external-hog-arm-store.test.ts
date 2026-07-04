import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadArmState, armStore, disarmStore, armMarkerPath,
} from '../../src/monitoring/ExternalHogArmStore.js';
import { isMarkerValid, canKillLive, classContentHash } from '../../src/monitoring/ExternalHogArmMarker.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

/**
 * ExternalHogArmStore — the durable armed-marker file (CMT-1901 §7-§8). These tests prove the
 * two load-bearing safety properties end-to-end against the real marker validators: a disarm can
 * never be silently un-done (epoch monotonicity), a fresh arm is always needed to return to
 * live-kill, per-class content-hash scope, and FAIL-CLOSED reads on a corrupt/missing file.
 */

const CLASS = 'vscode-exthost';
const HASH = classContentHash(['^Code Helper \\(Plugin\\)$', 'extensionHost']);
const LIVE = { enabled: true, dryRun: false };
const iso = (s: string) => () => s;

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hog-arm-')); });
afterEach(() => { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/external-hog-arm-store.test.ts' }); });

describe('loadArmState — fresh + fail-closed', () => {
  it('a missing file reads as DISARMED (marker null, not armed)', () => {
    const s = loadArmState(dir);
    expect(s.marker).toBeNull();
    expect(s.lastDisarmEpoch).toBe(0);
    expect(isMarkerValid(s.marker, s.lastDisarmEpoch)).toBe(false);
  });
  it('a corrupt file fails CLOSED (marker null), never throws', () => {
    fs.writeFileSync(armMarkerPath(dir), '{ this is not json');
    const s = loadArmState(dir);
    expect(s.marker).toBeNull();
    expect(canKillLive(LIVE, s.marker, s.lastDisarmEpoch, CLASS, HASH)).toBe(false);
  });
  it('a wrong-shape marker (non-string hash) fails CLOSED', () => {
    fs.writeFileSync(armMarkerPath(dir), JSON.stringify({ marker: { armEpoch: 1, armedBy: 'pin', armedAt: 't', allowlistSnapshot: { [CLASS]: 123 } }, lastDisarmEpoch: 0 }));
    expect(loadArmState(dir).marker).toBeNull();
  });
});

describe('armStore — a PIN arm authorizes exactly the consented class', () => {
  it('arm writes armEpoch 1 and authorizes the armed class under live config', () => {
    const marker = armStore(dir, { [CLASS]: HASH }, 'pin', iso('2026-07-04T00:00:00Z'));
    expect(marker.armEpoch).toBe(1);
    const s = loadArmState(dir);
    expect(isMarkerValid(s.marker, s.lastDisarmEpoch)).toBe(true);
    expect(canKillLive(LIVE, s.marker, s.lastDisarmEpoch, CLASS, HASH)).toBe(true);
  });
  it('a class NOT in the snapshot, or a BROADENED (hash-changed) class, is not armed', () => {
    armStore(dir, { [CLASS]: HASH }, 'pin', iso('t'));
    const s = loadArmState(dir);
    expect(canKillLive(LIVE, s.marker, s.lastDisarmEpoch, 'other-class', HASH)).toBe(false); // new class
    expect(canKillLive(LIVE, s.marker, s.lastDisarmEpoch, CLASS, 'DIFFERENT_HASH')).toBe(false); // broadened
  });
  it('the marker file is written 0600', () => {
    armStore(dir, { [CLASS]: HASH }, 'pin', iso('t'));
    const mode = fs.statSync(armMarkerPath(dir)).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe('disarmStore — a disarm can NEVER be silently un-done (epoch monotonicity)', () => {
  it('disarm invalidates the marker (armEpoch <= lastDisarmEpoch)', () => {
    armStore(dir, { [CLASS]: HASH }, 'pin', iso('t'));
    disarmStore(dir, iso('t2'));
    const s = loadArmState(dir);
    expect(isMarkerValid(s.marker, s.lastDisarmEpoch)).toBe(false);
    expect(s.lastDisarmEpoch).toBeGreaterThanOrEqual(s.marker!.armEpoch);
    expect(canKillLive(LIVE, s.marker, s.lastDisarmEpoch, CLASS, HASH)).toBe(false);
  });
  it('after a disarm, live config alone does NOT re-arm — only a fresh arm (higher epoch) does', () => {
    armStore(dir, { [CLASS]: HASH }, 'pin', iso('t'));        // armEpoch 1
    disarmStore(dir, iso('t2'));                               // lastDisarmEpoch 1
    // Simulate a reboot: reload. Config says live, but the marker is invalid.
    let s = loadArmState(dir);
    expect(canKillLive(LIVE, s.marker, s.lastDisarmEpoch, CLASS, HASH)).toBe(false);
    // A fresh PIN arm mints armEpoch 2 (> lastDisarmEpoch 1) → armed again.
    const m2 = armStore(dir, { [CLASS]: HASH }, 'pin', iso('t3'));
    expect(m2.armEpoch).toBe(2);
    s = loadArmState(dir);
    expect(canKillLive(LIVE, s.marker, s.lastDisarmEpoch, CLASS, HASH)).toBe(true);
  });
  it('disarm is idempotent (a second disarm keeps it disarmed, epoch does not regress)', () => {
    armStore(dir, { [CLASS]: HASH }, 'pin', iso('t'));
    const a = disarmStore(dir, iso('t2')).lastDisarmEpoch;
    const b = disarmStore(dir, iso('t3')).lastDisarmEpoch;
    expect(b).toBeGreaterThanOrEqual(a);
    expect(isMarkerValid(loadArmState(dir).marker, b)).toBe(false);
  });
});
