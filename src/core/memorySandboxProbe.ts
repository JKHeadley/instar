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
