/**
 * T4 (frozen acceptance list, step3/acceptance-tests.md): the CLI version helper
 * (spec job-launch-intent-record §4, "Version helper"). Red on main: the module doesn't exist.
 *
 * Contract fixed by this test (the build implements it):
 *   (await load())(deps) -> { cached(binPath): string | 'unknown'; probe(binPath): Promise<string | 'unknown'> }
 *   deps: {
 *     execFile(bin, args, opts): Promise<{ stdout: string }>   // node's promisified execFile shape
 *     stat(p): { size: number; mtimeMs: number }
 *     realpath(p): string
 *     now(): number
 *     retainerVersion?(p): string | null                      // SessionManager.claudeLaunchVersions lookup
 *     resolveLaunchedBinary?(p): string                       // configured path -> the binary that really
 *                                                             // launches (retained per-version copy); default identity
 *   }
 *   - The probe passes { shell: false, cwd: <neutral tmp dir>, timeout: 2000, killSignal: 'SIGKILL',
 *     env with CLAUDE_CODE_DISABLE_AUTOUPDATER=1 } to execFile, so execFile itself kills the child on
 *     timeout. A rejection with `killed: true` or code 'ETIMEDOUT' is 'unknown'.
 *   - Backstop: if execFile never settles, probe() still resolves 'unknown' within 2,500 ms.
 *   - Everything (cache key, retainer lookup, the probed binary) uses resolveLaunchedBinary(p).
 *     That SessionManager supplies the binary that really launched is proven in T3
 *     (job-launch-spawn.test.ts, "the probed binary is the one that launched").
 *   - The cwd is an existing, isolated directory under os.tmpdir() (not tmpdir itself).
 *   - A version is a semver of at most 64 characters; anything else is 'unknown'.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type Reader = { cached(p: string): string; probe(p: string): Promise<string> };
async function load(): Promise<(d: never) => Reader> {
  let mod: Record<string, unknown>;
  try {
    mod = await import(/* @vite-ignore */ '../../src/core/cliVersionReader.js');
  } catch (e) {
    expect.fail(`module missing: src/core/cliVersionReader.ts (${(e as Error).message.split('\n')[0]})`);
  }
  expect(typeof mod.createCliVersionReader, 'createCliVersionReader is not exported').toBe('function');
  return mod.createCliVersionReader as (d: never) => Reader;
}

type ExecOpts = Record<string, unknown> & { timeout?: number; killSignal?: string };

function deps(overrides: Record<string, unknown> = {}) {
  let t = 1_000_000;
  const files: Record<string, { size: number; mtimeMs: number }> = {
    '/bin/engine': { size: 10, mtimeMs: 1 },
    '/retained/2.1.322/claude': { size: 20, mtimeMs: 5 },
  };
  const execFile = vi.fn(async (_bin: string, _args: string[], _opts: ExecOpts) => ({ stdout: '2.1.322 (Claude Code)\n' }));
  const stat = vi.fn((p: string) => files[p]);
  return {
    files,
    clock: { advance: (ms: number) => { t += ms; } },
    execFile,
    stat,
    realpath: (p: string) => p,
    now: () => t,
    ...overrides,
  };
}

/** A fake execFile with node's real timeout semantics: at opts.timeout it kills the child
 *  with opts.killSignal and rejects with `killed: true`. Without a timeout it never settles. */
function hangingExecFile() {
  const kills: string[] = [];
  const fn = vi.fn((_bin: string, _args: string[], opts: ExecOpts) => new Promise<{ stdout: string }>((_resolve, reject) => {
    if (typeof opts?.timeout === 'number' && opts.timeout > 0) {
      setTimeout(() => {
        kills.push(String(opts.killSignal ?? 'SIGTERM'));
        reject(Object.assign(new Error('Command failed: timed out'), { killed: true, signal: opts.killSignal ?? 'SIGTERM', code: null }));
      }, opts.timeout);
    }
  }));
  return { fn, kills };
}

afterEach(() => { vi.useRealTimers(); });

