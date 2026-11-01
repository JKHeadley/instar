/**
 * Install the native app conversation reply relay `app-reply.sh`
 * (docs/specs/mobile-native-conversations.md §4.3) with the same SHA-provenance rules as the
 * Slack relay: the framework-neutral authority at `<stateDir>/scripts/app-reply.sh`, plus the
 * Claude compatibility mirror in `.claude/scripts/`. Installed on every agent (an inert script
 * outside an app-conversation session), from init, PostUpdateMigrator.migrateScripts (always
 * reconciled to the shipped bytes) and at server boot.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { reconcileRelayFile, type SlackRelayInstallResult } from './SlackReplyRelayInstaller.js';

/** Every historical shipped app-reply.sh before the current one. Append-only. */
export const PRIOR_SHIPPED_APP_RELAY_SHA256: ReadonlySet<string> = new Set<string>([]);

export type AppRelayInstallResult = SlackRelayInstallResult;

export function ensureAppReplyRelay(params: {
  projectDir: string;
  stateDir: string;
  template: string;
  claudeCompatibility?: boolean;
}): AppRelayInstallResult {
  const result: AppRelayInstallResult = { installed: [], current: [], degraded: [], errors: [] };
  reconcileRelayFile(path.join(params.stateDir, 'scripts', 'app-reply.sh'), params.template, PRIOR_SHIPPED_APP_RELAY_SHA256, result);
  if (params.claudeCompatibility !== false) {
    reconcileRelayFile(path.join(params.projectDir, '.claude', 'scripts', 'app-reply.sh'), params.template, PRIOR_SHIPPED_APP_RELAY_SHA256, result);
  }
  return result;
}

/** Whether the canonical relay is installed, executable and byte-identical to the template. */
export function appReplyRelayReadiness(stateDir: string, expectedTemplate: string): { ready: true } | { ready: false; reason: string } {
  const destination = path.join(stateDir, 'scripts', 'app-reply.sh');
  try {
    const stat = fs.lstatSync(destination);
    if (!stat.isFile() || stat.isSymbolicLink()) return { ready: false, reason: 'canonical relay is not a regular non-symlink file' };
    if ((stat.mode & 0o111) === 0) return { ready: false, reason: 'canonical relay is not executable' };
    const sha = (b: string) => createHash('sha256').update(b).digest('hex');
    if (sha(fs.readFileSync(destination, 'utf8')) !== sha(expectedTemplate)) return { ready: false, reason: 'canonical relay bytes do not match the packaged template' };
    return { ready: true };
  } catch (err) {
    return { ready: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/** The packaged template bytes (dist or source layout), or null when the asset is absent. */
export function packagedAppReplyRelayTemplate(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    path.resolve(here, '..', 'templates', 'scripts', 'app-reply.sh'),
    path.resolve(here, '..', '..', 'src', 'templates', 'scripts', 'app-reply.sh'),
  ]) {
    try { return fs.readFileSync(candidate, 'utf8'); } catch { /* @silent-fallback-ok — try the other packaged/dev layout */ }
  }
  return null;
}
