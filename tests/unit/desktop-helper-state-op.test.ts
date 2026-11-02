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
const usable = process.platform === 'darwin' && fs.existsSync(helper)
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
