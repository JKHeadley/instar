/**
 * SlackUserRegistry — conversational registration + role assignment (Phase 1).
 *
 * Slice 0 made the gate enforce roles; this makes registration first-class:
 *   - admin registers a Slack user with a role ("register Sarah as a developer")
 *   - an unregistered user's request becomes a PENDING registration → admin approval
 *   - approve/deny resolves it (approve creates the UserProfile with the role)
 *
 * All conversational — never a CLI, never asking the user to edit files. Pending
 * registrations are durable so an approval survives restarts. Decoupled from core:
 * depends only on a minimal user-store interface (UserManager satisfies it).
 *
 * Design: docs/specs/SLACK-ORG-INTEGRATION-SPEC.md §6.3.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { OrgRole } from './types.js';
import { ORG_ROLES } from './types.js';

/** Minimal UserProfile shape the registry creates/updates (UserManager.UserProfile satisfies it). */
export interface RegistryUserProfile {
  id: string;
  name: string;
  channels: Array<{ type: string; identifier: string }>;
  permissions: string[];
  preferences: Record<string, unknown>;
  slackUserId?: string;
  orgRole?: string;
  createdAt?: string;
}

export interface RegistryUserStore {
  resolveFromSlackUserId(slackUserId: string): { id: string } | null;
  upsertUser(profile: RegistryUserProfile): void;
}

export interface PendingRegistration {
  slackUserId: string;
  displayName: string;
  requestedAt: string;
  channel?: string;
}

function isValidRole(role: string): role is OrgRole {
  return (ORG_ROLES as readonly string[]).includes(role);
}

/** Build a fresh UserProfile for a newly-registered Slack user. */
function buildProfile(slackUserId: string, displayName: string, role: OrgRole, now: string): RegistryUserProfile {
  return {
    id: `slack-${slackUserId}`,
    name: displayName || slackUserId,
    channels: [{ type: 'slack', identifier: slackUserId }],
    permissions: [role],
    preferences: {},
    slackUserId,
    orgRole: role,
    createdAt: now,
  };
}

export class SlackUserRegistry {
  private readonly pendingFile: string;

  constructor(
    private readonly users: RegistryUserStore,
    stateDir: string,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    /* state-registry: slack-pending-registrations */
    this.pendingFile = path.join(stateDir, 'slack-pending-registrations.json');
  }

  /** Admin-initiated registration: create/assign the role immediately. Throws on invalid role. */
  register(slackUserId: string, displayName: string, role: string): RegistryUserProfile {
    if (!slackUserId) throw new Error('slackUserId is required');
    if (!isValidRole(role)) throw new Error(`invalid role "${role}" (expected one of: ${ORG_ROLES.join(', ')})`);
    const profile = buildProfile(slackUserId, displayName, role, this.now());
    this.users.upsertUser(profile);
    this.removePending(slackUserId); // a direct registration clears any pending request
    return profile;
  }

  /** True iff this Slack user is already registered. */
  isRegistered(slackUserId: string): boolean {
    return !!this.users.resolveFromSlackUserId(slackUserId);
  }

  /**
   * Self-registration request from an unregistered user → durable PENDING entry for
   * admin approval. No-op (returns existing) if already pending; null if already registered.
   */
  requestRegistration(slackUserId: string, displayName: string, channel?: string): PendingRegistration | null {
    if (this.isRegistered(slackUserId)) return null;
    const pending = this.readPending();
    const existing = pending.find((p) => p.slackUserId === slackUserId);
    if (existing) return existing;
    const entry: PendingRegistration = { slackUserId, displayName, requestedAt: this.now(), channel };
    pending.push(entry);
    this.writePending(pending);
    return entry;
  }

  listPending(): PendingRegistration[] {
    return this.readPending();
  }

  /** Approve a pending registration with a role → creates the UserProfile, clears the pending entry. */
  approve(slackUserId: string, role: string): RegistryUserProfile {
    if (!isValidRole(role)) throw new Error(`invalid role "${role}" (expected one of: ${ORG_ROLES.join(', ')})`);
    const pending = this.readPending();
    const entry = pending.find((p) => p.slackUserId === slackUserId);
    const displayName = entry?.displayName || slackUserId;
    const profile = this.register(slackUserId, displayName, role);
    return profile;
  }

  /** Deny (drop) a pending registration. Returns true if one was removed. */
  deny(slackUserId: string): boolean {
    return this.removePending(slackUserId);
  }

  // ── pending-store persistence (durable JSON) ──
  private readPending(): PendingRegistration[] {
    try {
      return JSON.parse(fs.readFileSync(this.pendingFile, 'utf8')) as PendingRegistration[];
    } catch {
      return [];
    }
  }

  private writePending(entries: PendingRegistration[]): void {
    fs.mkdirSync(path.dirname(this.pendingFile), { recursive: true });
    fs.writeFileSync(this.pendingFile, JSON.stringify(entries, null, 2) + '\n');
  }

  private removePending(slackUserId: string): boolean {
    const pending = this.readPending();
    const next = pending.filter((p) => p.slackUserId !== slackUserId);
    if (next.length === pending.length) return false;
    this.writePending(next);
    return true;
  }
}
