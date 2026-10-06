/**
 * ACT-1302: an identity file copied from another machine (with or without its
 * key files) is set aside, never deleted, so `instar join` can mint this
 * machine's own identity.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setAsideCopiedIdentity } from '../../src/commands/machine.js';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('setAsideCopiedIdentity', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'join-copied-')); });
  afterEach(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/join-copied-identity.test.ts:afterEach' }));

  it('also moves legacy-named key files, so another machine\'s private key is not left live here', async () => {
    const mgr = new MachineIdentityManager(dir);
    await mgr.generateIdentity({ name: 'laptop' });
    const legacy = path.join(path.dirname(mgr.identityPath), 'signing-private.pem');
    fs.renameSync(mgr.signingKeyPath, legacy);
    const moved = setAsideCopiedIdentity(mgr, 'test');
    expect(fs.existsSync(legacy)).toBe(false);
    expect(moved.some((f) => f.includes('signing-private.pem.copied-'))).toBe(true);
  });

  it('moves the copied identity aside and lets a fresh identity with a different id be minted', async () => {
    const original = new MachineIdentityManager(dir);
    const inviter = await original.generateIdentity({ name: 'laptop' });
    // Simulate a copy that arrived without the private key.
    fs.renameSync(original.signingKeyPath, `${original.signingKeyPath}.elsewhere`);

    const mgr = new MachineIdentityManager(dir);
    const moved = setAsideCopiedIdentity(mgr, 'test');
    expect(mgr.hasIdentity()).toBe(false);
    expect(moved.some((f) => f.includes('identity.json.copied-'))).toBe(true);
    for (const f of moved) expect(fs.existsSync(f)).toBe(true);

    const fresh = await mgr.generateIdentity({ name: 'studio', role: 'standby', force: true });
    expect(fresh.machineId).not.toBe(inviter.machineId);
    expect(mgr.loadSigningKey().length).toBeGreaterThan(0);
  });
});