describe('T4 cliVersionReader', () => {
  it('a miss returns unknown immediately; probe fills the cache with parsed semver', async () => {
    const d = deps();
    const r = (await load())(d as never);
    expect(r.cached('/bin/engine')).toBe('unknown');
    expect(await r.probe('/bin/engine')).toBe('2.1.322');
    expect(r.cached('/bin/engine')).toBe('2.1.322');
  });

  it('probe passes no shell, a neutral cwd, the updater suppression, a 2s timeout and a kill signal', async () => {
    let cwdAtCall: { exists: boolean; isDir: boolean; real: string } | undefined;
    const d = deps({ execFile: vi.fn(async (_b: string, _a: string[], o: ExecOpts) => {
      const c = String(o.cwd);
      const exists = fs.existsSync(c);
      cwdAtCall = { exists, isDir: exists && fs.statSync(c).isDirectory(), real: exists ? fs.realpathSync(c) : c };
      return { stdout: '2.1.322 (Claude Code)\n' };
    }) });
    await (await load())(d as never).probe('/bin/engine');
    const [bin, args, opts] = d.execFile.mock.calls[0] as unknown as [string, string[], ExecOpts];
    expect(bin).toBe('/bin/engine');
    expect(args).toEqual(['--version']);
    expect(opts.shell).toBeFalsy();
    expect(opts.timeout).toBe(2000);
    expect(opts.killSignal).toBe('SIGKILL');
    expect((opts.env as Record<string, string>).CLAUDE_CODE_DISABLE_AUTOUPDATER).toBe('1');
    expect(typeof opts.cwd).toBe('string');
    expect(opts.cwd).not.toBe(process.cwd());
    // Neutral cwd = an existing, isolated directory inside the OS temp dir (not tmpdir itself, not a project).
    const tmpRoot = fs.realpathSync(os.tmpdir());
    expect(cwdAtCall?.exists, 'the probe cwd did not exist when the probe ran').toBe(true);
    expect(cwdAtCall?.isDir).toBe(true);
    expect(cwdAtCall!.real.startsWith(tmpRoot + path.sep), `probe cwd ${cwdAtCall!.real} is not under ${tmpRoot}`).toBe(true);
    expect(cwdAtCall!.real).not.toBe(tmpRoot);
    expect(fs.existsSync(path.join(cwdAtCall!.real, 'package.json')) || fs.existsSync(path.join(cwdAtCall!.real, '.git'))).toBe(false);
  });

  it('a hung child is killed at 2s by the timeout and the probe returns unknown (not cached)', async () => {
    const create = await load();
    vi.useFakeTimers();
    const { fn, kills } = hangingExecFile();
    const d = deps({ execFile: fn });
    const r = create(d as never);
    let settled: string | undefined;
    const p = r.probe('/bin/engine').then((v) => { settled = v; return v; });
    await vi.advanceTimersByTimeAsync(1999);
    expect(settled, 'resolved before the 2s timeout').toBeUndefined();
    expect(kills).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(await p).toBe('unknown');
    expect(kills, 'the child was not killed with SIGKILL on timeout').toEqual(['SIGKILL']);
    expect(r.cached('/bin/engine')).toBe('unknown');
  });

  it('ETIMEDOUT is unknown too', async () => {
    const d = deps({ execFile: vi.fn(async () => { throw Object.assign(new Error('spawn timeout'), { code: 'ETIMEDOUT' }); }) });
    expect(await (await load())(d as never).probe('/bin/engine')).toBe('unknown');
  });

  it('backstop: an execFile that never settles still yields unknown within 2.5s', async () => {
    const create = await load();
    vi.useFakeTimers();
    const d = deps({ execFile: vi.fn(() => new Promise(() => { /* never settles, ignores its timeout */ })) });
    const r = create(d as never);
    let settled: string | undefined;
    void r.probe('/bin/engine').then((v) => { settled = v; });
    await vi.advanceTimersByTimeAsync(2500);
    expect(settled, 'probe() is unbounded when execFile hangs').toBe('unknown');
  });

  it('a failure is NOT cached: the SAME reader probes again and succeeds', async () => {
    const execFile = vi.fn<(b: string, a: string[], o: ExecOpts) => Promise<{ stdout: string }>>()
      .mockRejectedValueOnce(Object.assign(new Error('boom'), { code: 1 }))
      .mockResolvedValueOnce({ stdout: '0.167.0\n' });
    const d = deps({ execFile });
    const r = (await load())(d as never);
    expect(await r.probe('/bin/engine')).toBe('unknown');
    expect(r.cached('/bin/engine')).toBe('unknown');
    expect(await r.probe('/bin/engine')).toBe('0.167.0');
    expect(execFile).toHaveBeenCalledTimes(2);
    expect(r.cached('/bin/engine')).toBe('0.167.0');
  });

  it('an unparseable answer is not cached either: the same reader retries', async () => {
    const execFile = vi.fn<(b: string, a: string[], o: ExecOpts) => Promise<{ stdout: string }>>()
      .mockResolvedValueOnce({ stdout: 'no version here\n' })
      .mockResolvedValueOnce({ stdout: '1.4.0\n' });
    const r = (await load())(deps({ execFile }) as never);
    expect(await r.probe('/bin/engine')).toBe('unknown');
    expect(await r.probe('/bin/engine')).toBe('1.4.0');
  });

  describe('cache key: realpath + size + mtime, each one alone invalidates', () => {
    async function warmed(extra: Record<string, unknown> = {}) {
      let target = '/bin/engine';
      const d = deps({ realpath: (p: string) => (p === '/bin/engine' ? target : p), ...extra });
      d.files['/opt/engine-v2'] = { size: 10, mtimeMs: 1 }; // same size AND mtime as /bin/engine
      const r = (await load())(d as never);
      expect(await r.probe('/bin/engine')).toBe('2.1.322');
      expect(r.cached('/bin/engine')).toBe('2.1.322');
      return { d, r, retarget: (t: string) => { target = t; } };
    }
    it('size alone changes → miss', async () => {
      const { d, r } = await warmed();
      d.files['/bin/engine'] = { size: 11, mtimeMs: 1 };
      expect(r.cached('/bin/engine')).toBe('unknown');
    });
    it('mtime alone changes → miss', async () => {
      const { d, r } = await warmed();
      d.files['/bin/engine'] = { size: 10, mtimeMs: 2 };
      expect(r.cached('/bin/engine')).toBe('unknown');
    });
    it('realpath alone changes (symlink retargeted to a file with identical size and mtime) → miss', async () => {
      const { r, retarget } = await warmed();
      retarget('/opt/engine-v2');
      expect(r.cached('/bin/engine')).toBe('unknown');
    });
    it('nothing changes → still a hit (control)', async () => {
      const { r } = await warmed();
      expect(r.cached('/bin/engine')).toBe('2.1.322');
    });
  });

  it('entries expire after 1 hour (shims whose file never changes)', async () => {
    const d = deps();
    const r = (await load())(d as never);
    await r.probe('/bin/engine');
    d.clock.advance(60 * 60 * 1000);
    expect(r.cached('/bin/engine'), 'still valid at exactly 1 hour').toBe('2.1.322');
    d.clock.advance(1);
    expect(r.cached('/bin/engine')).toBe('unknown');
  });

  it('non-semver or oversized output is unknown, never raw text', async () => {
    const d = deps({ execFile: vi.fn(async () => ({ stdout: 'x'.repeat(500) })) });
    expect(await (await load())(d as never).probe('/bin/engine')).toBe('unknown');
  });

  it('length bound: a VALID semver longer than 64 chars is unknown; exactly 64 is kept', async () => {
    const long = `1.2.3-${'a'.repeat(70)}`; // valid semver prerelease, 76 chars
    const r1 = (await load())(deps({ execFile: vi.fn(async () => ({ stdout: `${long}\n` })) }) as never);
    expect(await r1.probe('/bin/engine')).toBe('unknown');
    const exact = `1.2.3-${'a'.repeat(58)}`; // 64 chars
    expect(exact).toHaveLength(64);
    const r2 = (await load())(deps({ execFile: vi.fn(async () => ({ stdout: `${exact}\n` })) }) as never);
    expect(await r2.probe('/bin/engine')).toBe(exact);
  });

  it('one probe per key at a time', async () => {
    const d = deps();
    const r = (await load())(d as never);
    await Promise.all([r.probe('/bin/engine'), r.probe('/bin/engine'), r.probe('/bin/engine')]);
    expect(d.execFile).toHaveBeenCalledTimes(1);
  });

  it('uses a non-null retainer version without probing; a null retainer version falls through to the probe', async () => {
    const withVersion = deps({ retainerVersion: () => '2.1.300' });
    const r = (await load())(withVersion as never);
    expect(r.cached('/bin/engine')).toBe('2.1.300');
    expect(await r.probe('/bin/engine')).toBe('2.1.300');
    expect(withVersion.execFile).not.toHaveBeenCalled();
    const withNull = deps({ retainerVersion: () => null });
    const r2 = (await load())(withNull as never);
    expect(r2.cached('/bin/engine')).toBe('unknown');
    expect(await r2.probe('/bin/engine')).toBe('2.1.322');
    expect(withNull.execFile).toHaveBeenCalledTimes(1);
  });

  it('the retained binary is what gets probed, keyed and looked up — not the configured path', async () => {
    const retainerVersion = vi.fn((_p: string) => null);
    const d = deps({ resolveLaunchedBinary: (p: string) => (p === '/bin/engine' ? '/retained/2.1.322/claude' : p), retainerVersion });
    const r = (await load())(d as never);
    expect(await r.probe('/bin/engine')).toBe('2.1.322');
    expect(d.execFile.mock.calls[0][0]).toBe('/retained/2.1.322/claude');
    expect(retainerVersion).toHaveBeenCalledWith('/retained/2.1.322/claude');
    expect(d.stat).toHaveBeenCalledWith('/retained/2.1.322/claude');
    expect(d.stat).not.toHaveBeenCalledWith('/bin/engine');
    // The cache key is the retained copy: changing it is a miss, changing the configured path is not.
    d.files['/bin/engine'] = { size: 99, mtimeMs: 99 };
    expect(r.cached('/bin/engine')).toBe('2.1.322');
    d.files['/retained/2.1.322/claude'] = { size: 21, mtimeMs: 6 };
    expect(r.cached('/bin/engine')).toBe('unknown');
  });
});
