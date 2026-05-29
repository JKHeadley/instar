/**
 * Tier-1 tests for MachineIdentityManager nickname methods (Multi-Machine
 * Session Pool §L2): auto-assign on register (idempotent), updateNickname
 * (validation + pool-uniqueness), resolveNickname (case-insensitive, active-only).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';
import type { MachineIdentity } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'instar-nick-test-'));
}
function cleanup(dir: string): void {
  SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/machine-nickname.test.ts' });
}
function identity(machineId: string, name: string, platform = 'darwin-arm64'): MachineIdentity {
  return {
    machineId,
    signingPublicKey: 'sk',
    encryptionPublicKey: 'ek',
    name,
    platform,
    createdAt: new Date().toISOString(),
    capabilities: ['sessions'],
  };
}

describe('MachineIdentityManager nicknames (§L2)', () => {
  let dir: string;
  let mgr: MachineIdentityManager;
  beforeEach(() => {
    dir = tmp();
    mgr = new MachineIdentityManager(path.join(dir, '.instar'));
  });
  afterEach(() => cleanup(dir));

  it('auto-assigns a friendly nickname on register', () => {
    mgr.registerMachine(identity('m_a', 'justins-macbook-pro'), 'awake');
    const entry = mgr.loadRegistry().machines['m_a'];
    expect(entry.nickname).toBe('Justins Macbook Pro');
  });

  it('auto-assign is idempotent — a re-register keeps the existing nickname', () => {
    mgr.registerMachine(identity('m_a', 'mac-mini'), 'standby');
    mgr.updateNickname('m_a', 'My Mini');
    mgr.registerMachine(identity('m_a', 'mac-mini'), 'awake'); // re-register (e.g. role change)
    expect(mgr.loadRegistry().machines['m_a'].nickname).toBe('My Mini'); // not clobbered
    expect(mgr.loadRegistry().machines['m_a'].role).toBe('awake'); // other fields still update
  });

  it('disambiguates a second machine with the same derived nickname', () => {
    mgr.registerMachine(identity('m_a', 'mac-mini'), 'awake');
    mgr.registerMachine(identity('m_b', 'mac-mini'), 'standby');
    expect(mgr.loadRegistry().machines['m_a'].nickname).toBe('Mac Mini');
    expect(mgr.loadRegistry().machines['m_b'].nickname).toBe('Mac Mini 2');
  });

  it('updateNickname sets a valid nickname and updates lastSeen', () => {
    mgr.registerMachine(identity('m_a', 'laptop'), 'awake');
    mgr.updateNickname('m_a', '  Work Laptop  ');
    expect(mgr.loadRegistry().machines['m_a'].nickname).toBe('Work Laptop'); // trimmed
  });

  it('updateNickname rejects a malformed nickname', () => {
    mgr.registerMachine(identity('m_a', 'laptop'), 'awake');
    expect(() => mgr.updateNickname('m_a', 'bad/slash')).toThrow(/Invalid nickname/);
    expect(() => mgr.updateNickname('m_a', '')).toThrow(/Invalid nickname/);
  });

  it('updateNickname rejects a collision with another machine (case-insensitive)', () => {
    mgr.registerMachine(identity('m_a', 'mac-mini'), 'awake'); // → "Mac Mini"
    mgr.registerMachine(identity('m_b', 'laptop'), 'standby');
    expect(() => mgr.updateNickname('m_b', 'mac mini')).toThrow(/already used by machine m_a/);
  });

  it('updateNickname throws for an unknown machine', () => {
    expect(() => mgr.updateNickname('m_missing', 'X')).toThrow(/not found/);
  });

  it('resolveNickname maps a nickname → machineId (case-insensitive, active-only)', () => {
    mgr.registerMachine(identity('m_a', 'mac-mini'), 'awake');
    mgr.registerMachine(identity('m_b', 'laptop'), 'standby');
    expect(mgr.resolveNickname('Mac Mini')).toBe('m_a');
    expect(mgr.resolveNickname('  mac mini ')).toBe('m_a'); // trimmed + case-insensitive
    expect(mgr.resolveNickname('laptop')).toBe('m_b');
    expect(mgr.resolveNickname('nonexistent')).toBeNull();
    expect(mgr.resolveNickname('')).toBeNull();
  });

  it('resolveNickname ignores revoked machines', () => {
    mgr.registerMachine(identity('m_a', 'mac-mini'), 'awake');
    mgr.revokeMachine('m_a', 'm_b', 'test');
    expect(mgr.resolveNickname('Mac Mini')).toBeNull();
  });

  it('recordSelfHardware stores hardware on the entry; idempotent when unchanged; no-op for unknown id', () => {
    mgr.registerMachine(identity('m_a', 'mac-mini'), 'awake');
    const hw = { platform: 'darwin', arch: 'arm64', cpuModel: 'Apple M2', cpuCores: 8, totalMemBytes: 17179869184, hostname: 'mini', instarVersion: '1.3.75' };
    expect(mgr.recordSelfHardware('m_a', hw)).toBe(true); // wrote
    expect(mgr.loadRegistry().machines['m_a'].hardware).toEqual(hw);
    expect(mgr.recordSelfHardware('m_a', hw)).toBe(false); // unchanged → no write (no churn/sync)
    expect(mgr.recordSelfHardware('m_unknown', hw)).toBe(false); // unknown id → no-op
  });
});
