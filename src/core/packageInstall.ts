/**
 * How this computer installs a system package: brew on macOS; apt-get, dnf, yum or pacman on Linux.
 * Shared by `instar install`, `instar init` and the prerequisites check, so every path knows the
 * same package managers (Arch / Omarchy had none of them recognised, 2026-11-03).
 */
import { spawnSync } from 'node:child_process';

function commandExists(command: string): boolean {
  // lint-allow-sync-spawn: CLI-time only (install, init, prerequisites), never in the running server.
  return spawnSync('which', [command], { stdio: 'ignore' }).status === 0;
}

/** Arch names a few packages differently from Debian. */
const PACMAN_NAMES: Record<string, string> = { gh: 'github-cli', sqlite3: 'sqlite' };

/** How this computer can install these packages, or null when the person has to. Names any sudo it needs. */
export function packageInstallCommand(
  packages: string[],
  platform: NodeJS.Platform = process.platform,
  exists: (command: string) => boolean = commandExists,
): string[] | null {
  if (packages.length === 0) return null;
  if (platform === 'darwin') return exists('brew') ? ['brew', 'install', ...packages] : null;
  if (platform !== 'linux' || !exists('sudo')) return null;
  if (exists('apt-get')) return ['sudo', 'apt-get', 'install', '-y', ...packages];
  if (exists('dnf')) return ['sudo', 'dnf', 'install', '-y', ...packages];
  if (exists('yum')) return ['sudo', 'yum', 'install', '-y', ...packages];
  // Arch and Arch-based systems such as Omarchy. -y because a fresh Omarchy has no package
  // databases at all, so a plain -S answers "target not found" (seen live, 2026-11-03).
  if (exists('pacman')) return ['sudo', 'pacman', '-Sy', '--needed', '--noconfirm', ...packages.map(name => PACMAN_NAMES[name] ?? name)];
  return null;
}

