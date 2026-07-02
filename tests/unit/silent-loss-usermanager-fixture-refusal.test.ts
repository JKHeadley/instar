/**
 * silent-loss-refusal-conservation §2.D — UserManager fixture refusal at BOTH
 * layers: the WRITE path throws (TestIdentityRefusedError), the LOAD path
 * refuse-and-skips (never throws — a constructor throw fails boot). A legitimate
 * name-collision with a valid signed allow-marker survives write+reboot; a
 * legitimate real user (real id) registers unimpeded; high-water is set on register.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import os from 'node:os';
import path from 'node:path';
import { UserManager } from '../../src/users/UserManager.js';
import { TestIdentityRefusedError, signAllowTestIdentity } from '../../src/users/testIdentityMarkers.js';
import { readRegistryHighWater } from '../../src/core/registryHighWater.js';

const dirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'slrc-um-'));
  dirs.push(d);
  return d;
}
afterEach(() => { for (const d of dirs.splice(0)) try { SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'test-cleanup' }); } catch { /* ok */ } });

function usersFile(dir: string) { return path.join(dir, 'users.json'); }
function realUser(id: string) { return { id, name: 'Real', channels: [], permissions: ['user'] as string[] }; }
function fixtureUser() { return { id: 'u-olivia', name: 'Olivia', channels: [], permissions: ['admin'] as string[] }; }

describe('§2.D UserManager fixture refusal — WRITE path', () => {
  it('throws TestIdentityRefusedError on upsert of a fixture id', () => {
    const um = new UserManager(tmp());
    expect(() => um.upsertUser(fixtureUser())).toThrow(TestIdentityRefusedError);
  });

  it('a real user registers unimpeded AND sets the high-water marker', () => {
    const dir = tmp();
    const um = new UserManager(dir);
    expect(() => um.upsertUser(realUser('tg-500'))).not.toThrow();
    expect(um.getUser('tg-500')).toBeTruthy();
    expect(readRegistryHighWater(dir)).toBe(true);
  });

  it('legitimate-user-named-Olivia-registers: a real id whose display name is "Olivia" is allowed', () => {
    const um = new UserManager(tmp());
    expect(() => um.upsertUser({ id: 'tg-999', name: 'Olivia', channels: [], permissions: ['user'] })).not.toThrow();
  });
});

describe('§2.D UserManager fixture refusal — LOAD path', () => {
  it('refuse-and-skip: a fixture row already on disk is NOT loaded (and does NOT throw at construction)', () => {
    const dir = tmp();
    fs.writeFileSync(usersFile(dir), JSON.stringify([fixtureUser(), realUser('tg-77')]));
    let um: UserManager | undefined;
    expect(() => { um = new UserManager(dir); }).not.toThrow();
    expect(um!.getUser('u-olivia')).toBeNull(); // fixture skipped
    expect(um!.getUser('tg-77')).toBeTruthy(); // real user kept
  });

  it('an initialUsers merge that includes a fixture skips it (never fails boot)', () => {
    const dir = tmp();
    let um: UserManager | undefined;
    expect(() => { um = new UserManager(dir, [fixtureUser(), realUser('tg-88')]); }).not.toThrow();
    expect(um!.getUser('u-olivia')).toBeNull();
    expect(um!.getUser('tg-88')).toBeTruthy();
  });
});

describe('§2.D signed allow-marker override', () => {
  it('overridden-collision-survives-reboot: a fixture-colliding profile with a VALID signed marker persists + reloads', () => {
    const dir = tmp();
    const key = 'test-server-key';
    // WRITE: the profile carries a valid marker → validateProfile accepts it.
    const um1 = new UserManager(dir, undefined, { testIdentityKey: key });
    const marker = 'u-olivia';
    const sig = signAllowTestIdentity(key, 'u-olivia', marker);
    expect(() => um1.upsertUser({ id: 'u-olivia', name: 'Real Olivia', channels: [], permissions: ['user'], allowTestIdentity: { marker, sig } })).not.toThrow();
    // REBOOT: a fresh manager WITH the key reloads the overridden profile.
    const um2 = new UserManager(dir, undefined, { testIdentityKey: key });
    expect(um2.getUser('u-olivia')).toBeTruthy();
  });

  it('a data-only bogus allow-marker is refused at BOTH write (throw) and load (skip)', () => {
    const dir = tmp();
    const key = 'test-server-key';
    // WRITE with a bogus sig → throws.
    const um1 = new UserManager(dir, undefined, { testIdentityKey: key });
    expect(() => um1.upsertUser({ id: 'u-adam', name: 'x', channels: [], permissions: ['user'], allowTestIdentity: { marker: 'u-adam', sig: 'forged' } })).toThrow(TestIdentityRefusedError);
    // LOAD a hand-written bogus-marker file → skipped (not loaded).
    fs.writeFileSync(usersFile(dir), JSON.stringify([{ id: 'u-adam', name: 'x', channels: [], permissions: ['user'], allowTestIdentity: { marker: 'u-adam', sig: 'forged' } }]));
    const um2 = new UserManager(dir, undefined, { testIdentityKey: key });
    expect(um2.getUser('u-adam')).toBeNull();
  });

  it('without the server key, a marker cannot be minted-verified → the fixture is refused (safe direction)', () => {
    const dir = tmp();
    const um = new UserManager(dir); // no key
    expect(() => um.upsertUser({ id: 'u-mia', name: 'x', channels: [], permissions: ['user'], allowTestIdentity: { marker: 'u-mia', sig: 'anything' } })).toThrow(TestIdentityRefusedError);
  });
});
