/**
 * Facts about an Instar agent running in WSL on a Windows machine: there the browser that signs
 * accounts in is Windows Chrome, whose profile folders are Windows paths (spec
 * windows-signin-repair).
 */
import os from 'node:os';

/** True on WSL. The kernel release is read, not the environment: a systemd service has no WSL_* variables. */
export function isWslHost(platform: NodeJS.Platform = process.platform, release: string = os.release()): boolean {
  return platform === 'linux' && /microsoft/i.test(release);
}

/**
 * A local absolute Windows directory in the one spelling ndrive.sh accepts: drive letter,
 * backslashes, no `.`/`..` segments, no doubled separator, no quote, wildcard or control character,
 * and no component ending in a dot or a space (Windows strips those).
 */
export function isWindowsProfileDir(value: string): boolean {
  if (!/^[A-Za-z]:\\[^\\]/.test(value) || value.length > 240) return false;
  // eslint-disable-next-line no-control-regex
  if (/["'`*?[\]<>|~\x00-\x1f]/.test(value)) return false;
  return value.slice(3).split('\\').every((part) => part.length > 0 && !part.endsWith('.') && !part.endsWith(' '));
}

/** `C:\Users\Public\x` as WSL mounts it: `/mnt/c/Users/Public/x`. Null for anything else. */
export function windowsDirToWslPath(dir: string): string | null {
  if (!isWindowsProfileDir(dir)) return null;
  return `/mnt/${dir[0].toLowerCase()}/${dir.slice(3).replace(/\\/g, '/')}`;
}
