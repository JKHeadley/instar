/**
 * The owner name an agent states in its pairing invites and accepts (Justin, 2026-10-30, topic 9210:
 * "Owner info should be required"). The other person reads it before tapping Approve, so a blank is
 * refused rather than sent. The name stays a CLAIM on the wire (a2a-pairing-invite-link §7); this
 * only decides what this agent states about itself.
 *
 * Order: the explicit `threadline.ownerName` setting, then the registered users (admin first), then
 * the display name of the one verified Telegram operator (`resolveApprovalOwner`). A name read from
 * content is never a source.
 */
import fs from 'node:fs';
import path from 'node:path';
import { isVerifiedTopicOperatorBinding, TopicOperatorStore } from '../users/TopicOperatorStore.js';
import { UserManager } from '../users/UserManager.js';
import { cleanLabel } from './PairingInvite.js';
import { resolveApprovalOwner } from './PairingInviteTelegram.js';

export interface PairingOwnerSources {
  configured?: unknown;
  users?: ReadonlyArray<{ name?: string; permissions?: readonly string[] }> | null;
  configuredOwnerUid?: unknown;
  operatorBindings?: Iterable<unknown> | null;
  everVerifiedUids?: readonly string[] | null;
}

const clean = (v: unknown): string => (typeof v === 'string' ? cleanLabel(v) : '');

export function resolvePairingOwnerName(s: PairingOwnerSources): string {
  const configured = clean(s.configured);
  if (configured) return configured;
  const users = s.users ?? [];
  const named = [...users.filter((u) => u.permissions?.includes('admin')), ...users].map((u) => clean(u.name)).find(Boolean);
  if (named) return named;
  const bindings = [...(s.operatorBindings ?? [])];
  const uid = resolveApprovalOwner(s.configuredOwnerUid, bindings, s.everVerifiedUids);
  if (uid === undefined) return '';
  for (const b of bindings) {
    if (!isVerifiedTopicOperatorBinding(b) || b.platform !== 'telegram' || b.uid.trim() !== String(uid)) continue;
    const name = clean(b.names[0]);
    if (name) return name.replace(/(^|\s)\p{L}/gu, (c) => c.toUpperCase());
  }
  return '';
}

/**
 * Read the sources where they really live, without writing anything: the setting from the config
 * file (so setting it needs no restart), users from `<stateDir>/users.json` plus the boot config,
 * and operators from `<stateDir>/state`. An unreadable source counts as naming nobody.
 */
export function readPairingOwnerName(
  stateDir: string,
  bootUsers: PairingOwnerSources['users'],
  configuredOwnerUid: unknown,
): string {
  let configured: unknown;
  try {
    configured = JSON.parse(fs.readFileSync(path.join(stateDir, 'config.json'), 'utf-8'))?.threadline?.ownerName;
  } catch { /* @silent-fallback-ok — the other sources may still name the owner; a blank refuses pairing out loud */ }
  let stored: PairingOwnerSources['users'] = [];
  try {
    stored = UserManager.readProfilesFromDisk(stateDir).profiles;
  } catch { /* @silent-fallback-ok — same: a blank refuses pairing out loud */ }
  const operators = new TopicOperatorStore(path.join(stateDir, 'state'));
  return resolvePairingOwnerName({
    configured,
    users: [...(stored ?? []), ...(bootUsers ?? [])],
    configuredOwnerUid,
    operatorBindings: Object.values(operators.allBindings()),
    everVerifiedUids: operators.everVerifiedOperatorUids(),
  });
}
