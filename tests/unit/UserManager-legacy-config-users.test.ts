import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { UserManager } from '../../src/users/UserManager.js';
import type { UserProfile } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

/**
 * Regression: v1.3.1720 crash-looped at boot when config.users held a legacy entry
 * ({ name, role, slackUserId } — no id/channels/permissions). The initialUsers merge
 * threw out of the UserManager constructor (via skillLearningEnv) before port bind.
 */
describe('UserManager legacy config.users entries', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-user-legacy-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/UserManager-legacy-config-users.test.ts' });
  });

  it('skips a legacy config.users entry without id instead of throwing at construction', () => {
    const existing: UserProfile = {
      id: 'justin',
      name: 'Justin',
      channels: [{ type: 'slack', identifier: 'U123' }],
      permissions: ['admin'],
      preferences: {},
    };
    fs.writeFileSync(path.join(tmpDir, 'users.json'), JSON.stringify([existing]));
    const legacy = { name: 'Justin', role: 'admin', slackUserId: 'U123' } as unknown as UserProfile;
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    let manager: UserManager | undefined;
    expect(() => { manager = new UserManager(tmpDir, [legacy]); }).not.toThrow();

    // The persisted record survives; no identity was invented for the legacy entry.
    expect(manager!.listUsers().map(u => u.id)).toEqual(['justin']);
    // The skip is surfaced as a recoverable diagnostic.
    expect(errSpy.mock.calls.some(c => String(c[0]).includes('config.users'))).toBe(true);
    // Validation is not weakened: a direct write of the same entry is still refused.
    expect(() => manager!.upsertUser(legacy)).toThrow(/id must be a non-empty string/);
  });
});
