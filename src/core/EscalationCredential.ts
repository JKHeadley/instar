/**
 * EscalationCredential — the minimal, per-agent credential the fleet watchdog
 * needs to autonomously page the user about an outage when a healthy peer isn't
 * available (single-agent machine; the headline b2lead case).
 *
 * Spec: docs/specs/macos26-launchd-tcc-runtime-relocation.md (Scope C).
 *
 * SHAPE: `{ ownerTopicId, botToken }` — nothing else. We deliberately do NOT
 * store the agent's full config; the credential carries only what `curl ... |
 * Telegram sendMessage` needs. This is the minimal scoping the security review
 * accepted ("a single leak is one token") vs the rejected aggregate-token file.
 *
 * LOCATION: `~/.instar/registry/<bundleId>.json`, mode 0600 in a 0700 dir,
 * outside any TCC-protected folder (the launchd-spawned watchdog can always read
 * it), outside any project git tree (the Luna `.bak`-in-git-tree leak vector
 * cannot apply). The protections are STRUCTURAL (file modes + out-of-tree path
 * + atomic mode-at-creation write) — not "guidance."
 *
 * WHO ARMS IT: any context that can read the agent's authoritative config.json.
 *   - `instar setup` / `instar relocate` / `instar doctor` (consented contexts)
 *   - server boot on a healthy start (cheap, idempotent re-sync; only happens
 *     for agents that CAN heal-boot — i.e. relocated or non-TCC — since an
 *     unrelocated Documents agent on macOS 26 can't heal-boot at all)
 *
 * WHAT THIS MEANS PRACTICALLY: an agent dead-before-the-fix has no armed
 * credential and cannot be autonomously paged (the irreducible OS limit
 * documented in the outcome matrix). The first consented run arms it and every
 * future death pages autonomously.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** The launchd-label-shaped bundle id. */
export type BundleId = string; // e.g. "ai.instar.b2lead-insights"

export interface EscalationCredentialFields {
  /** Telegram chat/forum topic id (where the page is delivered). */
  ownerTopicId: number | string;
  /** Telegram bot token used by `curl -K -` (token never on argv). */
  botToken: string;
}

/** Machine-level registry dir — outside any TCC folder, outside any project. */
export function registryDir(homeDir: string = os.homedir()): string {
  return path.join(homeDir, '.instar', 'registry');
}

export function credentialPath(bundleId: BundleId, homeDir: string = os.homedir()): string {
  return path.join(registryDir(homeDir), `${sanitizeBundleId(bundleId)}.json`);
}

function sanitizeBundleId(id: BundleId): string {
  // Validate strictly — the bundle id is also a launchd label and a filename.
  if (!/^[A-Za-z0-9._-]+$/.test(id)) {
    throw new Error(`invalid bundleId for credential filename: ${JSON.stringify(id)}`);
  }
  return id;
}

/** Basic Telegram bot-token shape: <number>:<35+ alnum/_/->. */
export function isValidBotToken(token: unknown): token is string {
  return typeof token === 'string' && /^\d+:[A-Za-z0-9_-]{30,}$/.test(token);
}

/**
 * Write (or re-sync) the per-agent credential atomically. Validates token shape
 * BEFORE write (an empty/garbage credential is worse than no credential — the
 * watchdog would 401 forever instead of falling through to the consented drain).
 *
 * Returns:
 *   - 'written'        — file written/refreshed.
 *   - 'unchanged'      — file already contained these exact fields (no-op).
 *   - 'invalid-token'  — token failed shape validation; nothing written.
 */
export function writeCredential(
  bundleId: BundleId,
  fields: EscalationCredentialFields,
  homeDir: string = os.homedir(),
): 'written' | 'unchanged' | 'invalid-token' {
  if (!isValidBotToken(fields.botToken)) return 'invalid-token';
  if (fields.ownerTopicId === undefined || fields.ownerTopicId === null || fields.ownerTopicId === '') {
    return 'invalid-token';
  }

  const dir = registryDir(homeDir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // The mkdir call doesn't reset mode on an existing dir; force it.
  try { fs.chmodSync(dir, 0o700); } catch { /* best effort */ }

  const file = credentialPath(bundleId, homeDir);
  const payload = JSON.stringify({ ownerTopicId: fields.ownerTopicId, botToken: fields.botToken });

  // Read-and-compare so we don't re-fsync on every healthy boot.
  try {
    const existing = fs.readFileSync(file, 'utf-8');
    if (existing === payload) return 'unchanged';
  } catch { /* missing or unreadable */ }

  // Atomic mode-at-creation write: open the temp with explicit 0600 so umask
  // doesn't create a world-readable window, then rename into place.
  const tmp = `${file}.tmp-${process.pid}`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try { fs.writeFileSync(fd, payload); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* belt + suspenders */ }
  return 'written';
}

/** Read the credential (used by the watchdog's direct-Telegram path). Returns
 *  null on any read/parse/validation failure — the caller falls through to the
 *  consented-drain tier. */
export function readCredential(bundleId: BundleId, homeDir: string = os.homedir()): EscalationCredentialFields | null {
  try {
    const raw = fs.readFileSync(credentialPath(bundleId, homeDir), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<EscalationCredentialFields>;
    if (!isValidBotToken(parsed.botToken)) return null;
    if (parsed.ownerTopicId === undefined || parsed.ownerTopicId === null || parsed.ownerTopicId === '') return null;
    return { ownerTopicId: parsed.ownerTopicId as number | string, botToken: parsed.botToken as string };
  } catch {
    return null;
  }
}

/** Remove an agent's credential on uninstall. Best-effort. */
export function removeCredential(bundleId: BundleId, homeDir: string = os.homedir()): void {
  try { fs.rmSync(credentialPath(bundleId, homeDir)); } catch { /* none */ }
}
