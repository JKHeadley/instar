/**
 * Tier-1 unit tests for CrossSessionCoordinator (the light cross-session
 * coordination signal). Spec: docs/specs/cross-session-coordination.md.
 *
 * Covers both sides of every decision boundary: enabled/disabled, in-window vs
 * out-of-window, same-actor vs different-actor vs unknown-actor, identical-action
 * dedupe, retention prune, cap, and reload-per-op persistence.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CrossSessionCoordinator } from '../../src/monitoring/CrossSessionCoordinator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('CrossSessionCoordinator', () => {
  let tmpDir: string;
  let stateDir: string;
  let clock: number;
  const now = () => clock;

  function make(overrides: Partial<ConstructorParameters<typeof CrossSessionCoordinator>[0]> = {}) {
    return new CrossSessionCoordinator({ stateDir, now, ...overrides });
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xsession-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    clock = 1_700_000_000_000;
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/cross-session-coordinator.test.ts' });
  });

  it('records an action and persists it to disk atomically', () => {
    const c = make();
    const r = c.record({ kind: 'intent', reason: 'building PR 495 fix', actor: 'topic-15579' });
    expect(r.recorded).toBe(true);
    expect(r.id).toMatch(/^intent-/);
    const storePath = path.join(stateDir, 'state', 'cross-session-actions.json');
    expect(fs.existsSync(storePath)).toBe(true);
    const store = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    expect(store.actions).toHaveLength(1);
    expect(store.actions[0].reason).toBe('building PR 495 fix');
    // No tmp file left behind
    expect(fs.readdirSync(path.join(stateDir, 'state')).some((f) => f.includes('.tmp'))).toBe(false);
  });

  it('writes a JSONL audit line per record', () => {
    const c = make();
    c.record({ kind: 'config-flag', target: 'monitoring.collaborationRedrive.enabled', value: false });
    const auditPath = path.join(stateDir, 'logs', 'cross-session-events.jsonl');
    expect(fs.existsSync(auditPath)).toBe(true);
    const lines = fs.readFileSync(auditPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]);
    expect(entry.kind).toBe('config-flag');
    expect(entry.value).toBe(false);
    expect(entry.recordedAt).toBeTruthy();
  });

  it('returns no warning when no other session has acted', () => {
    const c = make();
    const r = c.record({ kind: 'config-flag', target: 'monitoring.x.enabled', value: false, actor: 'A' });
    expect(r.concurrent).toHaveLength(0);
    expect(r.warning).toBeNull();
  });

  it('flags a DIFFERENT actor acting within the window (the core signal)', () => {
    const c = make();
    c.record({ kind: 'commitment-withdraw', target: 'CMT-1', actor: 'session-A' });
    clock += 4 * 60 * 1000; // 4 min later
    const r = c.record({ kind: 'config-flag', target: 'monitoring.redrive.enabled', value: false, actor: 'session-B' });
    expect(r.concurrent).toHaveLength(1);
    expect(r.concurrent[0].actor).toBe('session-A');
    expect(r.warning).toMatch(/Cross-session/);
    expect(r.warning).toMatch(/another\/unknown session/);
  });

  it('does NOT flag the SAME known actor (no self-warning)', () => {
    const c = make();
    c.record({ kind: 'commitment-withdraw', target: 'CMT-1', actor: 'session-A' });
    clock += 60 * 1000;
    const r = c.record({ kind: 'commitment-withdraw', target: 'CMT-2', actor: 'session-A' });
    expect(r.concurrent).toHaveLength(0);
    expect(r.warning).toBeNull();
  });

  it('treats UNKNOWN actor as potentially-different (includes it)', () => {
    const c = make();
    c.record({ kind: 'intent', reason: 'doing thing', actor: undefined });
    clock += 60 * 1000;
    const r = c.record({ kind: 'config-flag', target: 'monitoring.redrive.enabled', value: false, actor: 'session-B' });
    expect(r.concurrent).toHaveLength(1);
    expect(r.warning).toMatch(/unattributed session/);
  });

  it('does NOT flag actions older than the window', () => {
    const c = make({ windowMs: 10 * 60 * 1000 });
    c.record({ kind: 'commitment-withdraw', target: 'CMT-1', actor: 'session-A' });
    clock += 11 * 60 * 1000; // outside the 10-min window
    const r = c.record({ kind: 'config-flag', target: 'x', value: false, actor: 'session-B' });
    expect(r.concurrent).toHaveLength(0);
    expect(r.warning).toBeNull();
  });

  it('does NOT double-count the literal same action (kind+target+value)', () => {
    const c = make();
    // Same action key, but recorded under different actors → identical-action dedupe applies.
    c.record({ kind: 'config-flag', target: 'monitoring.x.enabled', value: false, actor: 'A' });
    clock += 1000;
    const r = c.record({ kind: 'config-flag', target: 'monitoring.x.enabled', value: false, actor: 'B' });
    expect(r.concurrent).toHaveLength(0);
  });

  it('treats two DISTINCT intents (no target/value) as concurrent, not the "same action"', () => {
    // Regression: intents have no target/value, so a kind+target+value identity
    // would collapse them into one and suppress the cross-session warning. Intents
    // are events — each announcement is distinct and must surface.
    const c = make();
    c.recordIntent('building the fix', { actor: 'session-A' });
    clock += 60 * 1000;
    const r = c.recordIntent('hitting the safety brake', { actor: 'session-B' });
    expect(r.concurrent).toHaveLength(1);
    expect(r.concurrent[0].actor).toBe('session-A');
    expect(r.warning).toMatch(/another\/unknown session/);
  });

  it('prunes actions older than retentionMs on write', () => {
    const c = make({ retentionMs: 60 * 60 * 1000 });
    c.record({ kind: 'intent', reason: 'old', actor: 'A' });
    clock += 61 * 60 * 1000; // past retention
    c.record({ kind: 'intent', reason: 'fresh', actor: 'B' });
    const store = JSON.parse(fs.readFileSync(path.join(stateDir, 'state', 'cross-session-actions.json'), 'utf8'));
    expect(store.actions).toHaveLength(1);
    expect(store.actions[0].reason).toBe('fresh');
  });

  it('caps the ledger at maxActions (newest kept)', () => {
    const c = make({ maxActions: 5 });
    for (let i = 0; i < 12; i++) {
      clock += 1000;
      c.record({ kind: 'other', target: `t${i}`, actor: 'A' });
    }
    const store = JSON.parse(fs.readFileSync(path.join(stateDir, 'state', 'cross-session-actions.json'), 'utf8'));
    expect(store.actions).toHaveLength(5);
    expect(store.actions[store.actions.length - 1].target).toBe('t11');
  });

  it('disabled mode records nothing and never warns', () => {
    const c = make({ enabled: false });
    const r = c.record({ kind: 'config-flag', target: 'x', value: false });
    expect(r.recorded).toBe(false);
    expect(r.warning).toBeNull();
    expect(fs.existsSync(path.join(stateDir, 'state', 'cross-session-actions.json'))).toBe(false);
    expect(c.isEnabled()).toBe(false);
  });

  it('getRecent returns newest-first within retention', () => {
    const c = make();
    c.record({ kind: 'intent', reason: 'first', actor: 'A' });
    clock += 1000;
    c.record({ kind: 'intent', reason: 'second', actor: 'B' });
    const recent = c.getRecent();
    expect(recent).toHaveLength(2);
    expect(recent[0].reason).toBe('second');
    expect(recent[1].reason).toBe('first');
  });

  it('reload-per-op: a second instance sees the first instance writes (cross-process safety)', () => {
    const c1 = make();
    c1.record({ kind: 'intent', reason: 'from c1', actor: 'A' });
    // Fresh instance, same stateDir — simulates a second server process / restart.
    const c2 = make();
    clock += 1000;
    const r = c2.record({ kind: 'config-flag', target: 'x', value: false, actor: 'B' });
    expect(r.concurrent).toHaveLength(1);
    expect(r.concurrent[0].reason).toBe('from c1');
  });

  it('recordIntent is a convenience wrapper for kind=intent', () => {
    const c = make();
    const r = c.recordIntent('rebuilding the engine', { actor: 'topic-9', area: 'collaborationRedrive' });
    expect(r.recorded).toBe(true);
    const recent = c.getRecent();
    expect(recent[0].kind).toBe('intent');
    expect(recent[0].reason).toBe('rebuilding the engine');
    expect(recent[0].target).toBe('collaborationRedrive');
  });
});
