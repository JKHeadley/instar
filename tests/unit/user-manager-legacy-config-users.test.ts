import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { UserManager } from '../../src/users/UserManager.js';
import type { UserProfile } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('UserManager legacy config.users entries (boot crash-loop regression)', () => {
  let tmpDir: string;

  const persisted: UserProfile = {
    id: 'justin',
    name: 'Justin',
    channels: [{ type: 'slack', identifier: 'U0123ABC' }],
    permissions: ['admin'],
    preferences: {},
    slackUserId: 'U0123ABC',
  };

  // The legacy shape from the report: name, role, slackUserId — no id/channels/permissions.
  const legacyEntry = { name: 'Justin', role: 'admin', slackUserId: 'U0123ABC' } as unknown as UserProfile;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'um-legacy-'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/user-manager-legacy-config-users.test.ts' });
  });

  it('does not throw on a legacy config.users entry without id and keeps the persisted profile intact', () => {
    fs.writeFileSync(path.join(tmpDir, 'users.json'), JSON.stringify([persisted], null, 2));

    let manager: UserManager | undefined;
    expect(() => { manager = new UserManager(tmpDir, [legacyEntry]); }).not.toThrow();

    expect(manager!.listUsers()).toHaveLength(1);
    expect(manager!.getUser('justin')).toEqual(persisted);
    expect(manager!.resolveFromSlackUserId('U0123ABC')?.id).toBe('justin');
    const onDisk = JSON.parse(fs.readFileSync(path.join(tmpDir, 'users.json'), 'utf-8'));
    expect(onDisk).toEqual([persisted]);
  });

  it('skips an unmatched invalid config.users entry with an actionable diagnostic instead of throwing', () => {
    const errSpy = vi.mocked(console.error);
    const orphan = { name: 'Nobody', role: 'user' } as unknown as UserProfile;
    let manager: UserManager | undefined;
    expect(() => { manager = new UserManager(tmpDir, [orphan, persisted]); }).not.toThrow();
    expect(manager!.getUser('justin')).toEqual(persisted);
    expect(manager!.listUsers()).toHaveLength(1);
    const logged = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toMatch(/config\.users/);
    expect(logged).toMatch(/Nobody/);
  });
});
