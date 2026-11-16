/**
 * Regression: v1.3.1720 crash-looped at boot when config.users held a legacy
 * entry {name, role, slackUserId} with no id/channels/permissions, even though
 * users.json already held the complete record. The initialUsers merge must
 * never throw out of the UserManager constructor (a constructor throw fails
 * server startup), and it must not weaken or alter the persisted record.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { UserManager } from '../../src/users/UserManager.js';
import type { UserProfile } from '../../src/core/types.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('UserManager — legacy config.users entries at boot', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'user-legacy-'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/user-manager-legacy-config-users.test.ts' });
  });

  const persisted: UserProfile = {
    id: 'justin',
    name: 'Justin',
    slackUserId: 'U0123ABC',
    channels: [{ type: 'slack', identifier: 'U0123ABC' }],
    permissions: ['admin'],
    preferences: {},
    createdAt: '2026-01-01T00:00:00.000Z',
  };

  const legacyEntry = { name: 'Justin', role: 'admin', slackUserId: 'U0123ABC' } as unknown as UserProfile;

  it('boots without throwing when a legacy config.users entry lacks id and users.json holds the full record', () => {
    fs.writeFileSync(path.join(tmpDir, 'users.json'), JSON.stringify([persisted], null, 2));
    const before = fs.readFileSync(path.join(tmpDir, 'users.json'), 'utf-8');

    let mgr: UserManager | null = null;
    expect(() => { mgr = new UserManager(tmpDir, [legacyEntry]); }).not.toThrow();

    // The persisted record survives untouched — no weakening, no garbage row.
    expect(mgr!.listUsers()).toHaveLength(1);
    expect(mgr!.getUser('justin')?.permissions).toEqual(['admin']);
    expect(mgr!.resolveFromSlackUserId('U0123ABC')?.id).toBe('justin');
    expect(fs.readFileSync(path.join(tmpDir, 'users.json'), 'utf-8')).toBe(before);
  });

  it('does not throw or invent a user from a malformed config entry when no users.json exists', () => {
    let mgr: UserManager | null = null;
    expect(() => { mgr = new UserManager(tmpDir, [legacyEntry]); }).not.toThrow();
    expect(mgr!.listUsers()).toHaveLength(0);
  });

  it('still merges well-formed config entries alongside a skipped legacy entry', () => {
    const bob: UserProfile = {
      id: 'bob', name: 'Bob', channels: [], permissions: ['user'], preferences: {},
    } as UserProfile;
    let mgr: UserManager | null = null;
    expect(() => { mgr = new UserManager(tmpDir, [legacyEntry, bob]); }).not.toThrow();
    expect(mgr!.getUser('bob')?.permissions).toEqual(['user']);
  });
});
