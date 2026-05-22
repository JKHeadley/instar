/**
 * Unit tests for src/core/version-skew.ts — the shared module that both
 * detects major.minor crossings and manages the coordinated-restart signal
 * file consumed by the lifeline, server, and fleet watchdog.
 *
 * Spec: docs/specs/auto-updater-lifeline-coordination.md
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  crossesBreaking,
  writeLifelineRestartSignal,
  readLifelineRestartSignal,
  clearLifelineRestartSignal,
  lifelineRestartSignalPath,
} from '../../../src/core/version-skew.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';

describe('crossesBreaking', () => {
  it('returns false for identical versions', () => {
    expect(crossesBreaking('1.2.28', '1.2.28')).toBe(false);
  });

  it('returns false within same major.minor (patch bumps)', () => {
    expect(crossesBreaking('1.2.0', '1.2.28')).toBe(false);
    expect(crossesBreaking('1.2.28', '1.2.29')).toBe(false);
    expect(crossesBreaking('0.28.103', '0.28.112')).toBe(false);
  });

  it('returns true on minor crossing', () => {
    expect(crossesBreaking('1.1.0', '1.2.0')).toBe(true);
    expect(crossesBreaking('1.1.99', '1.2.0')).toBe(true);
    expect(crossesBreaking('0.28.112', '0.29.0')).toBe(true);
  });

  it('returns true on major crossing', () => {
    expect(crossesBreaking('1.99.0', '2.0.0')).toBe(true);
    expect(crossesBreaking('1.2.28', '2.0.0')).toBe(true);
  });

  it('fail-safe (true) on missing/malformed inputs — false-positive is harmless, false-negative is the incident class', () => {
    expect(crossesBreaking(null, '1.2.0')).toBe(true);
    expect(crossesBreaking('1.2.0', null)).toBe(true);
    expect(crossesBreaking(undefined, undefined)).toBe(true);
    expect(crossesBreaking('', '1.2.0')).toBe(true);
    expect(crossesBreaking('not-a-version', '1.2.0')).toBe(true);
    expect(crossesBreaking('1.2.0', 'not-a-version')).toBe(true);
    expect(crossesBreaking('1.2', '1.2.0')).toBe(true); // missing patch component
  });

  it('strips pre-release suffixes implicitly via regex anchor', () => {
    // The regex matches the leading numeric portion. '1.2.0-rc.1' has the
    // same major.minor as '1.2.0' so they should not be considered crossing.
    expect(crossesBreaking('1.2.0', '1.2.0-rc.1')).toBe(false);
    expect(crossesBreaking('1.1.0-beta', '1.2.0')).toBe(true);
  });
});

describe('lifeline-restart signal file lifecycle', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifeline-signal-'));
  });
  afterEach(() => {
    try { SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/core/version-skew.test.ts:cleanup' }); } catch { /* ignore */ }
  });

  it('writeLifelineRestartSignal creates state/lifeline-restart-requested.json atomically', () => {
    const outcome = writeLifelineRestartSignal({
      stateDir: tmpDir,
      requestedBy: 'auto-updater',
      reason: 'version-bump',
      previousVersion: '1.1.0',
      targetVersion: '1.2.28',
    });
    expect(outcome).toBe('written');

    const signalPath = lifelineRestartSignalPath(tmpDir);
    expect(fs.existsSync(signalPath)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(signalPath, 'utf-8'));
    expect(parsed.requestedBy).toBe('auto-updater');
    expect(parsed.reason).toBe('version-bump');
    expect(parsed.previousVersion).toBe('1.1.0');
    expect(parsed.targetVersion).toBe('1.2.28');
    expect(typeof parsed.requestedAt).toBe('string');
    expect(typeof parsed.expiresAt).toBe('string');
    expect(Date.parse(parsed.expiresAt)).toBeGreaterThan(Date.parse(parsed.requestedAt));
  });

  it('writeLifelineRestartSignal is idempotent — skips when fresh signal matches targetVersion', () => {
    const first = writeLifelineRestartSignal({
      stateDir: tmpDir,
      requestedBy: 'auto-updater',
      reason: 'first',
      previousVersion: '1.1.0',
      targetVersion: '1.2.28',
    });
    expect(first).toBe('written');

    const second = writeLifelineRestartSignal({
      stateDir: tmpDir,
      requestedBy: 'server-426',
      reason: 'second',
      previousVersion: '1.1.0',
      targetVersion: '1.2.28',
    });
    expect(second).toBe('skipped-fresh');

    // Original signal preserved — second writer didn't trample.
    const parsed = JSON.parse(fs.readFileSync(lifelineRestartSignalPath(tmpDir), 'utf-8'));
    expect(parsed.requestedBy).toBe('auto-updater');
    expect(parsed.reason).toBe('first');
  });

  it('writeLifelineRestartSignal replaces a stale signal for the same target', () => {
    const expired = {
      requestedAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
      requestedBy: 'auto-updater',
      reason: 'old',
      previousVersion: '1.1.0',
      targetVersion: '1.2.28',
      expiresAt: new Date(Date.now() - 3600_000).toISOString(),
    };
    const signalPath = lifelineRestartSignalPath(tmpDir);
    fs.mkdirSync(path.dirname(signalPath), { recursive: true });
    fs.writeFileSync(signalPath, JSON.stringify(expired));

    const outcome = writeLifelineRestartSignal({
      stateDir: tmpDir,
      requestedBy: 'server-426',
      reason: 'fresh',
      previousVersion: '1.1.0',
      targetVersion: '1.2.28',
    });
    expect(outcome).toBe('replaced-stale');

    const parsed = JSON.parse(fs.readFileSync(signalPath, 'utf-8'));
    expect(parsed.reason).toBe('fresh');
  });

  it('writeLifelineRestartSignal replaces when targetVersion differs', () => {
    writeLifelineRestartSignal({
      stateDir: tmpDir,
      requestedBy: 'auto-updater',
      reason: 'first',
      previousVersion: '1.1.0',
      targetVersion: '1.2.28',
    });

    const outcome = writeLifelineRestartSignal({
      stateDir: tmpDir,
      requestedBy: 'auto-updater',
      reason: 'second',
      previousVersion: '1.2.28',
      targetVersion: '1.3.0',
    });
    // Different targetVersion → not "skipped-fresh"; treated as replacement.
    expect(outcome).toBe('replaced-stale');
    const parsed = JSON.parse(fs.readFileSync(lifelineRestartSignalPath(tmpDir), 'utf-8'));
    expect(parsed.targetVersion).toBe('1.3.0');
  });

  it('readLifelineRestartSignal returns parsed signal for fresh file', () => {
    writeLifelineRestartSignal({
      stateDir: tmpDir,
      requestedBy: 'post-update-migrator-bootstrap',
      reason: 'bootstrap',
      previousVersion: '1.0.13',
      targetVersion: '1.2.28',
    });
    const signal = readLifelineRestartSignal(tmpDir);
    expect(signal).not.toBeNull();
    expect(signal!.requestedBy).toBe('post-update-migrator-bootstrap');
    expect(signal!.targetVersion).toBe('1.2.28');
  });

  it('readLifelineRestartSignal returns null for expired signal', () => {
    const expired = {
      requestedAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
      requestedBy: 'auto-updater',
      reason: 'old',
      previousVersion: '1.1.0',
      targetVersion: '1.2.28',
      expiresAt: new Date(Date.now() - 3600_000).toISOString(),
    };
    const signalPath = lifelineRestartSignalPath(tmpDir);
    fs.mkdirSync(path.dirname(signalPath), { recursive: true });
    fs.writeFileSync(signalPath, JSON.stringify(expired));

    expect(readLifelineRestartSignal(tmpDir)).toBeNull();
  });

  it('readLifelineRestartSignal returns null for missing file (no error)', () => {
    expect(readLifelineRestartSignal(tmpDir)).toBeNull();
  });

  it('readLifelineRestartSignal returns null for corrupt JSON (no throw)', () => {
    const signalPath = lifelineRestartSignalPath(tmpDir);
    fs.mkdirSync(path.dirname(signalPath), { recursive: true });
    fs.writeFileSync(signalPath, '{not valid json}');
    expect(readLifelineRestartSignal(tmpDir)).toBeNull();
  });

  it('clearLifelineRestartSignal removes the file', () => {
    writeLifelineRestartSignal({
      stateDir: tmpDir,
      requestedBy: 'auto-updater',
      reason: 'test',
      previousVersion: '1.1.0',
      targetVersion: '1.2.28',
    });
    expect(fs.existsSync(lifelineRestartSignalPath(tmpDir))).toBe(true);
    clearLifelineRestartSignal(tmpDir);
    expect(fs.existsSync(lifelineRestartSignalPath(tmpDir))).toBe(false);
  });

  it('clearLifelineRestartSignal is a no-op when file is absent (no throw)', () => {
    expect(() => clearLifelineRestartSignal(tmpDir)).not.toThrow();
  });

  it('respects custom TTL', () => {
    const now = Date.now();
    writeLifelineRestartSignal({
      stateDir: tmpDir,
      requestedBy: 'auto-updater',
      reason: 'test',
      previousVersion: '1.1.0',
      targetVersion: '1.2.28',
      ttlMs: 5 * 60 * 1000, // 5 min
      now,
    });
    const signal = readLifelineRestartSignal(tmpDir, now);
    expect(signal).not.toBeNull();
    const expires = Date.parse(signal!.expiresAt);
    expect(expires - now).toBeCloseTo(5 * 60 * 1000, -2);
  });
});
