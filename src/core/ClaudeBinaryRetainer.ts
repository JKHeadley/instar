/**
 * ClaudeBinaryRetainer — launch Claude Code sessions from a per-version
 * RETAINED copy of the claude executable, never from the mutable npm path.
 *
 * Why this exists (Mac Studio, 2026-10-14, lane studio-kmem-leak-1014):
 * Claude Code is a global npm install. Every update replaces
 * `node_modules/@anthropic-ai/claude-code/bin/claude.exe` IN PLACE, so every
 * Claude session that was already running keeps an UNLINKED executable
 * mapped. On macOS, EndpointSecurity path lookups on an unlinked executable
 * fail (`vn_getpath failed: 0x2`) and each failure leaks ~1 KiB in the kernel
 * zone `data.kalloc.1024` (measured 163 MiB/h across seven sessions; the host
 * panicked on 2026-10-06 at 20 GiB in that zone). The leaked kernel memory is
 * NOT reclaimed when the process exits.
 *
 * The fix is structural, not a watchdog: at spawn time, resolve the claude
 * executable's real path + version, copy it ONCE into
 * `<dir>/<version>/claude`, and launch from that copy. A later update replaces
 * the npm file, but the retained copy keeps its directory entry, so the
 * running session's executable stays linked and the kernel path lookup keeps
 * succeeding. New sessions after the update get a NEW version directory. Old
 * directories are pruned only once no live process maps them (and a usage
 * grace window has passed), never while in use.
 *
 * Contract:
 *  - `resolve()` is SYNCHRONOUS and used on the spawn path. It copies only on
 *    a NEW version (one ~250 MB copy per update), otherwise it is a few stats.
 *  - It NEVER replaces an existing retained file in place (that would recreate
 *    the exact unlink-under-a-live-process this fixes). A new version always
 *    lands in a new directory; a same-version size mismatch lands in a
 *    size-suffixed sibling directory.
 *  - Every failure falls back to the ORIGINAL path with a named reason and a
 *    LOUD log line, so a retainer defect can never stop sessions from
 *    spawning — the leak is a slow failure, a spawn refusal is an immediate one.
 *  - `prune()` is async, deletes only non-current, unmapped, past-grace
 *    directories, and treats "cannot tell whether it is mapped" as KEEP.
 *  - Only a genuine Claude Code binary is retained: a wrapper SCRIPT
 *    (shebang) is launched as-is because a script is read by its interpreter,
 *    never mapped as the process executable, so it cannot trigger the leak —
 *    and relocating a wrapper could break its relative references.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { SafeFsExecutor } from './SafeFsExecutor.js';
import { withSyncOp } from './InFlightSyncOpMarker.js';

export interface RetainedClaudeBinaryConfig {
  /** Off switch. Absent = ON (the leak is the default-on failure). */
  enabled?: boolean;
  /** Directory holding `<version>/claude`. Default: `<projectDir>/.instar/state/claude-bin`. */
  dir?: string;
  /**
   * A non-current version directory is a prune candidate only once it has
   * not been used to launch anything for this long (default 6 h). This covers
   * the window between "resolve picked a path" and "the process exec'd it".
   */
  pruneGraceMs?: number;
}

export const DEFAULT_PRUNE_GRACE_MS = 6 * 60 * 60 * 1000;
export const RETAINED_BINARY_NAME = 'claude';
export const LAST_USED_MARKER = '.last-used';
export const SOURCE_MANIFEST = 'source.json';
const PRUNE_MAX_REMOVALS_PER_PASS = 20;
const VERSION_PROBE_TIMEOUT_MS = 20_000;
const LSOF_TIMEOUT_MS = 15_000;

export type RetainFallbackReason =
  | 'disabled'
  | 'source-missing'
  | 'source-unreadable'
  | 'not-a-file'
  | 'script-not-retained'
  | 'not-claude-binary'
  | 'retained-mismatch'
  | 'copy-failed';

