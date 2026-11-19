/**
 * The reference builder child (spec docs/specs/reaper-node-modules-regenerable.md §1, §3).
 *
 *   node dist/monitoring/agentWorktreeReferenceBuildMain.js --input-json <json>
 *
 * Started by the server (agentWorktreeReferenceBuilder.ts) `nice -n 10`, detached
 * in its own process group, at most one per reaper pass and never while a
 * reclaim run is active. One build, in this order:
 *   1. an exclusive build lock (temp file + `link(2)`, corroborated by build id);
 *   2. leftover scratch from a killed earlier build is deleted;
 *   3. the source checkout's lockfile is re-checked (every installed entry pinned)
 *      and its key recomputed;
 *   4. `package.json` (with its `scripts` field DELETED) and `package-lock.json`
 *      are copied into a fresh scratch folder;
 *   5. `nice -n 10 npm ci --ignore-scripts --offline --no-audit --no-fund`, with
 *      `npm_config_ignore_scripts=true` and `npm_config_offline=true` in its
 *      environment too, so the inner install pacote runs to pack a git dependency
 *      inherits both: no package code runs and nothing is downloaded. The scratch
 *      folder is measured while it runs and the build is killed past the ceiling
 *      (2 GB) or the timeout (6 min);
 *   6. every file is hashed (path → sha256, executable bit, link target) and the
 *      manifest is written atomically (temp, fsync, rename, fsync the folder);
 *   7. the scratch install is deleted on every exit path, and a result file is
 *      written for the supervisor.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';
import { takeReclaimLock, releaseReclaimLock } from './agentWorktreeReclaimMain.js';
import {
  analyzeLockfile,
  readReferenceInputs,
  referenceKey,
  hashNodeModulesTree,
  manifestFromTree,
  writeManifest,
  writeFileDurable,
  NPM_HIDDEN_LOCKFILE,
  REFERENCE_KEY,
  type BuildFailureCause,
} from './agentWorktreeNodeModules.js';

const execFileAsync = promisify(execFile);
const OP = 'src/monitoring/agentWorktreeReferenceBuildMain.ts';

export interface ReferenceBuildInput {
  buildId: string;
  key: string;
  sourceCheckout: string;
  refsDir: string;
  npmMajor: string;
  npmPath?: string;
  /** Tests point npm at a local cache; production uses npm's own. */
  npmCacheDir?: string;
  scratchCeilingBytes: number;
  timeoutMs: number;
  resultPath: string;
  /** How often the scratch folder is measured. */
  measureEveryMs?: number;
}

export interface ReferenceBuildResult {
  buildId: string;
  key: string;
  ok: boolean;
  cause?: BuildFailureCause | 'busy';
  error?: string;
  scratchHighWaterBytes: number;
  manifestFiles?: number;
  durationMs: number;
}

export function scratchRoot(refsDir: string): string { return path.join(refsDir, 'scratch'); }

/** Allocated bytes under `root` (async walk, links not followed). 0 when absent. */
async function scratchBytes(root: string): Promise<number> {
  let total = 0;
  const stack = [root];
  while (stack.length) {
    const d = stack.pop()!;
    let ents: fs.Dirent[];
    try { ents = await fs.promises.readdir(d, { withFileTypes: true }); }
    catch { continue; } // @silent-fallback-ok — a folder vanishing mid-measure only under-counts one sample
    for (const e of ents) {
      const full = path.join(d, e.name);
      try { total += (await fs.promises.lstat(full)).blocks * 512; } catch { /* @silent-fallback-ok — vanished */ }
      if (e.isDirectory()) stack.push(full);
    }
  }
  return total;
}

async function removeScratch(dir: string): Promise<void> {
  if (!fs.existsSync(dir)) return;
  await SafeFsExecutor.safeRm(dir, { recursive: true, force: true, operation: `${OP}:scratch` });
}

