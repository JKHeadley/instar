/**
 * User Manager — multi-user identity resolution.
 *
 * Maps incoming messages to known users based on their channels.
 * Same agent, same repo, different relationship per user.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { UserProfile, UserChannel, Message } from '../core/types.js';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';
import {
  matchTestIdentity,
  testIdentitiesAllowed,
  verifyAllowTestIdentity,
  TestIdentityRefusedError,
} from './testIdentityMarkers.js';
import { setRegistryHighWater } from '../core/registryHighWater.js';

/**
 * WS2.6 user-record replication emit seam (injected, dark by default). server.ts late-binds a
 * journal-backed emitter ONLY when `multiMachine.stateSync.userRegistry.enabled` is true; absent
 * ⇒ strict no-op (single-machine, byte-identical). The emitter NEVER throws into the manager
 * (it swallows + counts internally), so the manager calls it best-effort.
 *
 * CRITICAL: emitDelete MUST fire for every user REMOVED (the removeUser() path) — else a peer
 * re-replicates the locally-removed user forever (resurrection). The emitter keys the tombstone
 * on the SAME channel-set recordKey the put used, so the delete reaches the same human on every
 * machine even though the local ids differ. emitPut carries the disclosure-minimized projection
 * only — never the local `userId`.
 */
export interface UserReplicationEmitter {
  /** Emit a `put` for a persisted user profile (called from the persist funnel). */
  emitPut(record: UserProfile): void;
  /** Emit a `delete` tombstone for a removed user, keyed on their channel set. */
  emitDelete(channels: UserChannel[], deletedAt: string): void;
}

export class UserManager {
  private users: Map<string, UserProfile> = new Map();
  private channelIndex: Map<string, string> = new Map(); // "type:identifier" -> userId
  private usersFile: string;
  private readonly stateDir: string;
  /**
   * silent-loss-refusal-conservation §2.D — the server-held HMAC key that
   * verifies a signed `allowTestIdentity` marker on a legitimate fixture-collision
   * profile. Loaded only by the server process (NOT authToken/dashboardPin).
   * Absent (CLI / read-only probe / tests) → a fixture-collision profile is
   * refused (write) / skipped (load) unless the double-keyed test escape is on —
   * a marker can be neither minted nor verified without the key (safe direction).
   */
  private readonly testIdentityKey: string | undefined;
  /** WS2.6 user-record replication emitter (injected, dark by default). Absent ⇒ strict no-op. */
  private userReplication: UserReplicationEmitter | null = null;

  constructor(stateDir: string, initialUsers?: UserProfile[], opts?: { testIdentityKey?: string }) {
    this.usersFile = path.join(stateDir, 'users.json');
    this.stateDir = stateDir;
    this.testIdentityKey = opts?.testIdentityKey;
    this.loadUsers(initialUsers);
  }

  /**
   * silent-loss-refusal-conservation §2.D — is a fixture-identity write/load
   * PERMITTED for this profile? A match is permitted only when (a) the
   * double-keyed test escape is active (env + on-disk test-home marker) OR (b) the
   * profile carries a signed `allowTestIdentity` marker that VERIFIES under the
   * server key (a legitimate name-collision, dashboard-PIN-minted). Returns the
   * matched marker string when the write/load must be REFUSED, or null when it is
   * permitted (either no match, or an accepted override). */
  private refusedTestIdentity(profile: Pick<UserProfile, 'id' | 'slackUserId' | 'channels' | 'allowTestIdentity'>): string | null {
    const marker = matchTestIdentity(profile);
    if (!marker) return null;
    if (testIdentitiesAllowed(this.stateDir)) return null;
    if (verifyAllowTestIdentity(this.testIdentityKey, profile.id, marker, profile.allowTestIdentity)) return null;
    return marker;
  }

  /**
   * Late-bind the WS2.6 user-record replication emitter (server.ts constructs the journal/clock
   * AFTER the manager). Idempotent; passing undefined/null detaches (back to single-machine
   * no-op). The emit funnel checks `this.userReplication` per write, so attaching mid-life takes
   * effect on the next upsert/remove.
   */
  setUserReplicationEmitter(emitter: UserReplicationEmitter | null | undefined): void {
    this.userReplication = emitter ?? null;
  }

  /**
   * Resolve a user from an incoming message.
   * Returns the user profile if the sender is recognized.
   */
  resolveFromMessage(message: Message): UserProfile | null {
    return this.resolveFromChannel(message.channel);
  }

  /**
   * Resolve a user from a channel identifier.
   */
  resolveFromChannel(channel: UserChannel): UserProfile | null {
    const key = `${channel.type}:${channel.identifier}`;
    const userId = this.channelIndex.get(key);
    if (!userId) return null;
    return this.users.get(userId) || null;
  }

  /**
   * Resolve a user by their Telegram numeric user ID.
   * Scans all profiles for matching telegramUserId field.
   *
   * This is the primary resolution path for incoming Telegram messages,
   * since telegramUserId is stored as a direct field on UserProfile
   * (not a channel — channels use topic IDs).
   */
  resolveFromTelegramUserId(telegramUserId: number): UserProfile | null {
    if (!telegramUserId) return null;
    for (const user of this.users.values()) {
      if (user.telegramUserId === telegramUserId) return user;
    }
    return null;
  }

