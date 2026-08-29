import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

const execFileAsync = promisify(execFile);
const UNKNOWN_BACKOFF_MS = [10_000, 30_000, 90_000] as const;
const CACHE_TTL_MS = 24 * 60 * 60 * 1_000;
const MAX_CACHE_ROWS = 512;

export interface ExecutableSnapshot {
  realpath: string;
  device: number;
  inode: number;
}

export interface FrameworkProcessObservation {
  pid: number;
  parentPid: number;
  frameworkRootPid: number;
  sessionIncarnation: string;
  sessionStartedAt: number;
}

export interface FrameworkProcessProvenanceVerdict {
  protected: true;
  confirmed: boolean;
  reason: 'codex-code-mode-host' | 'ownership-unknown';
  detail?: string;
}

export interface FrameworkProcessProvenanceOptions {
  now?: () => number;
  snapshot?: () => ExecutableSnapshot | null;
  probe?: (pid: number) => Promise<{ procPath: string; lsofPath: string; device: number; inode: number; startTime: number }>;
  /** Exact configured launcher used to create this session; never ambient PATH. */
  launcherPath?: string;
}

interface CacheRow extends FrameworkProcessProvenanceVerdict {
  key: string;
  observedAt: number;
  retryCount: number;
  retryAt: number;
}

/**
 * Incarnation-bound executable verifier for Codex's code-mode host.
 * Uncertainty always preserves the candidate; confirmation requires path,
 * vnode, start-time, and direct framework-parent agreement.
 */
export class FrameworkProcessProvenanceVerifier {
  private static activeProbes = 0;
  private readonly cache = new Map<string, CacheRow>();
  private readonly snapshotByIncarnation = new Map<string, ExecutableSnapshot | null>();
  private readonly cachePath: string;
  private readonly now: () => number;
  private readonly deriveSnapshot: () => ExecutableSnapshot | null;
  private readonly runtimeProbe: FrameworkProcessProvenanceOptions['probe'];
  private readonly canaryPath: string;

  constructor(private readonly stateDir: string, options: FrameworkProcessProvenanceOptions = {}) {
    this.now = options.now ?? Date.now;
    this.deriveSnapshot = options.snapshot ?? (() => deriveCodexHostSnapshot(options.launcherPath));
    this.runtimeProbe = options.probe;
    this.cachePath = path.join(stateDir, 'state', 'framework-process-provenance.json');
    this.canaryPath = path.join(stateDir, 'state', 'framework-process-provenance-canary.json');
    this.load();
  }

  /** Daily/upgrade canary. Three consecutive failures emit one deduped alert. */
  runCanary(): { ok: boolean; consecutiveFailures: number; alert: boolean } {
    let previous = { consecutiveFailures: 0, alerted: false };
    try { previous = { ...previous, ...JSON.parse(fs.readFileSync(this.canaryPath, 'utf8')) }; } catch { /* first run */ }
    const ok = this.deriveSnapshot() !== null;
    const consecutiveFailures = ok ? 0 : previous.consecutiveFailures + 1;
    const alert = !ok && consecutiveFailures >= 3 && !previous.alerted;
    const alerted = ok ? false : previous.alerted || alert;
    try {
      fs.mkdirSync(path.dirname(this.canaryPath), { recursive: true, mode: 0o700 });
      fs.writeFileSync(this.canaryPath, JSON.stringify({ consecutiveFailures, alerted, checkedAt: this.now() }), { mode: 0o600 });
    } catch { /* canary remains conservative in memory */ }
    return { ok, consecutiveFailures, alert };
  }

