/**
 * Enrolment readiness and refusals (machine-self-maintenance Part C, CMT-1200 first slice).
 * Both sides: every macOS and Linux check passing reads unattended; any one failing or
 * unread reads attended with the one plain step for it; WSL is attended only; and each
 * refusal row of the spec's table, with an unread `who` inventing no other person.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  enrolmentRefusal, otherUsersFromWho, parseAutoLogin, parseFileVault, parseLsblkCrypt, readReadiness, type ReadCommand,
} from '../../src/monitoring/machineMaintenance/enrolmentReadiness.js';

describe('parsers', () => {
  it('FileVault, auto-login and lsblk, with unread as null', () => {
    expect(parseFileVault('FileVault is Off.\n')).toBe(true);
    expect(parseFileVault('FileVault is On.\n')).toBe(false);
    expect(parseFileVault('error')).toBeNull();
    expect(parseFileVault(null)).toBeNull();
    expect(parseAutoLogin('dabombstudio\n', 'dabombstudio')).toBe(true);
    expect(parseAutoLogin('someoneelse\n', 'dabombstudio')).toBe(false);
    expect(parseAutoLogin('The domain/default pair of (/Library/Preferences/com.apple.loginwindow, autoLoginUser) does not exist', 'me')).toBe(false);
    expect(parseAutoLogin(null, 'me')).toBeNull();
    expect(parseLsblkCrypt('part\ndisk\n')).toBe(true);
    expect(parseLsblkCrypt('crypt\npart\ndisk\n')).toBe(false);
    expect(parseLsblkCrypt('')).toBeNull();
  });
});

describe('readReadiness', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-ready-')); });
  afterEach(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/machine-enrolment-readiness.test.ts' }));

  const plist = (name: string) => fs.writeFileSync(path.join(dir, `ai.instar.${name}.plist`), '<plist/>');
  const mac = (o: { fv?: string | null; al?: string | null; ral?: Record<string, string | null> } = {}): ReadCommand => async (cmd, args) => {
    if (cmd.endsWith('fdesetup')) return o.fv === undefined ? 'FileVault is Off.' : o.fv;
    if (cmd.endsWith('defaults')) return o.al === undefined ? 'me' : o.al;
    if (cmd.endsWith('plutil')) { const p = args[args.length - 1]; const n = path.basename(p).replace(/^ai\.instar\.|\.plist$/g, ''); return o.ral && n in o.ral ? o.ral[n] : 'true'; }
    return null;
  };

  it('macOS: FileVault off, auto-login as this user and every LaunchAgent run-at-load reads unattended, no step', async () => {
    plist('echo'); plist('sagemind');
    const r = await readReadiness({ platform: 'darwin', user: 'me', agents: ['echo', 'sagemind'], read: mac(), launchAgentsDir: dir });
    expect(r).toMatchObject({ mode: 'unattended', ownerStep: null });
  });

  it('macOS: FileVault on is attended with the keep-it step; auto-login off names the one setting', async () => {
    plist('echo');
    const fv = await readReadiness({ platform: 'darwin', user: 'me', agents: ['echo'], read: mac({ fv: 'FileVault is On.' }), launchAgentsDir: dir });
    expect(fv.mode).toBe('attended');
    expect(fv.ownerStep).toMatch(/recommend keeping it/);
    const al = await readReadiness({ platform: 'darwin', user: 'me', agents: ['echo'], read: mac({ al: 'other' }), launchAgentsDir: dir });
    expect(al.ownerStep).toMatch(/Automatically log in as/);
  });

  it('macOS: a missing or not-run-at-load LaunchAgent names the agent; unread reads attended, never ready', async () => {
    plist('echo'); plist('sagemind');
    const miss = await readReadiness({ platform: 'darwin', user: 'me', agents: ['echo', 'groky'], read: mac(), launchAgentsDir: dir });
    expect(miss.checks.find((c) => c.id === 'launch-agents')).toMatchObject({ ok: false, detail: 'groky' });
    const off = await readReadiness({ platform: 'darwin', user: 'me', agents: ['sagemind'], read: mac({ ral: { sagemind: 'false' } }), launchAgentsDir: dir });
    expect(off.mode).toBe('attended');
    const unread = await readReadiness({ platform: 'darwin', user: 'me', agents: ['echo'], read: mac({ fv: null }), launchAgentsDir: dir });
    expect(unread.mode).toBe('attended');
    expect(unread.checks[0]).toMatchObject({ id: 'filevault-off', ok: null });
  });

  it('Linux: unencrypted root, linger and enabled units read unattended; a crypt ancestor reads attended', async () => {
    const linux = (crypt: boolean): ReadCommand => async (cmd) => {
      if (cmd.endsWith('findmnt')) return '/dev/sda2\n';
      if (cmd.endsWith('lsblk')) return crypt ? 'crypt\npart\ndisk' : 'part\ndisk';
      if (cmd.endsWith('loginctl')) return 'Linger=yes\n';
      if (cmd.endsWith('systemctl')) return 'enabled\n';
      return null;
    };
    expect((await readReadiness({ platform: 'linux', user: 'u', agents: ['a'], read: linux(false) })).mode).toBe('unattended');
    const enc = await readReadiness({ platform: 'linux', user: 'u', agents: ['a'], read: linux(true) });
    expect(enc).toMatchObject({ mode: 'attended' });
    expect(enc.ownerStep).toMatch(/disk password/);
  });

  it('WSL is attended only, with a plain reminder step', async () => {
    const r = await readReadiness({ platform: 'wsl', user: 'u', agents: ['a'], read: async () => null });
    expect(r).toMatchObject({ mode: 'attended' });
    expect(r.ownerStep).toMatch(/remind you to restart/);
  });
});

describe('enrolmentRefusal', () => {
  const base = { throwaway: false, testProcess: false, doNotMaintainMarker: false, ownership: undefined, inContainer: false, otherUsers: [] as string[] | null };
  it('each row of the table, and none for an owned, empty machine', () => {
    expect(enrolmentRefusal(base)).toBeNull();
    expect(enrolmentRefusal({ ...base, throwaway: true })).toBe('throwaway');
    expect(enrolmentRefusal({ ...base, testProcess: true })).toBe('throwaway');
    expect(enrolmentRefusal({ ...base, doNotMaintainMarker: true })).toBe('not-owned');
    expect(enrolmentRefusal({ ...base, ownership: 'shared' })).toBe('not-owned');
    expect(enrolmentRefusal({ ...base, inContainer: true })).toBe('not-owned');
    expect(enrolmentRefusal({ ...base, otherUsers: ['adriana'] })).toBe('other-user-active');
    expect(enrolmentRefusal({ ...base, otherUsers: null })).toBeNull();
  });

  it('who: only other login names count', () => {
    expect(otherUsersFromWho('me  console  Nov 16 11:02\nme  ttys001  Nov 16 11:05\n', 'me')).toEqual([]);
    expect(otherUsersFromWho('me  console  Nov 16\nadriana  ttys003  Nov 16\n', 'me')).toEqual(['adriana']);
    expect(otherUsersFromWho(null, 'me')).toBeNull();
  });
});
