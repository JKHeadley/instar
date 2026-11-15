/**
 * cliVersionReader — the CLI version helper behind the job launch record
 * (docs/specs/job-launch-intent-record.md §4, "Version helper").
 *
 * The launch record's `cliVersion` must never make a job spawn wait. So the reader has two halves:
 *   - `cached(bin)` is synchronous and instant: a cached version string, a known retainer version,
 *     or `'unknown'`. The scheduler writes the start row with it.
 *   - `probe(bin)` runs `<bin> --version` asynchronously (2 s timeout, child killed with SIGKILL,
 *     no shell, stderr ignored, the Claude auto-updater suppressed, from a neutral temp cwd that is
 *     never the agent's project), and the scheduler patches the row's `cliVersion` when it settles.
 *
 * The cache holds the version STRING keyed on realpath + size + mtime of the binary that really
 * launches (the retained per-version copy, not the configured path), with a 1-hour TTL so a shim
 * whose own file never changes is re-read. A failed or unparseable probe is never cached. At most
 * one probe per cache key runs at a time.
 *
 * Signal only: this module decides nothing. It reports what a binary says its version is.
 */

import { execFile as execFileCb } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CLI_VERSION_UNKNOWN = 'unknown';
export const CLI_VERSION_PROBE_TIMEOUT_MS = 2000;
/** Backstop: probe() resolves within this even if execFile never settles. */
export const CLI_VERSION_PROBE_BACKSTOP_MS = 2500;
export const CLI_VERSION_CACHE_TTL_MS = 60 * 60 * 1000;
export const CLI_VERSION_MAX_LENGTH = 64;

/** Semver 2.0 core with optional prerelease and build metadata. */
const SEMVER_RE = /(?<![0-9A-Za-z.-])(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)(?![0-9A-Za-z.+-])/;

export interface CliVersionReaderDeps {
  /** Node's promisified execFile shape. */
  execFile(bin: string, args: string[], opts: Record<string, unknown>): Promise<{ stdout: string | Buffer }>;
  stat(p: string): { size: number; mtimeMs: number } | undefined;
  realpath(p: string): string;
  /** PATH lookup skips a file this returns false for, as process execution does. Default: every file counts. */
  isExecutable?(p: string): boolean;
  now(): number;
  /** A version the Claude binary retainer already holds for this launched path; null when it has none. */
  retainerVersion?(p: string): string | null | undefined;
  /** Configured path → the binary that really launches. Default: identity. */
  resolveLaunchedBinary?(p: string): string;
}

export interface CliVersionReader {
  cached(binPath: string): string;
  probe(binPath: string): Promise<string>;
}

/** Parse a version out of `--version` output: the first semver token, at most 64 chars. */
export function parseCliVersion(output: string): string {
  const m = SEMVER_RE.exec(output);
  if (!m) return CLI_VERSION_UNKNOWN;
  const v = m[1];
  return v.length <= CLI_VERSION_MAX_LENGTH ? v : CLI_VERSION_UNKNOWN;
}

function validVersion(v: string | null | undefined): string | null {
  if (typeof v !== 'string') return null;
  const parsed = parseCliVersion(v);
  return parsed === CLI_VERSION_UNKNOWN ? null : parsed;
}

let neutralDir: string | null = null;
/** An existing, isolated directory under the OS temp dir: never the agent's project. */
function neutralCwd(): string {
  if (neutralDir) {
    try {
      if (fs.statSync(neutralDir).isDirectory()) return neutralDir;
    } catch {
      // @silent-fallback-ok — the temp dir was swept; make a fresh one below.
    }
  }
  neutralDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-cli-version-'));
  return neutralDir;
}

