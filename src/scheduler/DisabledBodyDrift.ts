/**
 * DisabledBodyDrift — detect whether an operator-disabled default has had
 * its body change since the operator disabled it.
 *
 * Per INSTAR-JOBS-AS-AGENTMD spec §Dashboard UX:
 *   row per job: status dot, name + description, schedule, last run + bodyHash link,
 *   enabled toggle (records disabledAtBodyHash), namespace badge
 *
 * The manifest field `disabledAtBodyHash` is captured by the Dashboard
 * when the operator flips the enabled toggle to false. It records the
 * normalized SHA-256 of the body at disable-time. On every subsequent
 * `instar update`, the body may change; `bodyDriftedSinceDisable(...)`
 * returns true when the current body hash no longer matches what was
 * captured. The Dashboard surfaces a "default has changed since you
 * disabled it — consider reviewing" badge in response.
 *
 * Pure function — reads the manifest + the .md file. No state, no
 * side-effects.
 */

import fs from 'node:fs';
import path from 'node:path';
import { hashBody, normalize } from './AgentMdLockFile.js';

export interface BodyDriftCheckOptions {
  /** Agent state directory root (e.g., `<projectDir>/.instar/`). */
  stateDir: string;
  /** Job slug to check. */
  slug: string;
}

export type BodyDriftStatus =
  | { kind: 'no-drift' }
  | { kind: 'drifted'; disabledAtBodyHash: string; currentBodyHash: string }
  | { kind: 'manifest-missing' }
  | { kind: 'body-missing'; expectedPath: string }
  | { kind: 'not-disabled'; note: string }
  | { kind: 'no-disable-record'; note: string };

export function bodyDriftedSinceDisable(opts: BodyDriftCheckOptions): BodyDriftStatus {
  const { stateDir, slug } = opts;
  const manifestPath = path.join(stateDir, 'jobs', 'schedule', `${slug}.json`);

  if (!fs.existsSync(manifestPath)) {
    return { kind: 'manifest-missing' };
  }

  let manifest: any;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  } catch {
    return { kind: 'manifest-missing' };
  }

  if (manifest.enabled !== false) {
    return { kind: 'not-disabled', note: `Slug "${slug}" is enabled; drift check applies only to operator-disabled defaults.` };
  }
  if (typeof manifest.disabledAtBodyHash !== 'string' || !manifest.disabledAtBodyHash.startsWith('sha256:')) {
    return { kind: 'no-disable-record', note: `Slug "${slug}" is disabled but has no disabledAtBodyHash captured. Pre-spec disable, or manifest manually edited.` };
  }

  // Resolve the body file — try instar/ first (origin:instar) then user/.
  const namespace: 'instar' | 'user' = manifest.origin === 'instar' ? 'instar' : 'user';
  const expectedPath = path.join(stateDir, 'jobs', namespace, `${slug}.md`);
  if (!fs.existsSync(expectedPath)) {
    return { kind: 'body-missing', expectedPath };
  }

  let bodyText: string;
  try {
    const raw = fs.readFileSync(expectedPath, 'utf-8');
    const match = raw.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
    bodyText = match ? match[1] : raw;
  } catch {
    return { kind: 'body-missing', expectedPath };
  }

  const currentBodyHash = hashBody(bodyText);
  if (currentBodyHash === manifest.disabledAtBodyHash) {
    return { kind: 'no-drift' };
  }

  return {
    kind: 'drifted',
    disabledAtBodyHash: manifest.disabledAtBodyHash,
    currentBodyHash,
  };
}

/**
 * Convenience helper: list every slug whose disabled-state has drifted
 * since the operator disabled it. Used by the Dashboard's status feed and
 * by the drift digest.
 */
export function listDriftedDisabledSlugs(stateDir: string): Array<{ slug: string; status: BodyDriftStatus }> {
  const scheduleDir = path.join(stateDir, 'jobs', 'schedule');
  if (!fs.existsSync(scheduleDir)) return [];
  const results: Array<{ slug: string; status: BodyDriftStatus }> = [];
  for (const f of fs.readdirSync(scheduleDir)) {
    if (!f.endsWith('.json') || f.startsWith('.')) continue;
    const slug = path.basename(f, '.json');
    const status = bodyDriftedSinceDisable({ stateDir, slug });
    if (status.kind === 'drifted') {
      results.push({ slug, status });
    }
  }
  return results;
}

/**
 * Stamp the disabledAtBodyHash field on a manifest. Used by the Dashboard
 * "disable" action and by the future CLI `instar job disable <slug>`
 * command. Idempotent: re-stamping with the same body produces the same
 * hash. Re-disabling after a body change produces a fresh hash.
 *
 * Returns the captured hash or null if the body cannot be read.
 */
export function stampDisabledAtBodyHash(stateDir: string, slug: string): string | null {
  const manifestPath = path.join(stateDir, 'jobs', 'schedule', `${slug}.json`);
  if (!fs.existsSync(manifestPath)) return null;

  let manifest: any;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  } catch {
    return null;
  }

  const namespace: 'instar' | 'user' = manifest.origin === 'instar' ? 'instar' : 'user';
  const bodyPath = path.join(stateDir, 'jobs', namespace, `${slug}.md`);
  if (!fs.existsSync(bodyPath)) return null;

  let bodyText: string;
  try {
    const raw = fs.readFileSync(bodyPath, 'utf-8');
    const match = raw.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
    bodyText = match ? match[1] : raw;
  } catch {
    return null;
  }

  const hash = hashBody(bodyText);
  manifest.disabledAtBodyHash = hash;
  manifest.enabled = false;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
  return hash;
}

/**
 * Clear the disabledAtBodyHash when an operator re-enables a job.
 * Idempotent.
 */
export function clearDisabledAtBodyHash(stateDir: string, slug: string): void {
  const manifestPath = path.join(stateDir, 'jobs', 'schedule', `${slug}.json`);
  if (!fs.existsSync(manifestPath)) return;
  let manifest: any;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  } catch {
    return;
  }
  delete manifest.disabledAtBodyHash;
  manifest.enabled = true;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
}

// Re-export the canonical normalize from AgentMdLockFile so callers can
// inspect what the hash is computed over without having to know which
// module owns it.
export { normalize };
