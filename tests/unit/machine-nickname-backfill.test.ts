/**
 * Every machine carries a human name (operator report 2026-11-12: "bob · Machine m_4851af").
 * Covers: init/self-registration uses the computer's own name, the boot/migration backfill
 * (MachineIdentityManager.ensureNicknames + PostUpdateMigrator) is idempotent, and a name a
 * person chose is never overwritten.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { MachineIdentity, MachineRegistry } from '../../src/core/types.js';

const peer = (machineId: string, name: string): MachineIdentity => ({
  machineId, signingPublicKey: 'sk', encryptionPublicKey: 'ek', name, platform: 'linux-x64',
  createdAt: new Date().toISOString(), capabilities: ['sessions'],
});

describe('machine nickname backfill', () => {
  let dir: string;
  let stateDir: string;
  let friendly: string | null;
  const mgr = () => new MachineIdentityManager(stateDir, { detectFriendlyName: () => friendly });
  const registry = (): MachineRegistry => JSON.parse(fs.readFileSync(mgr().registryPath, 'utf8'));
  const write = (r: MachineRegistry) => fs.writeFileSync(mgr().registryPath, JSON.stringify(r, null, 2));
  const migrate = () => new PostUpdateMigrator({
    projectDir: dir, stateDir, port: 4042, hasTelegram: false, projectName: 'bob',
    detectFriendlyMachineName: () => friendly,
  } as ConstructorParameters<typeof PostUpdateMigrator>[0]);

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-nick-backfill-'));
    stateDir = path.join(dir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    friendly = "Justin's MacBook Pro";
  });
  afterEach(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/machine-nickname-backfill.test.ts' }));

  it('init names this machine after its own computer name, with no question', async () => {
    const id = await mgr().generateIdentity({ name: 'bob' });
    expect(registry().machines[id.machineId]).toMatchObject({ name: 'bob', nickname: "Justin's MacBook Pro", nicknameSource: 'auto-self' });
  });

  it('falls back to the identity name when the computer has no usable name', async () => {
    friendly = null;
    const id = await mgr().generateIdentity({ name: 'mac-studio' });
    expect(registry().machines[id.machineId].nickname).toBe('Mac Studio');
  });

  it('a peer registered at pairing is named from its hostname, then upgrades itself on its own boot', async () => {
    const self = await mgr().generateIdentity({ name: 'bob' });
    mgr().registerMachine(peer('m_peer000000000001', 'mama-pc'), 'standby');
    expect(registry().machines.m_peer000000000001).toMatchObject({ nickname: 'Mama Pc', nicknameSource: 'auto-derived' });
    // The peer's own machine runs the same backfill with itself as self: it upgrades the derived name.
    friendly = 'Mama PC';
    const named = mgr().ensureNicknames('m_peer000000000001');
    expect(named).toEqual(['m_peer000000000001']);
    expect(registry().machines.m_peer000000000001).toMatchObject({ nickname: 'Mama PC', nicknameSource: 'auto-self' });
    expect(registry().machines[self.machineId].nickname).toBe("Justin's MacBook Pro");
  });

  it('backfills an old registry entry with no nickname, and peers without one, without touching peer lastSeen', async () => {
    const self = await mgr().generateIdentity({ name: 'bob' });
    const r = registry();
    delete r.machines[self.machineId].nickname; delete r.machines[self.machineId].nicknameSource;
    r.machines.m_peer000000000002 = { name: 'old-laptop', status: 'active', role: 'standby', pairedAt: '2026-01-01T00:00:00.000Z', lastSeen: '2026-01-02T00:00:00.000Z' };
    write(r);
    const result = migrate().migrate();
    expect(result.errors.filter((e) => e.startsWith('machine nicknames'))).toEqual([]);
    expect(result.upgraded).toContain('machine nicknames: named 2 machine(s)');
    const after = registry();
    expect(after.machines[self.machineId]).toMatchObject({ nickname: "Justin's MacBook Pro", nicknameSource: 'auto-self' });
    expect(after.machines.m_peer000000000002).toMatchObject({ nickname: 'Old Laptop', nicknameSource: 'auto-derived', lastSeen: '2026-01-02T00:00:00.000Z' });
  });

  it('the migration is idempotent: a second run changes nothing', async () => {
    const self = await mgr().generateIdentity({ name: 'bob' });
    const r = registry(); delete r.machines[self.machineId].nickname; write(r);
    migrate().migrate();
    const once = fs.readFileSync(mgr().registryPath, 'utf8');
    const second = migrate().migrate();
    expect(second.skipped).toContain('machine nicknames (every machine already named)');
    expect(fs.readFileSync(mgr().registryPath, 'utf8')).toBe(once);
  });

  it('never overwrites a name a person set, or a legacy nickname of unknown origin', async () => {
    const self = await mgr().generateIdentity({ name: 'bob' });
    mgr().updateNickname(self.machineId, 'Kitchen Mac');
    expect(registry().machines[self.machineId].nicknameSource).toBe('user');
    mgr().registerMachine(peer('m_peer000000000003', 'studio'), 'standby');
    const r = registry(); r.machines.m_peer000000000003.nickname = 'The Big One'; delete r.machines.m_peer000000000003.nicknameSource; write(r);
    friendly = 'Something Else';
    expect(mgr().ensureNicknames()).toEqual([]);
    migrate().migrate();
    expect(registry().machines[self.machineId].nickname).toBe('Kitchen Mac');
    expect(registry().machines.m_peer000000000003.nickname).toBe('The Big One');
    // A legacy self entry with a nickname but no source is kept too.
    const r2 = registry(); r2.machines[self.machineId].nickname = 'Legacy Name'; delete r2.machines[self.machineId].nicknameSource; write(r2);
    expect(mgr().ensureNicknames()).toEqual([]);
    expect(registry().machines[self.machineId].nickname).toBe('Legacy Name');
  });

  it('upgrades a legacy nickname that is only the automatic derivation of the identity name (machine named after the agent)', async () => {
    const self = await mgr().generateIdentity({ name: 'groky' });
    const r = registry(); r.machines[self.machineId].nickname = 'Groky'; delete r.machines[self.machineId].nicknameSource; write(r);
    expect(mgr().ensureNicknames()).toEqual([self.machineId]);
    expect(registry().machines[self.machineId]).toMatchObject({ nickname: "Justin's MacBook Pro", nicknameSource: 'auto-self' });
    // With no friendly name available, the legacy name is kept rather than churned.
    const r2 = registry(); r2.machines[self.machineId].nickname = 'Groky'; delete r2.machines[self.machineId].nicknameSource; write(r2);
    friendly = null;
    expect(mgr().ensureNicknames()).toEqual([]);
    expect(registry().machines[self.machineId].nickname).toBe('Groky');
  });

  it('replaces an id-shaped nickname, and keeps a collision-free name in a pool', async () => {
    const self = await mgr().generateIdentity({ name: 'bob' });
    mgr().registerMachine(peer('m_peer000000000004', 'x'), 'standby');
    const r = registry();
    r.machines.m_peer000000000004.nickname = "Justin's MacBook Pro"; r.machines.m_peer000000000004.nicknameSource = 'user';
    r.machines[self.machineId].nickname = 'Machine 4851af00'; write(r);
    expect(mgr().ensureNicknames()).toEqual([self.machineId]);
    expect(registry().machines[self.machineId].nickname).toBe("Justin's MacBook Pro 2");
  });

  it('skips cleanly on an agent with no machine identity yet', () => {
    const result = migrate().migrate();
    expect(result.skipped).toContain('machine nicknames (no machine identity yet)');
  });
});