export interface RetainResolution {
  /** The path to LAUNCH. */
  path: string;
  source: 'retained' | 'original';
  /** Version string when it could be read; null when a fingerprint key was used. */
  version: string | null;
  /** The version-directory key (`2.1.299`, `2.1.299-247931696`, `fp-…`). */
  key: string | null;
  /** The path as configured (what we were asked to launch). */
  sourcePath: string;
  /** The real file the configured path points at right now. */
  sourceRealPath: string | null;
  /** How the version was read. */
  versionVia: 'package-json' | 'version-flag' | 'fingerprint' | null;
  /** True when THIS call made the copy (a new version landed). */
  copied: boolean;
  reason?: RetainFallbackReason;
  detail?: string;
  at: string;
}

export interface RetainedVersionEntry {
  key: string;
  path: string;
  version: string | null;
  sizeBytes: number | null;
  copiedAt: string | null;
  lastUsedAt: string | null;
  current: boolean;
}

export interface PruneResult {
  at: string;
  checked: number;
  removed: string[];
  keptCurrent: string[];
  keptInUse: string[];
  keptRecent: string[];
  keptUnknown: string[];
  errors: string[];
  skipped?: 'no-current-key' | 'disabled' | 'dir-missing';
}

export interface RetainerStatus {
  enabled: boolean;
  dir: string;
  pruneGraceMs: number;
  current: { key: string; version: string | null; path: string } | null;
  lastResolution: RetainResolution | null;
  lastError: { at: string; message: string } | null;
  counters: { resolutions: number; retained: number; copies: number; fallbacks: number };
  retained: RetainedVersionEntry[];
  lastPrune: PruneResult | null;
}

export interface ClaudeBinaryRetainerOptions {
  dir: string;
  enabled?: boolean;
  pruneGraceMs?: number;
  /** Test seam: count of live processes mapping `file` (null = cannot tell). */
  liveMappers?: (file: string) => Promise<number | null>;
  /** Test seam: run `<bin> --version` and return stdout. */
  versionProbe?: (bin: string) => string;
  /** Test seam: the copy primitive. */
  copyFile?: (src: string, dst: string) => void;
  now?: () => number;
  log?: { warn: (msg: string) => void; error: (msg: string) => void; info: (msg: string) => void };
}

const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;

/**
 * Is the retainer ON for this process? Production default is ON (absent =
 * on — the leak is the default-on failure). Under a test runner (VITEST set)
 * the default is OFF: dozens of SessionManager tests pin the launch argv
 * byte-for-byte against a configured claude path that happens to EXIST on a
 * developer's Mac and not on CI, so a host-dependent default would make the
 * same test pass on one machine and fail on another. An EXPLICIT
 * `enabled: true` always wins (the retainer's own tests set it), and an
 * explicit `false` always wins.
 */
export function resolveRetainerEnabled(configured: boolean | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  if (configured === true) return true;
  if (configured === false) return false;
  return !env.VITEST;
}

export function sanitizeVersionKey(version: string | null | undefined): string | null {
  if (!version) return null;
  const v = version.trim();
  return SAFE_KEY.test(v) ? v : null;
}

/**
 * Read the Claude Code version for a resolved real executable path.
 *  1. `../package.json` of the bin dir (the npm layout:
 *     `…/claude-code/bin/claude.exe` → `…/claude-code/package.json`), or a
 *     sibling `package.json`.
 *  2. `<bin> --version` (the native installer lays the binary down as
 *     `~/.local/share/claude/versions/<ver>` with no package.json).
 */
