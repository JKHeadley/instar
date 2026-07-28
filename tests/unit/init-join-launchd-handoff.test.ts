import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

/**
 * Track C (MULTI-MACHINE-BOOTSTRAP-ROBUSTNESS): the init→join LaunchAgent
 * handoff relies on the auto-start plist Label being keyed on projectName
 * (`ai.instar.<name>`). That keying is what lets `joinMesh` install auto-start
 * for the JOINED home and cleanly REPLACE any stale plist a prior `instar init`
 * of the same name left pointing at a different home — instead of two plists
 * fighting for the port (the 2026-05-27 failure).
 *
 * This test proves that property directly: installing auto-start twice for the
 * same projectName but different projectDirs leaves a SINGLE plist whose
 * ProgramArguments reference the SECOND (joined) dir.
 *
 * macOS-only (the plist path is `~/Library/LaunchAgents`). Sandboxed via a
 * tmpdir $HOME so it never touches the real LaunchAgents directory.
 */

const isDarwin = process.platform === 'darwin';

function makeAgentHome(root: string, name: string): string {
  const dir = path.join(root, name);
  // Minimal structure ensureStableNodeSymlink + installBootWrapper expect.
  fs.mkdirSync(path.join(dir, '.instar', 'bin'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.instar', 'logs'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.instar', 'shadow-install', 'node_modules'), { recursive: true });
  return dir;
}

describe('Track C — init→join LaunchAgent handoff (Label-keyed replace)', () => {
  let tmp: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-launchd-test-'));
    prevHome = process.env.HOME;
    // Sandbox the LaunchAgents dir (installMacOSLaunchAgent uses os.homedir()
    // which honors $HOME on macOS).
    process.env.HOME = path.join(tmp, 'home');
    fs.mkdirSync(path.join(tmp, 'home', 'Library', 'LaunchAgents'), { recursive: true });
  });

  afterEach(() => {
    if (prevHome !== undefined) process.env.HOME = prevHome;
    try { SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/unit/init-join-launchd-handoff cleanup' }); } catch { /* best-effort */ }
  });

  it.skipIf(!isDarwin)('a second install for the same name + different dir REPLACES the plist (joined dir wins)', async () => {
    const { installAutoStart } = await import('../../src/commands/setup.js');
    const name = 'mmtesthandoff';
    const initHome = makeAgentHome(tmp, 'init-home');
    const joinHome = makeAgentHome(tmp, 'join-home');

    // Simulate `instar init` installing auto-start at the init home...
    const ok1 = installAutoStart(name, initHome, false);
    expect(ok1).toBe(true);

    const plistPath = path.join(process.env.HOME!, 'Library', 'LaunchAgents', `ai.instar.${name}.plist`);
    expect(fs.existsSync(plistPath)).toBe(true);
    const afterInit = fs.readFileSync(plistPath, 'utf-8');
    expect(afterInit).toContain(initHome);

    // ...then `instar join` installing auto-start at the joined home (same name).
    const ok2 = installAutoStart(name, joinHome, false);
    expect(ok2).toBe(true);

    // Exactly one plist for this name, now pointing at the joined home.
    const afterJoin = fs.readFileSync(plistPath, 'utf-8');
    expect(afterJoin).toContain(joinHome);
    expect(afterJoin).not.toContain(`${initHome}<`); // init dir no longer a ProgramArgument value
    // Label is stable (single unit).
    expect(afterJoin).toContain(`<string>ai.instar.${name}</string>`);
  });

  it.skipIf(!isDarwin)('standby install (hasTelegram=false) starts the server, not a lifeline', async () => {
    const { installAutoStart } = await import('../../src/commands/setup.js');
    const name = 'mmteststandby';
    const home = makeAgentHome(tmp, 'standby-home');
    expect(installAutoStart(name, home, false)).toBe(true);
    const plist = fs.readFileSync(
      path.join(process.env.HOME!, 'Library', 'LaunchAgents', `ai.instar.${name}.plist`),
      'utf-8',
    );
    // server-start args, not lifeline-start.
    expect(plist).toContain('<string>server</string>');
    expect(plist).not.toContain('<string>lifeline</string>');
  });
});