export function createCliVersionReader(deps: CliVersionReaderDeps): CliVersionReader {
  const cache = new Map<string, { version: string; at: number }>();
  const inflight = new Map<string, Promise<string>>();
  const launched = (p: string) => (deps.resolveLaunchedBinary ? deps.resolveLaunchedBinary(p) : p);

  // A bare command (`codex`) is run through PATH by execFile, but realpath() resolves it
  // against the server's cwd and fails. Resolve it on PATH first so it gets a cache key.
  const onPath = (bin: string): string => {
    if (bin.includes('/') || bin.includes('\\')) return bin;
    for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
      if (!dir) continue;
      const candidate = path.join(dir, bin);
      try {
        if (deps.stat(candidate) && (deps.isExecutable ? deps.isExecutable(candidate) : true)) return candidate;
      } catch {
        // @silent-fallback-ok — an unreadable PATH entry is skipped; the next one is tried.
      }
    }
    return bin;
  };

  const keyFor = (rawBin: string): string | null => {
    const bin = onPath(rawBin);
    try {
      const real = deps.realpath(bin);
      const st = deps.stat(bin);
      if (!st) return null;
      return `${real}\u0000${st.size}\u0000${st.mtimeMs}`;
    } catch {
      // @silent-fallback-ok — an unreadable binary has no cache key: the record reads 'unknown'.
      return null;
    }
  };

  const fromRetainer = (bin: string): string | null => {
    try {
      return validVersion(deps.retainerVersion?.(bin));
    } catch {
      // @silent-fallback-ok — no retainer version means the probe runs instead.
      return null;
    }
  };

  const cachedFor = (key: string | null): string | null => {
    if (!key) return null;
    const hit = cache.get(key);
    if (!hit) return null;
    if (deps.now() - hit.at > CLI_VERSION_CACHE_TTL_MS) {
      cache.delete(key);
      return null;
    }
    return hit.version;
  };

  const runProbe = async (bin: string): Promise<string> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const backstop = new Promise<string>((resolve) => {
      timer = setTimeout(() => resolve(CLI_VERSION_UNKNOWN), CLI_VERSION_PROBE_BACKSTOP_MS);
    });
    const attempt = (async () => {
      try {
        const { stdout } = await deps.execFile(bin, ['--version'], {
          shell: false,
          cwd: neutralCwd(),
          timeout: CLI_VERSION_PROBE_TIMEOUT_MS,
          killSignal: 'SIGKILL',
          encoding: 'utf-8',
          windowsHide: true,
          maxBuffer: 64 * 1024,
          env: { ...process.env, CLAUDE_CODE_DISABLE_AUTOUPDATER: '1' },
        });
        return parseCliVersion(String(stdout ?? ''));
      } catch {
        // A timeout (killed / ETIMEDOUT), a missing binary or a non-zero exit: unknown, not cached.
        return CLI_VERSION_UNKNOWN;
      }
    })();
    try {
      return await Promise.race([attempt, backstop]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  return {
    cached(binPath: string): string {
      const bin = launched(binPath);
      return fromRetainer(bin) ?? cachedFor(keyFor(bin)) ?? CLI_VERSION_UNKNOWN;
    },

    probe(binPath: string): Promise<string> {
      const bin = launched(binPath);
      const retained = fromRetainer(bin);
      if (retained) return Promise.resolve(retained);
      const key = keyFor(bin);
      const hit = cachedFor(key);
      if (hit) return Promise.resolve(hit);
      const flightKey = key ?? `nokey\u0000${bin}`;
      const running = inflight.get(flightKey);
      if (running) return running;
      const p = runProbe(bin).then((version) => {
        // Only a real version is cached; the key is re-read so a binary swapped mid-probe
        // does not attach its old version to the new file.
        const settledKey = keyFor(bin);
        if (version !== CLI_VERSION_UNKNOWN && settledKey && settledKey === key) {
          cache.set(settledKey, { version, at: deps.now() });
        }
        return version;
      }).finally(() => {
        inflight.delete(flightKey);
      });
      inflight.set(flightKey, p);
      return p;
    },
  };
}

/**
 * execFile as a promise of `{ stdout }`. Written by hand rather than with util.promisify so the
 * shape holds even when child_process.execFile has been wrapped (a wrapper loses node's custom
 * promisify hook and would resolve with the bare stdout string).
 */
function execFileAsync(bin: string, args: string[], opts: Record<string, unknown>): Promise<{ stdout: string | Buffer }> {
  return new Promise((resolve, reject) => {
    execFileCb(bin, args, opts as Parameters<typeof execFileCb>[2], (err: Error | null, stdout: unknown) => {
      if (err) { reject(err); return; }
      if (stdout && typeof stdout === 'object' && !Buffer.isBuffer(stdout) && 'stdout' in stdout) {
        resolve({ stdout: String((stdout as { stdout: unknown }).stdout ?? '') });
        return;
      }
      resolve({ stdout: (stdout as string | Buffer | undefined) ?? '' });
    });
  });
}

/** Production dependencies: real child_process, fs and clock. */
export function defaultCliVersionReaderDeps(
  extra: Pick<CliVersionReaderDeps, 'retainerVersion' | 'resolveLaunchedBinary'> = {},
): CliVersionReaderDeps {
  return {
    execFile: execFileAsync,
    stat: (p) => {
      const st = fs.statSync(p);
      return { size: st.size, mtimeMs: st.mtimeMs };
    },
    realpath: (p) => fs.realpathSync(p),
    isExecutable: (p) => {
      try {
        fs.accessSync(p, fs.constants.X_OK);
        return fs.statSync(p).isFile();
      } catch {
        // @silent-fallback-ok — not executable (or gone): PATH lookup moves to the next entry.
        return false;
      }
    },
    now: () => Date.now(),
    ...extra,
  };
}