export function readClaudeVersion(
  realPath: string,
  versionProbe: (bin: string) => string = defaultVersionProbe,
): { version: string | null; via: 'package-json' | 'version-flag' | null } {
  const binDir = path.dirname(realPath);
  for (const candidate of [path.join(binDir, '..', 'package.json'), path.join(binDir, 'package.json')]) {
    try {
      if (!fs.existsSync(candidate)) continue;
      const pkg = JSON.parse(fs.readFileSync(candidate, 'utf8')) as { name?: unknown; version?: unknown };
      const name = typeof pkg.name === 'string' ? pkg.name : '';
      if (name && !/claude/i.test(name)) continue;
      const version = sanitizeVersionKey(typeof pkg.version === 'string' ? pkg.version : null);
      if (version) return { version, via: 'package-json' };
    } catch {
      // @silent-fallback-ok — an unreadable package.json just means we try the
      // next source; the fingerprint fallback below is always available.
    }
  }
  try {
    const out = versionProbe(realPath);
    const m = /(\d+\.\d+\.\d+[A-Za-z0-9._-]*)/.exec(out ?? '');
    const version = sanitizeVersionKey(m?.[1] ?? null);
    if (version) return { version, via: 'version-flag' };
  } catch {
    // @silent-fallback-ok — a failed probe falls through to the fingerprint key.
  }
  return { version: null, via: null };
}

function defaultVersionProbe(bin: string): string {
  // Sync by necessity (resolve() sits on the synchronous spawn path) and
  // bounded: once per installed build (cached by the retainer), never per spawn.
  return withSyncOp(() => execFileSync(bin, ['--version'], {
    encoding: 'utf8',
    timeout: VERSION_PROBE_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, CLAUDE_CODE_DISABLE_AUTOUPDATER: '1' },
  }));
}

/** Resolve a bare command name through PATH; absolute/relative paths pass through. */
export function locateExecutable(configured: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!configured) return null;
  if (configured.includes('/')) return configured;
  for (const dir of (env.PATH ?? '').split(':').filter(Boolean)) {
    const candidate = path.join(dir, configured);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // @silent-fallback-ok — not in this PATH entry; keep looking.
    }
  }
  return null;
}

/**
 * Only a path that is plainly a Claude Code install is retained: the file is
 * named `claude` / `claude.exe`, or a path component is the npm package dir
 * (`claude-code`, `@anthropic-ai`), the native-installer dir (`claude`), or
 * `.claude`. Component-exact so an unrelated directory whose NAME merely
 * contains "claude" (a tmp dir, a project) does not qualify.
 */
export function looksLikeClaudeInstall(realPath: string): boolean {
  const parts = realPath.split(path.sep).filter(Boolean);
  const base = parts[parts.length - 1] ?? '';
  if (/^claude(\.exe)?$/i.test(base)) return true;
  return parts.slice(0, -1).some((c) => /^(claude|claude-code|\.claude|@anthropic-ai)$/i.test(c));
}

function startsWithShebang(file: string): boolean {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(2);
    const n = fs.readSync(fd, buf, 0, 2, 0);
    return n === 2 && buf[0] === 0x23 && buf[1] === 0x21; // "#!"
  } catch {
    // @silent-fallback-ok — unreadable head is treated as "not a script"; the
    // copy step will surface a real read error loudly.
    return false;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* @silent-fallback-ok — close of a read-only fd */ }
    }
  }
}

/**
 * Count live processes mapping `file`. Linux: scan `/proc/*\/exe` (no
 * subprocess). Elsewhere: `lsof -t -- <file>` (exit 1 + empty output = none).
 * Returns null whenever the answer is not trustworthy — the caller KEEPS.
 */
