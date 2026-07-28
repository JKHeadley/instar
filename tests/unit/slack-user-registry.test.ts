import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  SlackUserRegistry,
  type RegistryUserStore,
  type RegistryUserProfile,
} from '../../src/permissions/SlackUserRegistry.js';

/** In-memory user store standing in for UserManager. */
function fakeStore(): RegistryUserStore & { profiles: Map<string, RegistryUserProfile> } {
  const profiles = new Map<string, RegistryUserProfile>();
  return {
    profiles,
    resolveFromSlackUserId(slackUserId: string) {
      for (const p of profiles.values()) if (p.slackUserId === slackUserId) return { id: p.id };
      return null;
    },
    upsertUser(profile: RegistryUserProfile) {
      profiles.set(profile.id, profile);
    },
  };
}

describe('SlackUserRegistry', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-reg-'));
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/unit/slack-user-registry.test.ts' });
  });

  it('admin register creates a profile with the role and slackUserId', () => {
    const store = fakeStore();
    const reg = new SlackUserRegistry(store, tmp);
    const p = reg.register('U_SARAH', 'Sarah', 'contributor');
    expect(p.slackUserId).toBe('U_SARAH');
    expect(p.orgRole).toBe('contributor');
    expect(p.permissions).toContain('contributor');
    expect(store.resolveFromSlackUserId('U_SARAH')).not.toBeNull();
    expect(reg.isRegistered('U_SARAH')).toBe(true);
  });

  it('rejects an invalid role', () => {
    const reg = new SlackUserRegistry(fakeStore(), tmp);
    expect(() => reg.register('U_X', 'X', 'superadmin')).toThrow(/invalid role/);
  });

  it('self-registration request creates a durable pending entry', () => {
    const reg = new SlackUserRegistry(fakeStore(), tmp);
    const entry = reg.requestRegistration('U_OMAR', 'Omar', 'C1');
    expect(entry?.slackUserId).toBe('U_OMAR');
    expect(reg.listPending()).toHaveLength(1);
    // durable: a fresh instance over the same stateDir sees it
    const reg2 = new SlackUserRegistry(fakeStore(), tmp);
    expect(reg2.listPending()).toHaveLength(1);
  });

  it('does not duplicate a pending request, and returns null if already registered', () => {
    const store = fakeStore();
    const reg = new SlackUserRegistry(store, tmp);
    reg.requestRegistration('U_OMAR', 'Omar');
    reg.requestRegistration('U_OMAR', 'Omar again');
    expect(reg.listPending()).toHaveLength(1);
    reg.register('U_BOSS', 'Boss', 'admin');
    expect(reg.requestRegistration('U_BOSS', 'Boss')).toBeNull();
  });

  it('approve creates the profile (using the pending display name) and clears the pending entry', () => {
    const store = fakeStore();
    const reg = new SlackUserRegistry(store, tmp);
    reg.requestRegistration('U_MAYA', 'Maya', 'C1');
    const p = reg.approve('U_MAYA', 'member');
    expect(p.name).toBe('Maya');
    expect(p.orgRole).toBe('member');
    expect(reg.isRegistered('U_MAYA')).toBe(true);
    expect(reg.listPending()).toHaveLength(0);
  });

  it('deny removes a pending entry (true), or returns false if none', () => {
    const reg = new SlackUserRegistry(fakeStore(), tmp);
    reg.requestRegistration('U_GHOST', 'Ghost');
    expect(reg.deny('U_GHOST')).toBe(true);
    expect(reg.listPending()).toHaveLength(0);
    expect(reg.deny('U_NOPE')).toBe(false);
  });

  it('a direct admin register clears any prior pending request for that user', () => {
    const reg = new SlackUserRegistry(fakeStore(), tmp);
    reg.requestRegistration('U_LATE', 'Late');
    expect(reg.listPending()).toHaveLength(1);
    reg.register('U_LATE', 'Late', 'operator');
    expect(reg.listPending()).toHaveLength(0);
  });
});
