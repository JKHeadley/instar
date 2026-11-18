/**
 * Regression: v1.3.1720 crash-looped at boot when config.users held a legacy
 * entry ({ name, role, slackUserId }) with no id/channels/permissions, even
 * though .instar/users.json already held the full record. The initialUsers
 * merge called upsertUser → validateProfile, which threw
 * "UserProfile.id must be a non-empty string" out of the constructor.
 *
 * Scope is deliberately narrow: only id-less initialUsers entries are skipped
 * (with a diagnostic). Other merge failures keep their existing behaviour.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { UserManager } from '../../src/users/UserManager.js';
import type { UserProfile } from '../../src/core/types.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('UserManager — legacy id-less config.users entry', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'user-legacy-idless-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/user-manager-legacy-idless-config-user.test.ts:afterEach' });
  });

  const persisted: UserProfile = {
    id: 'justin',
    name: 'Justin',
    channels: [{ type: 'slack', identifier: 'U0123456' }],
    permissions: ['admin'],
    preferences: {},
  };

  const legacyEntry = { name: 'Justin', role: 'admin', slackUserId: 'U0123456' } as unknown as UserProfile;

  it('does not throw at construction and keeps the persisted profile intact when a config user has no id', () => {
    fs.writeFileSync(path.join(tmpDir, 'users.json'), JSON.stringify([persisted], null, 2));
    const before = fs.readFileSync(path.join(tmpDir, 'users.json'), 'utf-8');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    let mgr: UserManager | undefined;
    expect(() => { mgr = new UserManager(tmpDir, [legacyEntry]); }).not.toThrow();

    expect(mgr!.listUsers()).toHaveLength(1);
    expect(mgr!.getUser('justin')).toEqual(persisted);
    expect(fs.readFileSync(path.join(tmpDir, 'users.json'), 'utf-8')).toBe(before);
    // Actionable diagnostic naming the entry and the missing field
    const messages = warn.mock.calls.map(c => String(c[0]));
    expect(messages.some(m => m.includes('config.users') && m.includes('"id"') && m.includes('Justin'))).toBe(true);
  });

  it('still throws for a non-fixture initialUsers failure on an entry with a valid id (unchanged behaviour)', () => {
    const alice: UserProfile = { id: 'alice', name: 'Alice', channels: [{ type: 'telegram', identifier: '1' }], permissions: [], preferences: {} };
    const mallory: UserProfile = { id: 'mallory', name: 'Mallory', channels: [{ type: 'telegram', identifier: '1' }], permissions: [], preferences: {} };
    expect(() => new UserManager(tmpDir, [alice, mallory])).toThrow(/already registered to user alice/);
  });
});