  /**
   * Resolve a user profile from a verified Slack user ID (U…).
   *
   * The authenticated Slack user ID is the basis of Slack identity (Know Your
   * Principal) — never a name in message content. Prefers the direct
   * `slackUserId` field, falling back to a `slack`-typed channel identifier for
   * profiles registered before the field existed.
   */
  resolveFromSlackUserId(slackUserId: string): UserProfile | null {
    if (!slackUserId) return null;
    for (const user of this.users.values()) {
      if (user.slackUserId === slackUserId) return user;
    }
    for (const user of this.users.values()) {
      if (user.channels?.some((c) => c.type === 'slack' && c.identifier === slackUserId)) return user;
    }
    return null;
  }

  /**
   * Get a user by ID.
   */
  getUser(userId: string): UserProfile | null {
    return this.users.get(userId) || null;
  }

  /**
   * List all registered users.
   */
  listUsers(): UserProfile[] {
    return Array.from(this.users.values());
  }

  /**
   * Add or update a user.
   */
  upsertUser(profile: UserProfile): void {
    this.validateProfile(profile);

    // Remove old channel index entries
    const existing = this.users.get(profile.id);
    if (existing) {
      for (const channel of existing.channels) {
        this.channelIndex.delete(`${channel.type}:${channel.identifier}`);
      }
    }

    // Check for channel collisions — prevent silent ownership transfer
    for (const channel of profile.channels) {
      const key = `${channel.type}:${channel.identifier}`;
      const existingOwner = this.channelIndex.get(key);
      if (existingOwner && existingOwner !== profile.id) {
        throw new Error(`Channel ${key} is already registered to user ${existingOwner}; cannot assign to ${profile.id}`);
      }
    }

    // Add new entries
    this.users.set(profile.id, profile);
    for (const channel of profile.channels) {
      this.channelIndex.set(`${channel.type}:${channel.identifier}`, profile.id);
    }

    this.persistUsers();

    // silent-loss-refusal-conservation §2.D set-point: a successful register/upsert
    // of a (validated non-fixture) user means the authoritative local registry now
    // holds a real user — set the monotonic high-water marker so a later emptying
    // classifies POPULATED (emptied-by-deletion), not never-populated.
    try { setRegistryHighWater(this.stateDir, 'user-registered'); } catch { /* best-effort */ }
  }

  /**
   * Remove a user.
   */
  removeUser(userId: string): boolean {
    const user = this.users.get(userId);
    if (!user) return false;

    // WS2.6 — capture the channel set BEFORE deletion so the tombstone keys on the same
    // channel-set recordKey the put used (resurrection guard). Best-effort: a replication emit
    // fault must never break or roll back the local removal.
    const removedChannels = user.channels.slice();

    for (const channel of user.channels) {
      this.channelIndex.delete(`${channel.type}:${channel.identifier}`);
    }
    this.users.delete(userId);
    this.persistUsers();

    const emitter = this.userReplication;
    if (emitter) {
      try {
        emitter.emitDelete(removedChannels, new Date().toISOString());
      } catch {
        // @silent-fallback-ok: a replication emit fault must never break a local user removal —
        // the durable on-disk state is already persisted above. The emitter counts its own
        // failures internally; this guard only ensures a throw from the seam cannot propagate.
      }
    }
    return true;
  }

  /**
   * Check if a user has a specific permission.
   */
  hasPermission(userId: string, permission: string): boolean {
    const user = this.users.get(userId);
    if (!user) return false;
    return user.permissions.includes(permission) || user.permissions.includes('admin');
  }

  /**
   * Add a user interactively (with defaults applied).
   * Returns the full profile.
   */
  addUserInteractive(partialProfile: Partial<UserProfile> & { id: string; name: string }): UserProfile {
    const profile: UserProfile = {
      channels: [],
      permissions: ['user'],
      preferences: {},
      createdAt: new Date().toISOString(),
      ...partialProfile,
    };
    this.upsertUser(profile);
    return profile;
  }

  /**
   * List users formatted for wizard display.
   * Returns name + id pairs suitable for selection prompts.
   */
  listUsersForSelection(): Array<{ name: string; value: string; description: string }> {
    return this.listUsers().map(user => ({
      name: user.name,
      value: user.id,
      description: `${user.permissions.includes('admin') ? 'Admin' : 'User'} — ${user.channels.map(c => c.type).join(', ') || 'no channels'}`,
    }));
  }

  /**
   * Find admin users.
   */
  getAdmins(): UserProfile[] {
    return this.listUsers().filter(u => u.permissions.includes('admin'));
  }