/** The scratch `package.json`: the checkout's, with `scripts` deleted, so the root's own scripts cannot run under any npm. */
export function stripScripts(packageJson: Buffer): string {
  const pkg = JSON.parse(packageJson.toString('utf8')) as Record<string, unknown>;
  delete pkg.scripts;
  return JSON.stringify(pkg, null, 2) + '\n';
}

/** The environment of the scratch install: the inner install pacote runs inherits both settings. */
export function buildEnv(base: NodeJS.ProcessEnv, npmCacheDir?: string): NodeJS.ProcessEnv {
  return {
    ...base,
    npm_config_ignore_scripts: 'true',
    npm_config_offline: 'true',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
    ...(npmCacheDir ? { npm_config_cache: npmCacheDir } : {}),
  };
}

export const BUILD_ARGS = ['ci', '--ignore-scripts', '--offline', '--no-audit', '--no-fund'] as const;

/** Map a failed npm's output to a cause. A missing cache entry fails fast and is retried daily. */
export function classifyNpmFailure(output: string): BuildFailureCause {
  return /ENOTCACHED|NotCachedError|only-if-cached|cache mode is 'only-if-cached'/i.test(output) ? 'npm-cache-missing' : 'build-error';
}

export async function runReferenceBuild(input: ReferenceBuildInput): Promise<ReferenceBuildResult> {
  const started = Date.now();
  let highWater = 0;
  const result = (r: Omit<ReferenceBuildResult, 'buildId' | 'key' | 'scratchHighWaterBytes' | 'durationMs'>): ReferenceBuildResult =>
    ({ buildId: input.buildId, key: input.key, scratchHighWaterBytes: highWater, durationMs: Date.now() - started, ...r });
  const lockPath = path.join(input.refsDir, 'build.lock');
  const got = await takeReclaimLock(lockPath, { pid: process.pid, runId: input.buildId, startedAt: started }, {
    staleUnreadableMs: input.timeoutMs * 2, now: () => Date.now(),
    commandOf: async (pid) => {
      try { return (await execFileAsync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', timeout: 10_000 })).stdout.trim(); }
      catch (err) { const e = err as { code?: unknown; stdout?: unknown }; return e.code === 1 && typeof e.stdout === 'string' && e.stdout.trim() === '' ? '' : null; } // @silent-fallback-ok — unreadable ⇒ the lock is not proven stale
    },
  });
  if (!got) return result({ ok: false, cause: 'busy', error: 'another reference build holds the lock' });
  const scratchAll = scratchRoot(input.refsDir);
  const scratch = path.join(scratchAll, input.buildId);
  try {
    // A builder that starts first deletes any leftover scratch from a killed earlier build.
    await removeScratch(scratchAll);
    if (!REFERENCE_KEY.test(input.key)) return result({ ok: false, cause: 'build-error', error: 'bad key' });
    const inputs = readReferenceInputs(input.sourceCheckout);
    if (!inputs) return result({ ok: false, cause: 'build-error', error: 'source checkout has no package.json + package-lock.json' });
    if (referenceKey(inputs, input.npmMajor) !== input.key) return result({ ok: false, cause: 'build-error', error: 'the source checkout\'s inputs changed since the pass' });
    const lock = analyzeLockfile(inputs.packageLock.toString('utf8'), input.sourceCheckout, { rejectUninstalledFetchable: true });
    if (!lock.ok) return result({ ok: false, cause: 'unsupported-source', error: lock.detail ?? lock.reason });
    fs.mkdirSync(scratch, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(scratch, 'package.json'), stripScripts(inputs.packageJson));
    fs.writeFileSync(path.join(scratch, 'package-lock.json'), inputs.packageLock);
    const npm = input.npmPath ?? 'npm';
    const useNice = process.platform !== 'win32';
    let output = '';
    let killedFor: BuildFailureCause | null = null;
    const exit = await new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      const child = spawn(useNice ? 'nice' : npm, useNice ? ['-n', '10', npm, ...BUILD_ARGS] : [...BUILD_ARGS], {
        cwd: scratch, env: buildEnv(process.env, input.npmCacheDir), stdio: ['ignore', 'pipe', 'pipe'], shell: false,
      });
      const take = (d: Buffer) => { if (output.length < 20_000) output += d.toString('utf8'); };
      child.stdout?.on('data', take);
      child.stderr?.on('data', take);
      const kill = (why: BuildFailureCause) => { if (!killedFor) killedFor = why; try { child.kill('SIGKILL'); } catch { /* @silent-fallback-ok — already exited */ } };
      const timer = setTimeout(() => kill('timeout'), input.timeoutMs);
      let measuring = false;
      const meter = setInterval(() => {
        if (measuring) return;
        measuring = true;
        void scratchBytes(scratch).then((b) => {
          measuring = false;
          if (b > highWater) highWater = b;
          if (b > input.scratchCeilingBytes) kill('scratch-ceiling');
        });
      }, input.measureEveryMs ?? 2_000);
      child.once('error', (err) => { output += `\n${err.message}`; });
      child.once('close', (code, signal) => { clearTimeout(timer); clearInterval(meter); resolve({ code, signal: signal ?? null }); });
    });
    const finalBytes = await scratchBytes(scratch);
    if (finalBytes > highWater) highWater = finalBytes;
    if (killedFor) return result({ ok: false, cause: killedFor, error: `npm killed (${killedFor})` });
    if (finalBytes > input.scratchCeilingBytes) return result({ ok: false, cause: 'scratch-ceiling', error: 'scratch grew past the ceiling' });
    if (exit.code !== 0) return result({ ok: false, cause: classifyNpmFailure(output), error: output.trim().split('\n').slice(-5).join(' | ').slice(0, 500) });
    if (!fs.existsSync(path.join(scratch, ...NPM_HIDDEN_LOCKFILE.split('/')))) return result({ ok: false, cause: 'build-error', error: 'no node_modules/.package-lock.json after npm ci' });
    const tree = hashNodeModulesTree(scratch);
    const manifest = manifestFromTree(tree, input.key, input.npmMajor, Date.now());
    writeManifest(input.refsDir, manifest);
    return result({ ok: true, manifestFiles: Object.keys(manifest.files).length });
  } catch (err) {
    return result({ ok: false, cause: 'build-error', error: (err as Error).message.slice(0, 500) });
  } finally {
    // Scratch is deleted on every exit path.
    try { await removeScratch(scratchAll); } catch { /* @silent-fallback-ok — the supervisor and the next build delete leftovers */ }
    releaseReclaimLock(lockPath, input.buildId);
  }
}