  async classify(observation: FrameworkProcessObservation): Promise<FrameworkProcessProvenanceVerdict> {
    const snapshot = this.snapshotFor(observation.sessionIncarnation);
    if (!snapshot) return this.unknown(observation, 'expected-executable-unavailable');
    const prefix = `${observation.sessionIncarnation}:${observation.pid}:`;
    const prior = [...this.cache.values()].find((row) => row.key.startsWith(prefix)
      && this.now() - row.observedAt < CACHE_TTL_MS);
    if (prior?.confirmed) return stripCache(prior);
    if (prior && prior.retryAt > this.now()) return stripCache(prior);
    if (FrameworkProcessProvenanceVerifier.activeProbes >= 2) {
      return this.unknown(observation, 'probe-concurrency-cap');
    }
    FrameworkProcessProvenanceVerifier.activeProbes += 1;
    try {
      const runtime = this.runtimeProbe ? await this.runtimeProbe(observation.pid) : await this.probe(observation.pid);
      const key = `${prefix}${runtime.startTime}:${snapshot.device}:${snapshot.inode}`;
      const confirmed = observation.parentPid === observation.frameworkRootPid
        && runtime.startTime >= observation.sessionStartedAt
        && runtime.procPath === snapshot.realpath
        && runtime.lsofPath === snapshot.realpath
        && runtime.device === snapshot.device
        && runtime.inode === snapshot.inode;
      const row: CacheRow = confirmed
        ? { key, protected: true, confirmed: true, reason: 'codex-code-mode-host', observedAt: this.now(), retryCount: 0, retryAt: 0 }
        : this.makeUnknown(key, prior?.retryCount ?? 0, 'runtime-identity-conflict');
      this.cache.set(key, row);
      this.persist();
      return stripCache(row);
    } catch (err) {
      return this.unknown(observation, err instanceof Error ? err.message : String(err), prior?.retryCount ?? 0);
    } finally {
      FrameworkProcessProvenanceVerifier.activeProbes -= 1;
    }
  }

  endIncarnation(incarnation: string): void {
    this.snapshotByIncarnation.delete(incarnation);
    for (const [key] of this.cache) if (key.startsWith(`${incarnation}:`)) this.cache.delete(key);
    this.persist();
  }

  private snapshotFor(incarnation: string): ExecutableSnapshot | null {
    if (this.snapshotByIncarnation.has(incarnation)) return this.snapshotByIncarnation.get(incarnation)!;
    const resolved = this.deriveSnapshot();
    this.snapshotByIncarnation.set(incarnation, resolved);
    return resolved;
  }

  private unknown(observation: FrameworkProcessObservation, detail: string, retryCount = 0): FrameworkProcessProvenanceVerdict {
    const key = `${observation.sessionIncarnation}:${observation.pid}:unknown`;
    const row = this.makeUnknown(key, retryCount, detail);
    this.cache.set(key, row);
    this.persist();
    return stripCache(row);
  }

  private makeUnknown(key: string, retryCount: number, detail: string): CacheRow {
    const nextCount = Math.min(retryCount + 1, UNKNOWN_BACKOFF_MS.length);
    return {
      key, protected: true, confirmed: false, reason: 'ownership-unknown', detail,
      observedAt: this.now(), retryCount: nextCount,
      retryAt: this.now() + UNKNOWN_BACKOFF_MS[Math.min(nextCount - 1, UNKNOWN_BACKOFF_MS.length - 1)],
    };
  }

