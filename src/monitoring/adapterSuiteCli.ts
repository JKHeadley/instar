/**
 * Child-process entry for the adapter verification suite
 * (context-budget-layered-summaries §9.6). The suite drives the engine CLI
 * synchronously for ~30 s, so the server runs it here, in its own process,
 * never on its event loop. Usage:
 *   node adapterSuiteCli.js <stateDir> <machine> [claudeBin]
 *   node adapterSuiteCli.js <stateDir> <machine> --engine=codex-cli [--codex-bin=codex] [--codex-home=<dir>]
 * Writes `state/context-budget/adapter-suite/<engine>-<version>.json` and
 * prints one JSON line `{ ok, version, file }` (or `{ ok: false, error }`).
 * The throwaway project lives in an OS temp directory (outside any repository or
 * agent home) and is removed afterwards; the engine's own transcripts of the
 * throwaway sessions stay in its project directory for the operator to inspect.
 * `last-run.json` beside the results records the latest attempt (ok or errors).
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runClaudeCodeAdapterSuite, writeSuiteResult, adapterSuiteDir } from './adapterVerificationSuite.js';
import { runCodexAdapterSuite, removeThrowawayProjectTrust, CODEX_ENGINE } from './codexAdapterSuite.js';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';

/** Work directories older than this (a killed run's leftovers) are swept at the next run. */
const STALE_WORK_MS = 60 * 60_000;
const WORK_PREFIX = 'instar-adapter-suite-';

export function runAdapterSuiteCli(argvIn: string[], tmpRoot: string = os.tmpdir()): { ok: true; version: string; file: string } | { ok: false; error: string } {
  const flag = (name: string) => argvIn.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const argv = argvIn.filter((a) => !a.startsWith('--'));
  const engine = flag('engine') ?? 'claude-code';
  const [stateDir, machine, claudeBin = 'claude'] = argv;
  if (!stateDir || !machine) return { ok: false, error: 'usage: adapterSuiteCli <stateDir> <machine> [claudeBin]' };
  // Sweep leftovers of killed runs (the kill skips this process's own cleanup).
  for (const d of fs.readdirSync(tmpRoot).filter((x) => x.startsWith(WORK_PREFIX))) {
    const full = path.join(tmpRoot, d);
    try { if (Date.now() - fs.statSync(full).mtimeMs > STALE_WORK_MS) SafeFsExecutor.safeRmSync(full, { recursive: true, force: true, operation: 'src/monitoring/adapterSuiteCli.ts:sweep' }); } catch { /* @silent-fallback-ok — a concurrent sweep or a vanished dir */ }
  }
  // OUTSIDE any repository or agent home: the probe sessions load no CLAUDE.md or memory but their own,
  // and the restore's checkpoint lives here too, never in the agent's context archive.
  const work = fs.mkdtempSync(path.join(tmpRoot, WORK_PREFIX));
  const project = path.join(work, 'project');
  fs.mkdirSync(project, { mode: 0o700 });
  // One last-run file per engine (Claude Code keeps the original name).
  const lastRunName = engine === CODEX_ENGINE ? `last-run-${CODEX_ENGINE}.json` : 'last-run.json';
  const lastRun = (body: Record<string, unknown>) => {
    const dir = adapterSuiteDir(stateDir); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, lastRunName), JSON.stringify({ at: Date.now(), engine, ...body }, null, 2), { mode: 0o600 });
  };
  const codexHome = flag('codex-home') || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  try {
    const { result } = engine === CODEX_ENGINE ? runCodexAdapterSuite({
      workDir: project, machine, codexHome,
      run: (args, o) => {
        // lint-allow-sync-spawn: runs in the suite's OWN child process (adapterSuiteCli), never on the server's event loop
        const r = spawnSync(flag('codex-bin') || 'codex', args, { cwd: o.cwd, env: o.env, encoding: 'utf-8', timeout: o.timeoutMs, input: '' });
        return { status: r.error ? null : r.status, stdout: r.stdout ?? '', stderr: r.error ? String(r.error.message) : (r.stderr ?? '') };
      },
    }) : runClaudeCodeAdapterSuite({
      workDir: project, stateDir: path.join(work, 'state'), machine,
      run: (args, o) => {
        // lint-allow-sync-spawn: runs in the suite's OWN child process (adapterSuiteCli), never on the server's event loop
        const r = spawnSync(claudeBin, args, { cwd: o.cwd, env: o.env, encoding: 'utf-8', timeout: o.timeoutMs, input: '' });
        return { status: r.error ? null : r.status, stdout: r.stdout ?? '', stderr: r.error ? String(r.error.message) : (r.stderr ?? '') };
      },
    });
    if (result.inconclusive) {
      // A run that measured the environment (rate limit, sign-in, missing binary) is NOT that
      // version's result: kept for diagnosis only, and the exit code makes the attempt count.
      lastRun({ ok: false, version: result.version, errors: result.errors });
      return { ok: false, error: `inconclusive: ${result.errors.slice(0, 3).join(' | ')}` };
    }
    const file = writeSuiteResult(stateDir, result);
    lastRun({ ok: true, version: result.version, file });
    return { ok: true, version: result.version, file };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    try { lastRun({ ok: false, error }); } catch { /* @silent-fallback-ok — the exit code still reports it */ }
    return { ok: false, error };
  } finally {
    // Codex persists a trust table for the throwaway directory: removed with it (that table only).
    if (engine === CODEX_ENGINE) { try { removeThrowawayProjectTrust(codexHome, path.resolve(project)); } catch { /* @silent-fallback-ok — a leftover table names a deleted directory; harmless */ } }
    SafeFsExecutor.safeRmSync(work, { recursive: true, force: true, operation: 'src/monitoring/adapterSuiteCli.ts:cleanup' });
  }
}

// Run when executed as the suite process: the spawner sets INSTAR_ADAPTER_SUITE_CLI=1
// (vite-node strips the script path from argv, so a path match alone cannot work there);
// plain `node adapterSuiteCli.js` is also recognised by its own path.
const self = fileURLToPath(import.meta.url);
if (process.env.INSTAR_ADAPTER_SUITE_CLI === '1' || (process.argv[1] && path.resolve(process.argv[1]) === self)) {
  const out = runAdapterSuiteCli(process.argv.slice(2).filter((a) => a !== '--'));
  process.stdout.write(`${JSON.stringify(out)}\n`);
  process.exitCode = out.ok ? 0 : 1;
}