  private validateProfile(profile: UserProfile): void {
    if (!profile.id || typeof profile.id !== 'string' || !profile.id.trim()) {
      throw new Error('UserProfile.id must be a non-empty string');
    }
    if (!Array.isArray(profile.channels)) {
      throw new Error(`UserProfile(${profile.id}).channels must be an array`);
    }
    if (!Array.isArray(profile.permissions)) {
      throw new Error(`UserProfile(${profile.id}).permissions must be an array`);
    }
    // silent-loss-refusal-conservation §2.D — fixture refusal at the WRITE path
    // (API/CLI/registration). "Test Identity Never Enters Production State": a
    // typed throw so a fixture id can never be persisted into the production
    // registry (the 2026-07-01 clobber's write side). A legitimate name-collision
    // supplies a dashboard-PIN-minted signed `allowTestIdentity`; an isolated test
    // home sets the double-keyed escape.
    const refused = this.refusedTestIdentity(profile);
    if (refused) {
      throw new TestIdentityRefusedError(profile.id, refused);
    }
  }

  private loadUsers(initialUsers?: UserProfile[]): void {
    // Load from file if exists
    if (fs.existsSync(this.usersFile)) {
      try {
        const data: UserProfile[] = JSON.parse(fs.readFileSync(this.usersFile, 'utf-8'));
        for (const user of data) {
          // Skip malformed entries
          if (!user.id || !Array.isArray(user.channels) || !Array.isArray(user.permissions)) {
            console.warn(`[UserManager] Skipping malformed user entry: ${JSON.stringify(user).slice(0, 100)}`);
            continue;
          }
          // silent-loss-refusal-conservation §2.D — fixture refusal at the LOAD
          // path. Refuse-and-skip-with-loud-alert (NEVER throw — a constructor
          // throw fails boot). A fixture row that slipped into an already-polluted
          // store is dropped from the in-memory registry so it can never resolve
          // as a real sender; the §4 boot migration quarantines it off disk.
          const refused = this.refusedTestIdentity(user);
          if (refused) {
            console.error(
              `[UserManager] REFUSING to load fixture/test identity "${user.id}" (matched marker "${refused}") from the user registry ` +
              `— "Test Identity Never Enters Production State" (silent-loss-refusal-conservation §2.D). ` +
              `The row is skipped in-memory; the boot migration quarantines it off disk. ` +
              `If this is a legitimate user, register them via the dashboard-PIN-authed allow-identity override.`,
            );
            continue;
          }
          this.users.set(user.id, user);
          for (const channel of user.channels) {
            if (channel.type && channel.identifier) {
              this.channelIndex.set(`${channel.type}:${channel.identifier}`, user.id);
            }
          }
        }
      } catch (err) {
        // Back up corrupted file instead of silently dropping all users
        const backupPath = this.usersFile + '.corrupt.' + Date.now();
        try { fs.copyFileSync(this.usersFile, backupPath); } catch { /* best effort */ }
        console.error(`[UserManager] Corrupted users file backed up to ${backupPath}: ${err}`);
      }
    }

    // Merge initial users (config takes precedence for initial setup)
    if (initialUsers) {
      for (const user of initialUsers) {
        if (!this.users.has(user.id)) {
          // upsertUser → validateProfile refuses a fixture initialUsers entry
          // (typed throw). Guard so a fixture in config.users can't fail boot;
          // a real initialUsers merge below sets the high-water marker.
          try {
            this.upsertUser(user);
          } catch (err) {
            if (err instanceof TestIdentityRefusedError) {
              console.error(`[UserManager] Skipped fixture identity from initialUsers: ${err.message}`);
              continue;
            }
            throw err;
          }
        }
      }
    }

    // silent-loss-refusal-conservation §2.D set-point: if the authoritative local
    // registry holds ≥1 resolvable real user, this machine has "held a real user"
    // — set the monotonic high-water marker so a LATER emptying classifies as
    // POPULATED (emptied-by-deletion → keep rejecting), not never-populated.
    if (this.users.size > 0) {
      try { setRegistryHighWater(this.stateDir, 'load-observed-real-user'); } catch { /* best-effort */ }
    }
  }

  private persistUsers(): void {
    const dir = path.dirname(this.usersFile);
    fs.mkdirSync(dir, { recursive: true });
    // Atomic write: unique temp filename prevents concurrent corruption
    const tmpPath = `${this.usersFile}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(Array.from(this.users.values()), null, 2));
      fs.renameSync(tmpPath, this.usersFile);
    } catch (err) {
      try { SafeFsExecutor.safeUnlinkSync(tmpPath, { operation: 'src/users/UserManager.ts:220' }); } catch { /* ignore */ }
      throw err;
    }

    // WS2.6 — best-effort user-record replication emission (dark by default; the emitter is only
    // injected when multiMachine.stateSync.userRegistry.enabled is true). Re-emit a put for every
    // surviving user so a peer SEES the latest profile state (the upsert + removeUser paths both
    // route through here; a removed user is already gone from the map, so its put is NOT re-emitted
    // — its tombstone fires in removeUser). The emitter swallows its own errors, but we wrap
    // defensively so a replication fault can NEVER break a local user write.
    const emitter = this.userReplication;
    if (emitter) {
      for (const u of this.users.values()) {
        try {
          emitter.emitPut(u);
        } catch {
          // @silent-fallback-ok: a replication emit fault must never break the local write — the
          // durable on-disk state is already persisted above. The emitter counts its own failures.
        }
      }
    }
  }
}
