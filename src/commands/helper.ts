/**
 * `instar helper pause|resume|uninstall` — the owner's controls for the borrowed-machine helper role
 * (docs/specs/local-verify-borrowed-unit-slices.md, B "Pause control" and "Uninstall").
 *
 *  - pause: the helper refuses new work and stops current work (the governor reads the pause at
 *    every 2 s sample; the running server is also told at once when reachable).
 *  - resume: new work is accepted again.
 *  - uninstall: removes the sandbox through the driver seam (the Lima VM, its disk and the pinned
 *    Lima install on macOS; `wsl --unregister instar-helper`, the owner-signal task and file on
 *    Windows), the learned list and the setting. Needs `--yes`; without it, it only lists what
 *    would be removed.
 */
import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import { loadConfig } from '../core/Config.js';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';
import { writeHelperPaused } from '../localVerify/helper/HelperService.js';
import { HelperLearnedStore } from '../localVerify/helper/learnedList.js';
import { isWslHost, selectSandboxDriver } from '../localVerify/helper/helperWiring.js';
import type { HelperSandboxDriver } from '../localVerify/helper/sandboxDriver.js';

interface HelperCmdOpts { dir?: string; yes?: boolean }

async function tellServer(port: number | undefined, token: string | undefined, paused: boolean): Promise<boolean> {
  if (!port || !token || token.startsWith('{')) return false;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/local-verify/helper-pause`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ paused }),
      signal: AbortSignal.timeout(3_000),
    });
    return r.ok;
  } catch { return false; } // @silent-fallback-ok: the control file is the source of truth; the governor reads it within 2 s
}

export async function helperPause(opts: HelperCmdOpts, paused: boolean): Promise<void> {
  const config = loadConfig(opts.dir);
  const msg = await helperPauseAt(config.stateDir, paused, { port: config.port, token: typeof config.authToken === 'string' ? config.authToken : undefined });
  console.log(pc.green(msg));
}

/** The pause / resume itself (testable without a full agent config). Returns the message shown. */
export async function helperPauseAt(stateDir: string, paused: boolean, server: { port?: number; token?: string } = {}): Promise<string> {
  writeHelperPaused(stateDir, paused, 'cli');
  const told = await tellServer(server.port, server.token, paused);
  return paused
    ? `Helper paused. It refuses new work and stops current work${told ? ' (server told now)' : ' within 2 seconds'}.`
    : 'Helper resumed. It accepts new work again.';
}

/** Remove `monitoring.localVerify.helper` from the agent's config (the setting goes with the helper). */
export function removeHelperSetting(stateDir: string): boolean {
  const file = path.join(stateDir, 'config.json');
  let raw: Record<string, unknown>;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>; } catch { return false; }
  const lv = (raw.monitoring as { localVerify?: Record<string, unknown> } | undefined)?.localVerify;
  if (!lv || !('helper' in lv)) return false;
  delete lv.helper;
  SafeFsExecutor.atomicWriteJsonSync(file, raw, { operation: 'helper-uninstall:config', indent: 2 });
  return true;
}

export async function helperUninstall(opts: HelperCmdOpts): Promise<void> {
  const config = loadConfig(opts.dir);
  const driver = selectSandboxDriver({ platform: process.platform, wsl: isWslHost(), stateDir: config.stateDir });
  for (const line of await helperUninstallAt(config.stateDir, driver, opts.yes === true)) console.log(line);
}

/**
 * The uninstall itself, through the driver seam only (testable with a fake driver). Without `yes`
 * it removes nothing and returns what would be removed.
 */
export async function helperUninstallAt(stateDir: string, driver: HelperSandboxDriver | null, yes: boolean): Promise<string[]> {
  const what = [
    driver?.kind === 'lima' ? 'the Lima virtual machine instar-helper, its disk under ~/.instar-helper/ and the pinned Lima install'
      : driver?.kind === 'wsl' ? 'the WSL distro instar-helper (never Echo\'s), the owner-signal scheduled task and its signal file'
        : driver ? `the ${driver.kind} sandbox` : 'no sandbox on this platform',
    'the learned exclude list',
    'the monitoring.localVerify.helper setting',
  ];
  if (!yes) return ['instar helper uninstall would remove:', ...what.map((w) => `  - ${w}`), pc.dim('Run again with --yes to remove them.')];
  writeHelperPaused(stateDir, true, 'uninstall');
  if (driver) await driver.uninstall();
  new HelperLearnedStore(stateDir).clear();
  removeHelperSetting(stateDir);
  for (const f of ['helper-control.json', 'helper-seen-attempts.json']) {
    try { SafeFsExecutor.safeRmSync(path.join(stateDir, 'state', 'local-verify', f), { force: true, operation: 'helper-uninstall' }); } catch { /* @silent-fallback-ok: already absent */ }
  }
  return [pc.green('Helper removed:'), ...what.map((w) => `  - ${w}`)];
}
