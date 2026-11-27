/**
 * memorySandboxProbe — does the OS sandbox actually start here? Spec:
 * docs/specs/memory-privacy.md §4. Checks the real tool, because stock Ubuntu 24.04
 * has bubblewrap installed and still refuses it without an AppArmor profile.
 */

import { execFile, spawn } from 'node:child_process';

function run(cmd: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 5000 }, (err) => resolve(!err));
  });
}

export async function memorySandboxWorks(platform: NodeJS.Platform = process.platform): Promise<boolean> {
  if (platform === 'darwin') return run('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true']);
  if (platform !== 'linux') return false;
  const namespaces = await run('bwrap', ['--unshare-net', '--ro-bind', '/', '/', '/bin/true']);
  return namespaces && run('socat', ['-V']);
}

/** The one-time root step on Ubuntu 24.04; used by the update path when `sudo -n` works. */
export const BWRAP_APPARMOR_PROFILE = `abi <abi/4.0>,
include <tunables/global>
profile bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,
  include if exists <local/bwrap>
}
`;

/**
 * Best effort, with no prompt. A fresh Ubuntu server has neither tool, and without
 * them every scoped conversation gets the fixed reply. Other distributions are left
 * to the operator; the degradation report names the fix.
 */
export function installSandboxPackages(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('sudo', ['-n', 'apt-get', 'install', '-y', '-qq', 'bubblewrap', 'socat'],
      { timeout: 120_000, env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive' } },
      (err) => resolve(!err));
  });
}

/** Best effort, with no prompt: `sudo -n` either works or does nothing. */
export function installBwrapProfile(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('sudo', ['-n', 'sh', '-c', 'cat > /etc/apparmor.d/bwrap && apparmor_parser -r /etc/apparmor.d/bwrap'], { stdio: ['pipe', 'ignore', 'ignore'] });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
    child.stdin.on('error', () => { /* @silent-fallback-ok — sudo refused before reading */ });
    child.stdin.end(BWRAP_APPARMOR_PROFILE);
  });
}

/** Why scoped sessions cannot run here. Null means they can. */
export type MemorySandboxBlocker = 'sandbox' | 'claude-missing' | 'claude-too-old';

/** The version a Claude binary reports, or null when it will not run. */
export function readClaudeVersion(claudePath: string | undefined): Promise<string | null> {
  return new Promise((resolve) => {
    if (!claudePath) { resolve(null); return; }
    execFile(claudePath, ['--version'], { timeout: 10_000 }, (err, stdout) => {
      const have = /(\d+\.\d+\.\d+)/.exec(String(stdout));
      resolve(err || !have ? null : have[1]);
    });
  });
}

/** Where Claude Code is usually installed, for a server whose PATH is thin under launchd. */
export function knownClaudePaths(home: string): string[] {
  return ['/opt/homebrew/bin/claude', '/usr/local/bin/claude', `${home}/.local/bin/claude`, `${home}/.claude/local/claude`];
}

/** The first of these that really runs at or above the floor. Each one is executed, not assumed. */
export async function findClaudeAtFloor(paths: string[], floor: string): Promise<string | null> {
  for (const candidate of paths) {
    if (await claudeMeetsFloor(candidate, floor)) return candidate;
  }
  return null;
}

/** An older binary could ignore these settings, which would leave the shell unbounded. */
export function claudeMeetsFloor(claudePath: string | undefined, floor: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (!claudePath) { resolve(false); return; }
    execFile(claudePath, ['--version'], { timeout: 10_000 }, (err, stdout) => {
      const have = /(\d+)\.(\d+)\.(\d+)/.exec(String(stdout));
      if (err || !have) { resolve(false); return; }
      const want = floor.split('.').map(Number);
      for (let i = 0; i < 3; i++) {
        const n = Number(have[i + 1]);
        if (n !== want[i]) { resolve(n > want[i]); return; }
      }
      resolve(true);
    });
  });
}