export function parseBuildArgs(argv: readonly string[]): ReferenceBuildInput | null {
  const i = argv.indexOf('--input-json');
  if (i < 0 || i + 1 >= argv.length) return null;
  try {
    const input = JSON.parse(argv[i + 1]) as ReferenceBuildInput;
    if (!/^[0-9a-f]{16,64}$/.test(input.buildId) || !REFERENCE_KEY.test(input.key)) return null;
    for (const k of ['sourceCheckout', 'refsDir', 'resultPath'] as const) if (typeof input[k] !== 'string' || !path.isAbsolute(input[k])) return null;
    if (typeof input.timeoutMs !== 'number' || typeof input.scratchCeilingBytes !== 'number' || !/^\d+$/.test(String(input.npmMajor))) return null;
    return input;
  } catch { return null; } // @silent-fallback-ok — malformed input ⇒ exit 2, nothing done
}

const isMain = (() => {
  try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; } // @silent-fallback-ok — not this module
})();

if (isMain) {
  void (async () => {
    const input = parseBuildArgs(process.argv);
    if (!input) { process.exitCode = 2; return; }
    // Backstop of its own past the timeout (the supervisor normally ends the group first).
    setTimeout(() => process.exit(4), input.timeoutMs + 60_000).unref();
    const r = await runReferenceBuild(input);
    try { writeFileDurable(input.resultPath, JSON.stringify(r)); }
    catch { process.exitCode = 3; } // @silent-fallback-ok — the supervisor records a build with no result as failed
  })();
}
