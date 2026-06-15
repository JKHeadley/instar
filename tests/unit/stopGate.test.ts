/**
 * Unit tests for src/server/stopGate.ts (PR0a — context-death-pitfall-
 * prevention spec). Covers in-memory state holders, the compaction probe
 * (P0.6), and the hot-path assembly.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  GATE_ROUTE_VERSION,
  GATE_ROUTE_MINIMUM_VERSION,
  getMode,
  setMode,
  getKillSwitch,
  setKillSwitch,
  recordSessionStart,
  getSessionStartTs,
  compactionInFlight,
  getHotPathState,
  resolveTopicForTmux,
  _resetForTests,
} from '../../src/server/stopGate.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('stopGate — version contract', () => {
  it('exports version constants as positive integers', () => {
    expect(Number.isInteger(GATE_ROUTE_VERSION)).toBe(true);
    expect(GATE_ROUTE_VERSION).toBeGreaterThan(0);
    expect(Number.isInteger(GATE_ROUTE_MINIMUM_VERSION)).toBe(true);
    expect(GATE_ROUTE_MINIMUM_VERSION).toBeGreaterThan(0);
    expect(GATE_ROUTE_MINIMUM_VERSION).toBeLessThanOrEqual(GATE_ROUTE_VERSION);
  });
});

describe('stopGate — mode + kill-switch', () => {
  beforeEach(() => _resetForTests());

  it('defaults mode to off so PR0a ships completely inert', () => {
    expect(getMode()).toBe('off');
  });

  it('round-trips mode set/get', () => {
    setMode('shadow');
    expect(getMode()).toBe('shadow');
    setMode('enforce');
    expect(getMode()).toBe('enforce');
    setMode('off');
    expect(getMode()).toBe('off');
  });

  it('defaults killSwitch to false', () => {
    expect(getKillSwitch()).toBe(false);
  });

  it('setKillSwitch returns prior value', () => {
    expect(setKillSwitch(true)).toBe(false);
    expect(getKillSwitch()).toBe(true);
    expect(setKillSwitch(true)).toBe(true);
    expect(setKillSwitch(false)).toBe(true);
    expect(getKillSwitch()).toBe(false);
  });
});

describe('stopGate — sessionStartTs', () => {
  beforeEach(() => _resetForTests());

  it('records and retrieves a session start timestamp', () => {
    recordSessionStart('sess-1', 1700000000000);
    expect(getSessionStartTs('sess-1')).toBe(1700000000000);
  });

  it('first SessionStart wins (idempotent — later resumes do not overwrite)', () => {
    recordSessionStart('sess-1', 1700000000000);
    recordSessionStart('sess-1', 1700000999999);
    expect(getSessionStartTs('sess-1')).toBe(1700000000000);
  });

  it('returns null for unknown session id', () => {
    expect(getSessionStartTs('never-seen')).toBeNull();
  });

  it('ignores empty session id (no crash, no record)', () => {
    recordSessionStart('', 1700000000000);
    expect(getSessionStartTs('')).toBeNull();
  });
});

describe('stopGate — compactionInFlight probe (P0.6)', () => {
  let tmpDir: string;
  let recoveryScript: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-gate-test-'));
    recoveryScript = path.join(tmpDir, 'compaction-recovery.sh');
    fs.writeFileSync(recoveryScript, '#!/bin/sh\n');
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/stopGate.test.ts:100' });
  });

  it('returns true when recovery script mtime is fresh (<60s)', () => {
    const now = Date.now();
    fs.utimesSync(recoveryScript, now / 1000, (now - 5_000) / 1000);
    expect(compactionInFlight({ recoveryScriptPath: recoveryScript, now })).toBe(true);
  });

  it('returns false when recovery script mtime is stale (>60s)', () => {
    const now = Date.now();
    fs.utimesSync(recoveryScript, now / 1000, (now - 120_000) / 1000);
    expect(compactionInFlight({ recoveryScriptPath: recoveryScript, now })).toBe(false);
  });

  it('returns false (fail-open) when recovery script does not exist', () => {
    const ghost = path.join(tmpDir, 'does-not-exist.sh');
    expect(compactionInFlight({ recoveryScriptPath: ghost })).toBe(false);
  });

  it('treats /tmp/claude-session-<id>/compacting marker as authoritative', () => {
    const sid = `unit-test-${process.pid}-${Date.now()}`;
    const markerDir = `/tmp/claude-session-${sid}`;
    const marker = `${markerDir}/compacting`;
    try {
      fs.mkdirSync(markerDir, { recursive: true });
      fs.writeFileSync(marker, '');
      expect(
        compactionInFlight({ sessionId: sid, recoveryScriptPath: '/no/such/path' })
      ).toBe(true);
    } finally {
      SafeFsExecutor.safeRmSync(markerDir, { recursive: true, force: true, operation: 'tests/unit/stopGate.test.ts:132' });
    }
  });
});

describe('stopGate — getHotPathState', () => {
  beforeEach(() => _resetForTests());

  it('returns all five fields plus routeVersion in one call', () => {
    const state = getHotPathState({
      sessionId: 'sess-h',
      autonomousActiveOverride: false,
      recoveryScriptPath: '/no/such/path',
    });
    expect(state).toMatchObject({
      mode: 'off',
      killSwitch: false,
      autonomousActive: false,
      compactionInFlight: false,
      sessionStartTs: null,
      routeVersion: GATE_ROUTE_VERSION,
    });
  });

  it('reflects mode + killSwitch from state', () => {
    setMode('shadow');
    setKillSwitch(true);
    const state = getHotPathState({
      sessionId: 'sess-h',
      autonomousActiveOverride: true,
      recoveryScriptPath: '/no/such/path',
    });
    expect(state.mode).toBe('shadow');
    expect(state.killSwitch).toBe(true);
    expect(state.autonomousActive).toBe(true);
  });

  it('returns sessionStartTs when SessionStart was previously recorded', () => {
    recordSessionStart('sess-h', 1700000000000);
    const state = getHotPathState({
      sessionId: 'sess-h',
      autonomousActiveOverride: false,
      recoveryScriptPath: '/no/such/path',
    });
    expect(state.sessionStartTs).toBe(1700000000000);
  });

  it('reads autonomousActive from autonomous-state file when override absent', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-gate-auto-'));
    const stateFile = path.join(tmp, 'autonomous-state.local.md');
    try {
      fs.writeFileSync(stateFile, 'topic: 6931\n');
      const present = getHotPathState({
        sessionId: 'sess-h',
        autonomousStateFile: stateFile,
        recoveryScriptPath: '/no/such/path',
      });
      expect(present.autonomousActive).toBe(true);

      SafeFsExecutor.safeUnlinkSync(stateFile, { operation: 'tests/unit/stopGate.test.ts:192' });
      const absent = getHotPathState({
        sessionId: 'sess-h',
        autonomousStateFile: stateFile,
        recoveryScriptPath: '/no/such/path',
      });
      expect(absent.autonomousActive).toBe(false);
    } finally {
      SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/unit/stopGate.test.ts:201' });
    }
  });
});

// ── GAP-B (autonomous-run-registration-guarantee) — D1 read precedence ──────
describe('stopGate — D1 autonomousActive read precedence (GAP-B)', () => {
  let root: string;

  const perTopicFile = (topicId: string) =>
    path.join(root, '.instar', 'autonomous', `${topicId}.local.md`);
  const legacyInstarFile = () => path.join(root, '.instar', 'autonomous-state.local.md');
  const legacyClaudeFile = () => path.join(root, '.claude', 'autonomous-state.local.md');

  const writeFile = (file: string, body = 'active: true\n') => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  };

  beforeEach(() => {
    _resetForTests();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-gate-gapb-'));
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'tests/unit/stopGate.test.ts:gapb-d1' });
  });

  it('per-topic registration makes autonomousActive true (canonical path wins)', () => {
    writeFile(perTopicFile('6931'));
    const state = getHotPathState({
      sessionId: 'sess-h',
      stateRoot: root,
      topicId: '6931',
      recoveryScriptPath: '/no/such/path',
    });
    expect(state.autonomousActive).toBe(true);
  });

  it('per-topic for a DIFFERENT topic does NOT activate (only my topic counts)', () => {
    writeFile(perTopicFile('6931'));
    const state = getHotPathState({
      sessionId: 'sess-h',
      stateRoot: root,
      topicId: '9999', // my topic — no file for it, and no legacy files
      recoveryScriptPath: '/no/such/path',
    });
    expect(state.autonomousActive).toBe(false);
  });

  it('falls through to the .instar legacy single-file when no per-topic file exists', () => {
    writeFile(legacyInstarFile());
    const state = getHotPathState({
      sessionId: 'sess-h',
      stateRoot: root,
      topicId: '6931',
      recoveryScriptPath: '/no/such/path',
    });
    expect(state.autonomousActive).toBe(true);
  });

  it('falls through to the .claude oldest-legacy file when nothing above exists', () => {
    writeFile(legacyClaudeFile());
    const state = getHotPathState({
      sessionId: 'sess-h',
      stateRoot: root,
      topicId: '6931',
      recoveryScriptPath: '/no/such/path',
    });
    expect(state.autonomousActive).toBe(true);
  });

  it('returns false when none of the three paths exist', () => {
    const state = getHotPathState({
      sessionId: 'sess-h',
      stateRoot: root,
      topicId: '6931',
      recoveryScriptPath: '/no/such/path',
    });
    expect(state.autonomousActive).toBe(false);
  });

  it('topic-less (undefined topicId) still reads BOTH legacy paths', () => {
    // The unresolved-topic case: no per-topic read possible, but the legacy
    // fallbacks MUST still be checked — never a silent false.
    writeFile(legacyInstarFile());
    const state = getHotPathState({
      sessionId: 'sess-h',
      stateRoot: root,
      topicId: undefined,
      recoveryScriptPath: '/no/such/path',
    });
    expect(state.autonomousActive).toBe(true);
  });

  it('explicit autonomousStateFile override is the sole path read (back-compat)', () => {
    // A legacy single-file exists in the tree, but the explicit override
    // points at a DIFFERENT, absent file → false (override wins, ignores tree).
    writeFile(legacyInstarFile());
    const state = getHotPathState({
      sessionId: 'sess-h',
      stateRoot: root,
      topicId: '6931',
      autonomousStateFile: path.join(root, 'nowhere', 'absent.md'),
      recoveryScriptPath: '/no/such/path',
    });
    expect(state.autonomousActive).toBe(false);
  });
});

// ── GAP-B — D2 unresolved-topic fallback (the no-silent-fallback boundary) ───
describe('stopGate — D2 unresolved-topic boundary (GAP-B, both sides)', () => {
  let root: string;
  const legacyInstarFile = () => path.join(root, '.instar', 'autonomous-state.local.md');

  beforeEach(() => {
    _resetForTests();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-gate-gapb-d2-'));
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'tests/unit/stopGate.test.ts:gapb-d2' });
  });

  it('topic resolves (HIT) → per-topic file is read', () => {
    const perTopic = path.join(root, '.instar', 'autonomous', '6931.local.md');
    fs.mkdirSync(path.dirname(perTopic), { recursive: true });
    fs.writeFileSync(perTopic, 'active: true\n');
    const state = getHotPathState({
      sessionId: 'sess-h',
      stateRoot: root,
      topicId: '6931',
      recoveryScriptPath: '/no/such/path',
    });
    expect(state.autonomousActive).toBe(true);
  });

  it('topic MISS but a legacy file exists → does NOT silently return false', () => {
    // This is the no-silent-fallbacks boundary: a registry-lookup miss
    // (topicId undefined) must STILL surface the legacy registration.
    fs.mkdirSync(path.dirname(legacyInstarFile()), { recursive: true });
    fs.writeFileSync(legacyInstarFile(), 'active: true\n');
    const state = getHotPathState({
      sessionId: 'sess-h',
      stateRoot: root,
      topicId: undefined, // the MISS
      recoveryScriptPath: '/no/such/path',
    });
    expect(state.autonomousActive).toBe(true);
  });

  it('topic MISS and no legacy file → false (the genuinely-inactive case)', () => {
    const state = getHotPathState({
      sessionId: 'sess-h',
      stateRoot: root,
      topicId: undefined,
      recoveryScriptPath: '/no/such/path',
    });
    expect(state.autonomousActive).toBe(false);
  });
});

// ── GAP-B — resolveTopicForTmux (registry inversion, mirrors bash hook) ──────
describe('stopGate — resolveTopicForTmux (GAP-B D2 registry inversion)', () => {
  const registry = JSON.stringify({
    topicToSession: {
      '6931': 'echo-autonomous-mode',
      '12143': 'echo-other-topic',
    },
  });
  const reader = (_p: string) => registry;

  it('inverts topicToSession on the tmux name (HIT)', () => {
    expect(resolveTopicForTmux('/reg.json', 'echo-autonomous-mode', reader)).toBe('6931');
    expect(resolveTopicForTmux('/reg.json', 'echo-other-topic', reader)).toBe('12143');
  });

  it('returns null for an unknown tmux name (MISS)', () => {
    expect(resolveTopicForTmux('/reg.json', 'echo-never-seen', reader)).toBeNull();
  });

  it('returns null for a null/empty tmux name', () => {
    expect(resolveTopicForTmux('/reg.json', null, reader)).toBeNull();
    expect(resolveTopicForTmux('/reg.json', '', reader)).toBeNull();
  });

  it('fails open to null on a corrupt/missing registry (never throws)', () => {
    expect(resolveTopicForTmux('/reg.json', 'echo-autonomous-mode', () => 'not json')).toBeNull();
    expect(
      resolveTopicForTmux('/reg.json', 'echo-autonomous-mode', () => {
        throw new Error('ENOENT');
      }),
    ).toBeNull();
  });
});