export async function defaultLiveMappers(file: string): Promise<number | null> {
  if (process.platform === 'linux') {
    try {
      // /proc/<pid>/exe is always canonical; compare canonical to canonical.
      const target = fs.realpathSync(file);
      let count = 0;
      for (const pid of fs.readdirSync('/proc')) {
        if (!/^\d+$/.test(pid)) continue;
        try {
          if (fs.readlinkSync(`/proc/${pid}/exe`) === target) count++;
        } catch {
          // @silent-fallback-ok — a process we cannot inspect (not ours) is
          // not evidence either way; the realpath comparison below is the
          // conservative half (a deleted exe reads "<path> (deleted)").
        }
      }
      return count;
    } catch {
      // @silent-fallback-ok — /proc unreadable: "cannot tell" → the caller KEEPS.
      return null;
    }
  }
  return await new Promise<number | null>((resolveP) => {
    execFile('lsof', ['-t', '--', file], { timeout: LSOF_TIMEOUT_MS, encoding: 'utf8' }, (err, stdout) => {
      const pids = String(stdout ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
      if (!err) return resolveP(pids.length);
      // lsof exits 1 when no process has the file open — that IS an answer,
      // as long as it was lsof that answered (not ENOENT / a timeout).
      const e = err as unknown as { code?: unknown; killed?: boolean; signal?: string | null };
      if (e.code === 1 && !e.killed && !e.signal) return resolveP(pids.length);
      return resolveP(null);
    });
  });
}

export class ClaudeBinaryRetainer {
  readonly dir: string;
  readonly enabled: boolean;
  readonly pruneGraceMs: number;
  private readonly liveMappers: (file: string) => Promise<number | null>;
  private readonly versionProbe: (bin: string) => string;
  private readonly copyFile: (src: string, dst: string) => void;
  private readonly now: () => number;
  private readonly log: NonNullable<ClaudeBinaryRetainerOptions['log']>;
  private currentKey: string | null = null;
  private currentVersion: string | null = null;
  private lastResolution: RetainResolution | null = null;
  private lastError: { at: string; message: string } | null = null;
  private lastPrune: PruneResult | null = null;
  private counters = { resolutions: 0, retained: 0, copies: 0, fallbacks: 0 };
  /** Version-read cache keyed on the source file's identity, so the (slow,
   *  synchronous) `--version` fallback for a package.json-less layout runs
   *  once per installed build, not once per spawn. */
  private versionCache = new Map<string, ReturnType<typeof readClaudeVersion>>();
  private pruneInFlight: Promise<PruneResult> | null = null;

  constructor(opts: ClaudeBinaryRetainerOptions) {
    this.dir = opts.dir;
    this.enabled = opts.enabled !== false;
    this.pruneGraceMs = opts.pruneGraceMs ?? DEFAULT_PRUNE_GRACE_MS;
    this.liveMappers = opts.liveMappers ?? defaultLiveMappers;
    this.versionProbe = opts.versionProbe ?? defaultVersionProbe;
    // COPYFILE_FICLONE: a reflink/clone where the filesystem supports it (APFS),
    // a plain copy elsewhere — never an error for lack of clone support.
    this.copyFile = opts.copyFile ?? ((src, dst) => fs.copyFileSync(src, dst, fs.constants.COPYFILE_FICLONE));
    this.now = opts.now ?? (() => Date.now());
    this.log = opts.log ?? {
      warn: (m) => console.warn(m),
      error: (m) => console.error(m),
      info: (m) => console.log(m),
    };
  }

  /** The default retain dir for an agent: under its gitignored state dir. */
  static defaultDir(projectDir: string): string {
    return path.join(projectDir, '.instar', 'state', 'claude-bin');
  }

  /**
   * Resolve the path to launch for `configuredPath`. Synchronous; copies only
   * when a new version is seen. Never throws — every failure is a fallback
   * to the original path with a reason.
   */
  resolve(configuredPath: string): RetainResolution {
    this.counters.resolutions++;
    const at = new Date(this.now()).toISOString();
    const fallback = (reason: RetainFallbackReason, detail: string, realPath: string | null = null, loud = false): RetainResolution => {
      this.counters.fallbacks++;
      const res: RetainResolution = {
        path: configuredPath, source: 'original', version: null, key: null, sourcePath: configuredPath,
        sourceRealPath: realPath, versionVia: null, copied: false, reason, detail, at,
      };
      this.lastResolution = res;
      if (loud) {
        this.lastError = { at, message: `${reason}: ${detail}` };
        this.log.error(
          `[ClaudeBinaryRetainer] LAUNCHING FROM THE ORIGINAL PATH (${configuredPath}) — ${reason}: ${detail}. ` +
          'A Claude Code update will unlink this session\'s executable and leak kernel memory on macOS ' +
          '(data.kalloc.1024). Fix the retain dir or disable sessions.retainedClaudeBinary deliberately.',
        );
      }
      return res;
    };

    if (!this.enabled) return fallback('disabled', 'sessions.retainedClaudeBinary.enabled is false');

    const located = locateExecutable(configuredPath);
    if (!located) return fallback('source-missing', `"${configuredPath}" is not on PATH`);

    let realPath: string;
    let srcStat: fs.Stats;
    try {
      realPath = fs.realpathSync(located);
      srcStat = fs.statSync(realPath);
    } catch (err) {
      // @silent-fallback-ok — NOT silent: the resolution carries a named reason
      // and the status route exposes it; the session still launches.
      return fallback('source-unreadable', `${located}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!srcStat.isFile()) return fallback('not-a-file', realPath, realPath);
    if (!looksLikeClaudeInstall(realPath)) return fallback('not-claude-binary', `${realPath} does not look like a Claude Code install`, realPath);
    if (startsWithShebang(realPath)) return fallback('script-not-retained', `${realPath} is a wrapper script (not mapped as an executable; cannot trigger the leak)`, realPath);

    const cacheKey = `${realPath}|${srcStat.size}|${Math.floor(srcStat.mtimeMs)}`;
    let read = this.versionCache.get(cacheKey);
    if (!read) {
      read = readClaudeVersion(realPath, this.versionProbe);
      this.versionCache.set(cacheKey, read);
    }
    const version = read.version;
    const versionVia: RetainResolution['versionVia'] = read.via ?? 'fingerprint';
    const baseKey = version ?? `fp-${srcStat.size}-${Math.floor(srcStat.mtimeMs)}`;

    // Find or create the directory for THIS source content. A retained file is
    // never replaced: a same-key size mismatch goes to a size-suffixed sibling.
    const candidates = [baseKey, `${baseKey}-${srcStat.size}`];
    for (const key of candidates) {
      const retainedPath = path.join(this.dir, key, RETAINED_BINARY_NAME);
      let existing: fs.Stats | null = null;
      try { existing = fs.statSync(retainedPath); } catch { existing = null; /* @silent-fallback-ok — absent → copy */ }
      if (existing) {
        if (existing.isFile() && existing.size === srcStat.size) {
          this.touchLastUsed(key);
          return this.accept({ key, version, versionVia, retainedPath, realPath, configuredPath, copied: false, at });
        }
        continue; // mismatch → try the sibling key
      }
      const copied = this.copyInto(key, realPath, srcStat, version);
      if (copied.ok) {
        return this.accept({ key, version, versionVia, retainedPath, realPath, configuredPath, copied: true, at });
      }
      return fallback('copy-failed', copied.error, realPath, true);
    }
    return fallback('retained-mismatch', `${this.dir}/${baseKey} and its size-suffixed sibling both exist with a different size than ${realPath}`, realPath, true);
  }

  private accept(input: {
    key: string; version: string | null; versionVia: RetainResolution['versionVia'];
    retainedPath: string; realPath: string; configuredPath: string; copied: boolean; at: string;
  }): RetainResolution {
    this.currentKey = input.key;
    this.currentVersion = input.version;
    this.counters.retained++;
    if (input.copied) this.counters.copies++;
    const res: RetainResolution = {
      path: input.retainedPath, source: 'retained', version: input.version, key: input.key,
      sourcePath: input.configuredPath, sourceRealPath: input.realPath, versionVia: input.versionVia,
      copied: input.copied, at: input.at,
    };
    this.lastResolution = res;
    if (input.copied) {
      this.log.info(`[ClaudeBinaryRetainer] retained Claude Code ${input.version ?? input.key} at ${input.retainedPath} (from ${input.realPath})`);
    }
    return res;
  }

  private copyInto(key: string, realPath: string, srcStat: fs.Stats, version: string | null): { ok: true } | { ok: false; error: string } {
    const versionDir = path.join(this.dir, key);
    const finalPath = path.join(versionDir, RETAINED_BINARY_NAME);
    const tmpPath = path.join(versionDir, `.${RETAINED_BINARY_NAME}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
    try {
      fs.mkdirSync(versionDir, { recursive: true, mode: 0o755 });
      this.copyFile(realPath, tmpPath);
      fs.chmodSync(tmpPath, 0o755);
      const copiedStat = fs.statSync(tmpPath);
      if (copiedStat.size !== srcStat.size) {
        throw new Error(`short copy: ${copiedStat.size} of ${srcStat.size} bytes`);
      }
      // Atomic, non-replacing publish: link() fails with EEXIST if another
      // process published the same version first — then theirs wins and ours
      // is discarded. rename() would REPLACE, which is the very unlink this
      // module exists to prevent.
      try {
        fs.linkSync(tmpPath, finalPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
      this.removeTmp(tmpPath);
      const manifest = {
        version, key, sourceRealPath: realPath, sizeBytes: srcStat.size,
        sourceMtimeMs: Math.floor(srcStat.mtimeMs), copiedAt: new Date(this.now()).toISOString(),
        hostname: os.hostname(), pid: process.pid,
      };
      try { fs.writeFileSync(path.join(versionDir, SOURCE_MANIFEST), JSON.stringify(manifest, null, 2) + '\n'); } catch { /* @silent-fallback-ok — the manifest is observability, the copy is the point */ }
      this.touchLastUsed(key);
      return { ok: true };
    } catch (err) {
      this.removeTmp(tmpPath);
      return { ok: false, error: `${finalPath}: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  private removeTmp(tmpPath: string): void {
    try {
      if (fs.existsSync(tmpPath)) SafeFsExecutor.safeUnlinkSync(tmpPath, { operation: 'ClaudeBinaryRetainer.copy-tmp' });
    } catch {
      // @silent-fallback-ok — a leftover tmp file is harmless and visible in status.
    }
  }

  private touchLastUsed(key: string): void {
    try {
      fs.writeFileSync(path.join(this.dir, key, LAST_USED_MARKER), new Date(this.now()).toISOString() + '\n');
    } catch {
      // @silent-fallback-ok — a missing marker only makes the directory look
      // OLDER to prune, and prune still requires zero live mappers.
    }
  }

  /** The directory this process has most recently launched from (null = never resolved). */
  current(): { key: string; version: string | null; path: string } | null {
    return this.currentKey
      ? { key: this.currentKey, version: this.currentVersion, path: path.join(this.dir, this.currentKey, RETAINED_BINARY_NAME) }
      : null;
  }

  listRetained(): RetainedVersionEntry[] {
    let names: string[] = [];
    try { names = fs.readdirSync(this.dir); } catch { return []; /* @silent-fallback-ok — no dir yet → nothing retained */ }
    const out: RetainedVersionEntry[] = [];
    for (const key of names.sort()) {
      if (key.startsWith('.')) continue;
      const versionDir = path.join(this.dir, key);
      const file = path.join(versionDir, RETAINED_BINARY_NAME);
      let sizeBytes: number | null = null;
      try {
        const st = fs.statSync(versionDir);
        if (!st.isDirectory()) continue;
        sizeBytes = fs.statSync(file).size;
      } catch {
        // @silent-fallback-ok — a version dir without its binary is listed
        // with sizeBytes null so prune can still reclaim it.
      }
      let version: string | null = null; let copiedAt: string | null = null;
      try {
        const m = JSON.parse(fs.readFileSync(path.join(versionDir, SOURCE_MANIFEST), 'utf8')) as { version?: unknown; copiedAt?: unknown };
        version = typeof m.version === 'string' ? m.version : null;
        copiedAt = typeof m.copiedAt === 'string' ? m.copiedAt : null;
      } catch { /* @silent-fallback-ok — manifest optional */ }
      let lastUsedAt: string | null = null;
      try { lastUsedAt = fs.statSync(path.join(versionDir, LAST_USED_MARKER)).mtime.toISOString(); } catch { /* @silent-fallback-ok */ }
      out.push({ key, path: file, version, sizeBytes, copiedAt, lastUsedAt, current: key === this.currentKey });
    }
    return out;
  }

  /**
   * Remove retained versions that are not current, have not been used within
   * the grace window, and that NO live process maps. "Cannot tell" keeps.
   */
  async prune(): Promise<PruneResult> {
    if (this.pruneInFlight) return this.pruneInFlight;
    this.pruneInFlight = this.pruneOnce().finally(() => { this.pruneInFlight = null; });
    return this.pruneInFlight;
  }

  private async pruneOnce(): Promise<PruneResult> {
    const result: PruneResult = {
      at: new Date(this.now()).toISOString(), checked: 0, removed: [], keptCurrent: [], keptInUse: [],
      keptRecent: [], keptUnknown: [], errors: [],
    };
    if (!this.enabled) { result.skipped = 'disabled'; this.lastPrune = result; return result; }
    if (!this.currentKey) { result.skipped = 'no-current-key'; this.lastPrune = result; return result; }
    if (!fs.existsSync(this.dir)) { result.skipped = 'dir-missing'; this.lastPrune = result; return result; }
    const now = this.now();
    for (const entry of this.listRetained()) {
      result.checked++;
      if (entry.current) { result.keptCurrent.push(entry.key); continue; }
      const versionDir = path.join(this.dir, entry.key);
      let lastUsedMs: number;
      try {
        lastUsedMs = fs.statSync(path.join(versionDir, LAST_USED_MARKER)).mtimeMs;
      } catch {
        // @silent-fallback-ok — no marker: fall back to the directory's own mtime.
        try { lastUsedMs = fs.statSync(versionDir).mtimeMs; } catch { lastUsedMs = 0; /* @silent-fallback-ok — unstat-able dir reads as old; the mapper gate still protects it */ }
      }
      if (now - lastUsedMs < this.pruneGraceMs) { result.keptRecent.push(entry.key); continue; }
      if (result.removed.length >= PRUNE_MAX_REMOVALS_PER_PASS) break;
      let mappers: number | null = null;
      if (entry.sizeBytes !== null) {
        try { mappers = await this.liveMappers(entry.path); } catch { mappers = null; /* @silent-fallback-ok — unknown → keep */ }
        if (mappers === null) { result.keptUnknown.push(entry.key); continue; }
        if (mappers > 0) { result.keptInUse.push(entry.key); continue; }
      }
      // Re-read the marker AFTER the probe: a resolve() in another process may
      // have picked this version during the lsof wait (shared-dir case).
      try {
        if (this.now() - fs.statSync(path.join(versionDir, LAST_USED_MARKER)).mtimeMs < this.pruneGraceMs) {
          result.keptRecent.push(entry.key); continue;
        }
      } catch {
        // @silent-fallback-ok — no marker: the pre-probe age check already passed.
      }
      try {
        SafeFsExecutor.safeRmSync(versionDir, { recursive: true, force: true, operation: 'ClaudeBinaryRetainer.prune' });
        result.removed.push(entry.key);
      } catch (err) {
        result.errors.push(`${entry.key}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    this.lastPrune = result;
    if (result.removed.length > 0) {
      this.log.info(`[ClaudeBinaryRetainer] pruned ${result.removed.length} unused retained Claude Code version(s): ${result.removed.join(', ')}`);
    }
    return result;
  }

  status(): RetainerStatus {
    return {
      enabled: this.enabled,
      dir: this.dir,
      pruneGraceMs: this.pruneGraceMs,
      current: this.current(),
      lastResolution: this.lastResolution,
      lastError: this.lastError,
      counters: { ...this.counters },
      retained: this.listRetained(),
      lastPrune: this.lastPrune,
    };
  }
}
