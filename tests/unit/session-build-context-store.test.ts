import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateManager } from '../../src/core/StateManager.js';
import {
  formatBuildContextRestoreNote,
  isEligibleBuildContextCwd,
  SessionBuildContextStore,
} from '../../src/core/SessionBuildContextStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('SessionBuildContextStore', () => {
  let tmpDir: string;
  let state: StateManager;
  let now = 1_000_000;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-build-context-'));
    state = new StateManager(tmpDir);
    now = 1_000_000;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    SafeFsExecutor.safeRmSync(tmpDir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/session-build-context-store.test.ts:afterEach',
    });
  });

  it('treats home-only sessions as ineligible and worktree cwd sessions as eligible', () => {
    const home = path.join(tmpDir, 'agent-home');
    const worktree = path.join(home, '.worktrees', 'feature');
    const trivialSubdir = path.join(home, 'docs');

    expect(isEligibleBuildContextCwd(home, home)).toBe(false);
    expect(isEligibleBuildContextCwd(home, trivialSubdir)).toBe(false);
    expect(isEligibleBuildContextCwd(home, worktree)).toBe(true);
  });

  it('records branch enrichment best-effort and returns a restore note for fresh existing worktrees', () => {
    const home = path.join(tmpDir, 'agent-home');
    const worktree = path.join(home, '.worktrees', 'feature');
    fs.mkdirSync(worktree, { recursive: true });

    const store = new SessionBuildContextStore(state, {
      now: () => now,
      execFileSync: vi.fn(() => 'codey/feature\n') as any,
    });

    store.record('agent-topic', home, worktree);
    const restore = store.getRestore('agent-topic');

    expect(restore?.entry).toMatchObject({
      spawnCwd: home,
      currentCwd: worktree,
      branch: 'codey/feature',
      updatedAt: now,
    });
    expect(restore?.note).toContain('[BUILD-CONTEXT RESTORE]');
    expect(restore?.note).toContain(worktree);
    expect(restore?.note).toContain('branch:   codey/feature');
  });

  it('skips stale, missing, and home-only contexts', () => {
    const home = path.join(tmpDir, 'agent-home');
    const worktree = path.join(home, '.worktrees', 'feature');
    fs.mkdirSync(worktree, { recursive: true });

    const store = new SessionBuildContextStore(state, {
      now: () => now,
      maxAgeMs: 100,
      execFileSync: vi.fn(() => '') as any,
    });

    store.record('stale', home, worktree);
    now += 101;
    expect(store.getRestore('stale')).toBeNull();

    now = 2_000_000;
    store.record('missing', home, path.join(home, '.worktrees', 'gone'));
    expect(store.getRestore('missing')).toBeNull();

    store.record('home', home, home);
    expect(store.getRestore('home')).toBeNull();
  });

  it('writes through the crash-safe state sidecar path — under the PER-MACHINE key (standby-write-reconciliation §3.3)', () => {
    const renameSpy = vi.spyOn(fs, 'renameSync');
    const home = path.join(tmpDir, 'agent-home');
    const worktree = path.join(home, '.worktrees', 'feature');
    fs.mkdirSync(worktree, { recursive: true });

    const store = new SessionBuildContextStore(state, {
      now: () => now,
      execFileSync: vi.fn(() => '') as any,
    });
    store.record('agent-topic', home, worktree);

    // Identity-less installs embed the literal 'local' (§3.3 round-2 L3) —
    // never the LEGACY shared 'session-build-context' key.
    const target = path.join(tmpDir, 'state', 'session-build-context-local.json');
    expect(fs.existsSync(target)).toBe(true);
    expect(renameSpy.mock.calls.some(([, to]) => to === target)).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'state', 'session-build-context.json'))).toBe(false);
  });

  it('re-keys per machine (standby-write-reconciliation §3.3): a mesh identity embeds its jailed id; each machine reads ONLY its own key', () => {
    const home = path.join(tmpDir, 'agent-home');
    const worktree = path.join(home, '.worktrees', 'feature');
    fs.mkdirSync(worktree, { recursive: true });

    // The machine id resolves LATE via a getter (the mesh identity is assigned
    // after SessionManager construction at server boot).
    let machineId: string | null = null;
    const store = new SessionBuildContextStore(state, {
      now: () => now,
      execFileSync: vi.fn(() => '') as any,
      machineId: () => machineId,
    });
    expect(store.stateKey()).toBe('session-build-context-local');
    machineId = 'mesh.id/with weird chars';
    expect(store.stateKey()).toBe('session-build-context-mesh_id_with_weird_chars');

    store.record('agent-topic', home, worktree);
    expect(fs.existsSync(path.join(tmpDir, 'state', 'session-build-context-mesh_id_with_weird_chars.json'))).toBe(true);

    // A DIFFERENT machine's store never sees this machine's entries — single
    // writer per file by construction, reads never need peers' keys.
    const otherStore = new SessionBuildContextStore(state, {
      now: () => now,
      execFileSync: vi.fn(() => '') as any,
      machineId: 'other-machine',
    });
    expect(otherStore.getRestore('agent-topic')).toBeNull();
    expect(store.getRestore('agent-topic')).not.toBeNull();
  });

  // 2026-11-13: one machine's store held 32,378 rows (8.2 MB), 99.7% of them past the max age,
  // and every monitor pass parsed all of it for every running session.
  it('a write drops rows past the max age and keeps the rest', () => {
    const home = path.join(tmpDir, 'agent-home');
    const worktree = path.join(home, '.worktrees', 'feature');
    fs.mkdirSync(worktree, { recursive: true });
    const maxAgeMs = 1000;
    const store = new SessionBuildContextStore(state, { now: () => now, execFileSync: vi.fn(() => '') as any, maxAgeMs });

    store.record('old-session', home, worktree);
    now += 400;
    store.record('middle-session', home, worktree);
    now += 601; // old-session is now 1001 ms old (expired); middle-session is 601 ms old
    expect(Object.keys(store.readAll()).sort()).toEqual(['middle-session', 'old-session']); // nothing written yet

    store.record('new-session', home, worktree);
    expect(Object.keys(store.readAll()).sort()).toEqual(['middle-session', 'new-session']);
    // The row at exactly the max age is still restorable, so it is kept.
    now += 399; // middle-session is exactly 1000 ms old
    store.record('another-session', home, worktree);
    expect(Object.keys(store.readAll()).sort()).toEqual(['another-session', 'middle-session', 'new-session']);
    expect(store.getRestore('middle-session')).not.toBeNull();
  });

  it('shrinks a store that grew without bound, on the next write', () => {
    const home = path.join(tmpDir, 'agent-home');
    const store = new SessionBuildContextStore(state, { now: () => now, execFileSync: vi.fn(() => '') as any });
    const bloated: Record<string, unknown> = {};
    for (let i = 0; i < 5000; i++) bloated[`job-${i}`] = { spawnCwd: home, currentCwd: home, updatedAt: now - 7 * 60 * 60 * 1000 - i };
    bloated['still-live'] = { spawnCwd: home, currentCwd: home, updatedAt: now - 60_000 };
    state.set(store.stateKey(), bloated);
    expect(Object.keys(store.readAll())).toHaveLength(5001);

    store.record('fresh-session', home, home);
    expect(Object.keys(store.readAll()).sort()).toEqual(['fresh-session', 'still-live']);
  });

  it('an unchanged session writes nothing, so it prunes nothing (no write on the hot path)', () => {
    const home = path.join(tmpDir, 'agent-home');
    const store = new SessionBuildContextStore(state, { now: () => now, execFileSync: vi.fn(() => '') as any, maxAgeMs: 1000 });
    store.record('steady', home, home);
    const setSpy = vi.spyOn(state, 'set');
    now += 5000;
    store.record('steady', home, home);
    expect(setSpy).not.toHaveBeenCalled();
  });

  // A consequence of pruning, pinned so it is deliberate: a session that has sat in one worktree
  // past the max age loses its row at the next write, and its next record() writes a fresh one.
  // Before, its row stayed expired for good and a restart did not restore a place it was still in.
  it('a long-lived session whose row was pruned is recorded again as current', () => {
    const home = path.join(tmpDir, 'agent-home');
    const worktree = path.join(home, '.worktrees', 'feature');
    fs.mkdirSync(worktree, { recursive: true });
    const store = new SessionBuildContextStore(state, { now: () => now, execFileSync: vi.fn(() => '') as any, maxAgeMs: 1000 });
    store.record('long-lived', home, worktree);
    now += 2000;
    expect(store.getRestore('long-lived')).toBeNull(); // expired, as before
    store.record('other', home, home); // any write prunes it
    expect(store.readAll()['long-lived']).toBeUndefined();
    store.record('long-lived', home, worktree); // the monitor's next pass for the same session
    expect(store.getRestore('long-lived')?.entry.updatedAt).toBe(now);
  });

  it('formats restore notes without a branch line when branch enrichment is absent', () => {
    const note = formatBuildContextRestoreNote({
      spawnCwd: '/agent-home',
      currentCwd: '/agent-home/.worktrees/build',
      updatedAt: now,
    });

    expect(note).toContain('[BUILD-CONTEXT RESTORE]');
    expect(note).not.toContain('branch:');
  });
});
