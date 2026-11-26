import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

/** Runs the real helper's state verb against a temp folder. It locks nothing:
 * the relock verb and the guard are never started here, because on a real Mac
 * they would lock the screen. P12 and P15 cover those on proof hardware. */
const helper = path.resolve('dist/native/instar-desktop-host');
// Opt-in only: a real-helper run can add a privacy-list entry on this Mac.
const usable = process.platform === 'darwin' && process.env.INSTAR_REAL_DESKTOP_HELPER_TESTS === '1' && fs.existsSync(helper)
  && spawnSync(helper, ['state-op'], { input: '{}', encoding: 'utf8' }).status === 69;

describe.skipIf(!usable)('helper state-op', () => {
  let root: string;
  const op = (body: Record<string, unknown>) => {
    const run = spawnSync(helper, ['state-op'], { input: JSON.stringify({ root, ...body }), encoding: 'utf8' });
    expect(run.status).toBe(0);
    return JSON.parse(run.stdout) as Record<string, any>;
  };
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-state-')); });
  afterEach(() => { SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'test cleanup' }); });

  it('lets Leave unlocked win only from owed', () => {
    op({ op: 'marker-create', key: 'k.0', marker: { deadlineMs: 1 } });
    expect(op({ op: 'leave-unlocked', key: 'k.0' }).ok).toBe(true);
    expect(op({ op: 'leave-unlocked', key: 'k.0' }).ok).toBe(false);
    expect(op({ op: 'read' }).state.markers['k.0'].state).toBe('left-unlocked');
  });

  it('stays readable with 200 finished duties: the read trims, the next create prunes (fb-3a84590d-1e8)', () => {
    const now = Date.now();
    const markers: Record<string, unknown> = {};
    for (let i = 0; i < 200; i++) {
      markers[`f.${i}`] = { state: 'relocked', createdAt: now - (200 - i) * 1000, pad: 'x'.repeat(400) };
    }
    markers['owed.0'] = { state: 'owed', createdAt: now - 3 * 86_400_000 };
    markers['failed.0'] = { state: 'relock-failed', createdAt: now - 3 * 86_400_000 };
    fs.writeFileSync(path.join(root, 'locked-state.json'), JSON.stringify({ markers }), { mode: 0o600 });
    const run = spawnSync(helper, ['state-op'], { input: JSON.stringify({ root, op: 'read' }), encoding: 'utf8' });
    expect(run.status).toBe(0);
    expect(run.stdout.length).toBeLessThan(64_000);
    const seen = Object.keys(JSON.parse(run.stdout).state.markers);
    // Unfinished and unreported duties always survive; of the finished, the newest 30.
    expect(seen).toContain('owed.0');
    expect(seen).toContain('failed.0');
    expect(seen.filter(k => k.startsWith('f.')).sort((a, b) => Number(b.slice(2)) - Number(a.slice(2))))
      .toEqual(Array.from({ length: 30 }, (_, i) => `f.${199 - i}`));
    // The read never writes; the next create does the pruning on disk.
    expect(Object.keys(JSON.parse(fs.readFileSync(path.join(root, 'locked-state.json'), 'utf8')).markers)).toHaveLength(202);
    op({ op: 'marker-create', key: 'new.0', marker: {} });
    const onDisk = Object.keys(JSON.parse(fs.readFileSync(path.join(root, 'locked-state.json'), 'utf8')).markers);
    expect(onDisk.filter(k => k.startsWith('f.'))).toHaveLength(30);
    expect(onDisk).toEqual(expect.arrayContaining(['owed.0', 'failed.0', 'new.0']));
  });

  it('keeps one marker for one key, and writes the file owner-only', () => {
    expect(op({ op: 'marker-create', key: 'k.0', marker: {} }).created).toBe(true);
    expect(op({ op: 'marker-create', key: 'k.0', marker: {} }).created).toBe(false);
    expect(fs.statSync(path.join(root, 'locked-state.json')).mode & 0o077).toBe(0);
  });

  it('never rewrites a store it cannot read', () => {
    const file = path.join(root, 'locked-state.json');
    fs.writeFileSync(file, 'not json');
    const run = spawnSync(helper, ['state-op'], { input: JSON.stringify({ root, op: 'marker-create', key: 'k.0', marker: {} }) });
    expect(run.status).toBe(69);
    expect(spawnSync(helper, ['state-op'], { input: JSON.stringify({ root, op: 'read' }) }).status).toBe(69);
    expect(fs.readFileSync(file, 'utf8')).toBe('not json');
  });

  it('creates a missing store root and its parents, each owner-only (a thin build has no desktop-helper folder)', () => {
    const deep = path.join(root, 'home', '.instar', 'desktop-helper', 'locked');
    const run = spawnSync(helper, ['state-op'], { input: JSON.stringify({ root: deep, op: 'set-disabled', disabled: false }), encoding: 'utf8' });
    expect(run.status).toBe(0);
    for (const dir of [path.join(root, 'home'), path.join(root, 'home', '.instar'), path.join(root, 'home', '.instar', 'desktop-helper'), deep]) {
      expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    }
  });

  it('names why it failed on stderr with one fixed word', () => {
    fs.writeFileSync(path.join(root, 'file'), '');
    const blocked = spawnSync(helper, ['state-op'], { input: JSON.stringify({ root: path.join(root, 'file', 'locked'), op: 'set-disabled', disabled: false }), encoding: 'utf8' });
    expect(blocked.status).toBe(69);
    expect(blocked.stderr).toBe('state-op: store-root-uncreatable\n');
    const invalid = spawnSync(helper, ['state-op'], { input: '{bad', encoding: 'utf8' });
    expect(invalid.status).toBe(69);
    expect(invalid.stderr).toBe('state-op: request-invalid\n');
    fs.writeFileSync(path.join(root, 'locked-state.json'), 'not json');
    expect(spawnSync(helper, ['state-op'], { input: JSON.stringify({ root, op: 'read' }), encoding: 'utf8' }).stderr).toBe('state-op: store-unreadable\n');
  });

  it('reads the secure-input owner from IOResources (never "unreadable" on a Mac with a console)', () => {
    const run = spawnSync(helper, ['probe'], { encoding: 'utf8', env: { ...process.env, INSTAR_DESKTOP_LOCKED: '1' } });
    expect(run.status).toBe(0);
    const owner = JSON.parse(run.stdout.split('\n')[0]).lockInputs?.secureInputOwner;
    expect(['none', 'loginwindow', 'other']).toContain(owner);
  });

  it('holds up under many processes at once', async () => {
    await Promise.all(Array.from({ length: 12 }, (_, i) => new Promise<void>((resolve, reject) => {
      const child = spawn(helper, ['state-op'], { stdio: ['pipe', 'ignore', 'ignore'] });
      child.on('close', code => (code === 0 ? resolve() : reject(new Error(String(code)))));
      child.stdin.end(JSON.stringify({ root, op: 'marker-create', key: `k.${i}`, marker: {} }));
    })));
    expect(Object.keys(op({ op: 'read' }).state.markers)).toHaveLength(12);
  });

  it('reads a killed child of a suspended parent as gone, zombie or not', async () => {
    const parent = spawn('/bin/sh', ['-c', 'sleep 60 & echo $!; kill -STOP $$; wait'], { stdio: ['ignore', 'pipe', 'ignore'] });
    const pid = await new Promise<number>(resolve => parent.stdout.once('data', chunk => resolve(Number(String(chunk).trim()))));
    try {
      const { start } = op({ op: 'process-start', pid });
      expect(start).not.toBe('');
      expect(op({ op: 'kill-recorded', pid, start }).gone).toBe(true);
    } finally { parent.kill('SIGKILL'); }
  });

  it('does not treat a reused pid as the recorded process', () => {
    const child = spawn('/bin/sleep', ['30']);
    try {
      expect(op({ op: 'kill-recorded', pid: child.pid, start: '1.1' }).gone).toBe(true);
      expect(child.exitCode).toBeNull();
      expect(child.signalCode).toBeNull();
    } finally { child.kill('SIGKILL'); }
  });
});
