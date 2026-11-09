/**
 * Install the peer-place reply relay `threadline-reply.sh`
 * (docs/specs/memory-privacy-agent-places.md §5, §7) with the same SHA-provenance rules as the
 * app relay: the framework-neutral authority at `<stateDir>/scripts/threadline-reply.sh`, plus the
 * Claude compatibility mirror in `.claude/scripts/`. Installed on every agent (inert outside a
 * session in another agent's place), from init, PostUpdateMigrator.migrateScripts (always
 * reconciled to the shipped bytes) and at server boot.
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { reconcileRelayFile, type SlackRelayInstallResult } from './SlackReplyRelayInstaller.js';

export const THREADLINE_REPLY_RELAY_NAME = 'threadline-reply.sh';

/** Every historical shipped threadline-reply.sh before the current one. Append-only. */
export const PRIOR_SHIPPED_THREADLINE_REPLY_SHA256: ReadonlySet<string> = new Set<string>([]);

export function ensureThreadlineReplyRelay(params: {
  projectDir: string;
  stateDir: string;
  template: string;
  claudeCompatibility?: boolean;
}): SlackRelayInstallResult {
  const result: SlackRelayInstallResult = { installed: [], current: [], degraded: [], errors: [] };
  reconcileRelayFile(path.join(params.stateDir, 'scripts', THREADLINE_REPLY_RELAY_NAME), params.template, PRIOR_SHIPPED_THREADLINE_REPLY_SHA256, result);
  if (params.claudeCompatibility !== false) {
    reconcileRelayFile(path.join(params.projectDir, '.claude', 'scripts', THREADLINE_REPLY_RELAY_NAME), params.template, PRIOR_SHIPPED_THREADLINE_REPLY_SHA256, result);
  }
  return result;
}

/** The packaged template bytes (dist or source layout), or null when the asset is absent. */
export function packagedThreadlineReplyRelayTemplate(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    path.resolve(here, '..', 'templates', 'scripts', THREADLINE_REPLY_RELAY_NAME),
    path.resolve(here, '..', '..', 'src', 'templates', 'scripts', THREADLINE_REPLY_RELAY_NAME),
  ]) {
    try { return fs.readFileSync(candidate, 'utf8'); } catch { /* @silent-fallback-ok — try the other packaged/dev layout */ }
  }
  return null;
}