  private async probe(pid: number): Promise<{
    procPath: string; lsofPath: string; device: number; inode: number; startTime: number;
  }> {
    const procPath = process.platform === 'darwin'
      ? await macProcPidPath(pid)
      : fs.realpathSync(`/proc/${pid}/exe`);
    const { stdout: lsofOut } = await execFileAsync('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'txt', '-FnDi'], {
      encoding: 'utf8', timeout: 2_000, maxBuffer: 128 * 1024,
    });
    const lsof = parseLsofExecutable(lsofOut);
    const { stdout: started } = await execFileAsync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8', timeout: 2_000, maxBuffer: 8 * 1024,
    });
    const startTime = Date.parse(started.trim());
    if (!Number.isFinite(startTime)) throw new Error('process-start-time-unavailable');
    return { procPath: fs.realpathSync(procPath), lsofPath: fs.realpathSync(lsof.path), device: lsof.device, inode: lsof.inode, startTime };
  }

  private load(): void {
    try {
      const rows = JSON.parse(fs.readFileSync(this.cachePath, 'utf8')) as CacheRow[];
      for (const row of rows) if (this.now() - row.observedAt < CACHE_TTL_MS) this.cache.set(row.key, row);
    } catch { /* absent/corrupt cache is safely rebuilt */ }
  }

  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(this.cachePath), { recursive: true, mode: 0o700 });
      const rows = [...this.cache.values()]
        .filter((row) => this.now() - row.observedAt < CACHE_TTL_MS)
        .sort((a, b) => b.observedAt - a.observedAt)
        .slice(0, MAX_CACHE_ROWS);
      const tmp = `${this.cachePath}.tmp.${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(rows), { mode: 0o600 });
      fs.renameSync(tmp, this.cachePath);
    } catch { /* @silent-fallback-ok: persistence failure leaves the live verdict conservative */ }
  }
}

function deriveCodexHostSnapshot(configuredLauncher?: string): ExecutableSnapshot | null {
  try {
    const launcher = configuredLauncher;
    if (!launcher) return null;
    const realLauncher = fs.realpathSync(launcher);
    const packageRoot = path.dirname(path.dirname(realLauncher));
    const platformPackages = path.join(packageRoot, 'node_modules', '@openai');
    const candidates: string[] = [];
    for (const pkg of fs.readdirSync(platformPackages)) {
      if (!pkg.startsWith('codex-')) continue;
      const vendor = path.join(platformPackages, pkg, 'vendor');
      for (const arch of safeReadDir(vendor)) candidates.push(path.join(vendor, arch, 'bin', 'codex-code-mode-host'));
    }
    const host = candidates.find((candidate) => fs.existsSync(candidate));
    if (!host) return null;
    const realpath = fs.realpathSync(host);
    const stat = fs.statSync(realpath);
    return { realpath, device: stat.dev, inode: stat.ino };
  } catch { return null; }
}

function safeReadDir(dir: string): string[] {
  try { return fs.readdirSync(dir); } catch { return []; }
}

async function macProcPidPath(pid: number): Promise<string> {
  const script = [
    'import ctypes,sys',
    "lib=ctypes.CDLL('/usr/lib/libproc.dylib')",
    'buf=ctypes.create_string_buffer(4096)',
    'n=lib.proc_pidpath(int(sys.argv[1]),buf,len(buf))',
    "sys.stdout.write(buf.value.decode() if n>0 else '')",
  ].join(';');
  const { stdout } = await execFileAsync('/usr/bin/python3', ['-c', script, String(pid)], {
    encoding: 'utf8', timeout: 2_000, maxBuffer: 8 * 1024,
  });
  const result = stdout.trim();
  if (!result) throw new Error('proc-pidpath-unavailable');
  return result;
}

function parseLsofExecutable(output: string): { path: string; device: number; inode: number } {
  let device = Number.NaN;
  let inode = Number.NaN;
  for (const line of output.split('\n')) {
    if (line.startsWith('D')) device = Number.parseInt(line.slice(1), 16);
    else if (line.startsWith('i')) inode = Number(line.slice(1));
    else if (line.startsWith('n')) {
      const executable = line.slice(1);
      if (!executable || !Number.isFinite(device) || !Number.isFinite(inode)) throw new Error('lsof-vnode-unavailable');
      return { path: executable, device, inode };
    }
  }
  throw new Error('lsof-vnode-unavailable');
}

function stripCache(row: CacheRow): FrameworkProcessProvenanceVerdict {
  return { protected: true, confirmed: row.confirmed, reason: row.reason, ...(row.detail ? { detail: row.detail } : {}) };
}
