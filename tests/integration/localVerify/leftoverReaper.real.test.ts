// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Machine memory care §2 against the REAL operating system: real processes, a real stopped
 * process, a real detached tmux server whose command line names nothing but whose socket
 * sits in a run temp folder. The prefixes are a fresh, uniquely named folder, so nothing of
 * the host (or of a Local Verify run hosting this test) can match.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import { reapLeftovers, realReapDeps } from '../../../src/localVerify/leftoverReaper.js';
import { runLeftoverPrefixes } from '../../../src/localVerify/orchestrator.js';

const posix = process.platform === 'darwin' || process.platform === 'linux';
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const waitGone = async (pid: number) => { for (let i = 0; i < 50 && alive(pid); i++) await new Promise((r) => setTimeout(r, 50)); return !alive(pid); };
const dirs: string[] = [];
const pids: number[] = [];
afterEach(() => {
  for (const p of pids.splice(0)) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } }
  for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'leftoverReaper.real.test.ts' });
});

function runFolder(): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lv-itest-')));
  dirs.push(d);
  return d;
}

/**
 * A real ORPHAN whose command line names `dir`, like a test helper that escaped its lane: a
 * shell backgrounds `/bin/sh <dir>/helper.sh` and exits at once, so the helper is re-parented
 * to init. The trailing `:` keeps the helper shell from exec-ing into `sleep` (its argv must
 * keep naming the folder).
 */
function detachedSleeper(dir: string): number {
  const script = path.join(dir, 'helper.sh');
  fs.writeFileSync(script, '#!/bin/sh\nsleep 120\n:\n');
  fs.chmodSync(script, 0o755);
  const out = spawnSync('/bin/sh', ['-c', '/bin/sh "$0" </dev/null >/dev/null 2>&1 & echo $!', script], { encoding: 'utf-8' });
  const pid = Number(out.stdout.trim());
  expect(pid).toBeGreaterThan(1);
  pids.push(pid);
  return pid;
}

/** Wait until the helper's parent shell has exited and it reads as an orphan (ppid 1). */
async function waitOrphan(pid: number): Promise<void> {
  for (let i = 0; i < 50; i++) {
    const ppid = spawnSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf-8' }).stdout.trim();
    if (ppid === '1') return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`helper ${pid} never became an orphan`);
}

describe.skipIf(!posix)('leftover reaper — real processes', () => {
  it('ends a STOPPED helper under the run folder and leaves a look-alike outside it running', async () => {
    const run = runFolder();
    const other = runFolder();
    const leftover = detachedSleeper(run);
    const bystander = detachedSleeper(other);
    await waitOrphan(leftover);
    await waitOrphan(bystander);
    process.kill(leftover, 'SIGSTOP');
    await new Promise((r) => setTimeout(r, 100));
    const r = await reapLeftovers(realReapDeps(), runLeftoverPrefixes(run, []));
    expect(r.matched).toBeGreaterThanOrEqual(1);
    expect(r.sample.some((s) => s.pid === leftover)).toBe(true);
    expect(await waitGone(leftover)).toBe(true);
    expect(alive(bystander)).toBe(true);
  });

  it('an orphan that started after the sweep decision is kept (startedBeforeMs), and taken without the guard', async () => {
    const run = runFolder();
    const fresh = detachedSleeper(run);
    await waitOrphan(fresh);
    // Without the guard the same orphan IS taken: proves the guard, not the orphan rule, kept it.
    const guarded = await reapLeftovers(realReapDeps(), runLeftoverPrefixes(run, []), { startedBeforeMs: Date.now() });
    expect(guarded.matched).toBe(0);
    expect(alive(fresh)).toBe(true);
    const unguarded = await reapLeftovers(realReapDeps(), runLeftoverPrefixes(run, []));
    expect(unguarded.sample.some((s) => s.pid === fresh)).toBe(true);
    expect(await waitGone(fresh)).toBe(true);
  });

  const tmux = (() => { try { return execFileSync('sh', ['-c', 'command -v tmux'], { encoding: 'utf-8' }).trim() || null; } catch { return null; } })();
  const lsof = (() => { try { return execFileSync('sh', ['-c', 'command -v lsof'], { encoding: 'utf-8' }).trim() || null; } catch { return null; } })();

  it.skipIf(!tmux || !lsof)('ends a detached tmux server found only by its socket in the run temp folder', async () => {
    const tmuxDir = runFolder();
    const socket = `memcare-itest-${process.pid}`;
    const env = { ...process.env, TMUX_TMPDIR: tmuxDir };
    delete (env as Record<string, string | undefined>).TMUX;
    const started = spawnSync(tmux!, ['-L', socket, 'new-session', '-d', '-s', 'leftover', 'sleep 120'], { env, encoding: 'utf-8' });
    expect(started.status).toBe(0);
    const server = Number(spawnSync(tmux!, ['-L', socket, 'display-message', '-p', '#{pid}'], { env, encoding: 'utf-8' }).stdout.trim());
    expect(server).toBeGreaterThan(1);
    pids.push(server);
    const r = await reapLeftovers(realReapDeps(), runLeftoverPrefixes(tmuxDir, []));
    expect(r.sample.some((s) => s.pid === server)).toBe(true);
    expect(await waitGone(server)).toBe(true);
  });
});
