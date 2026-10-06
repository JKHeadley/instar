/**
 * instar#2122 — bringing an agent up on a second machine left two pieces of
 * copied state that each looked healthy and each silenced the agent:
 *
 * 1. `sessions.claudePath` copied from the first machine named a binary that
 *    does not exist on the second. Instar used it verbatim, every Claude
 *    session died at spawn, and each death revoked that session's Telegram
 *    sending credential (`invalid-origin-token`).
 * 2. A registry entry for the machine's old, removed identity carried
 *    `revokedAt` but still said `status: 'active'`. Its endpoints were this
 *    machine's own, so cross-machine checks were addressed to a peer and
 *    delivered back to self (`wrong-recipient`).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveConfiguredClaudePath } from '../../src/core/Config.js';
import { MachineIdentityManager, isRegistryEntryActive } from '../../src/core/MachineIdentity.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('resolveConfiguredClaudePath', () => {
  it('keeps a configured path that exists', () => {
    const warnings: string[] = [];
    const resolved = resolveConfiguredClaudePath('/usr/local/bin/claude', () => '/detected/claude',
      { exists: () => true, warn: (m) => warnings.push(m) });
    expect(resolved).toBe('/usr/local/bin/claude');
    expect(warnings).toEqual([]);
  });

  it('falls back to detection when the configured path provably does not exist, and says so', () => {
    const warnings: string[] = [];
    const resolved = resolveConfiguredClaudePath('/opt/homebrew/bin/claude', () => '/usr/local/bin/claude',
      { exists: () => false, warn: (m) => warnings.push(m) });
    expect(resolved).toBe('/usr/local/bin/claude');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('/opt/homebrew/bin/claude');
    expect(warnings[0]).toContain('/usr/local/bin/claude');
  });

  it('keeps the configured path, with a warning, when it is absent and nothing is detected', () => {
    // Hosts without claude (CI runners) configure a placeholder path on purpose;
    // with no replacement available the value stands, as before.
    const warnings: string[] = [];
    const resolved = resolveConfiguredClaudePath('/gone/claude', () => null,
      { exists: () => false, warn: (m) => warnings.push(m) });
    expect(resolved).toBe('/gone/claude');
    expect(warnings[0]).toContain('no claude binary was detected');
  });

  it('keeps a bare command name and a path whose probe throws (absence not proven)', () => {
    const detect = () => '/detected/claude';
    expect(resolveConfiguredClaudePath('claude', detect, { exists: () => false, warn: () => {} })).toBe('claude');
    expect(resolveConfiguredClaudePath('/x/claude', detect, {
      exists: () => { throw new Error('EACCES'); }, warn: () => {},
    })).toBe('/x/claude');
  });

  it('uses detection when nothing is configured', () => {
    expect(resolveConfiguredClaudePath(undefined, () => '/detected/claude')).toBe('/detected/claude');
    expect(resolveConfiguredClaudePath('  ', () => '/detected/claude')).toBe('/detected/claude');
  });
});

describe('isRegistryEntryActive', () => {
  it('requires active status and no revocation stamp', () => {
    expect(isRegistryEntryActive({ status: 'active' })).toBe(true);
    expect(isRegistryEntryActive({ status: 'active', revokedAt: null })).toBe(true);
    expect(isRegistryEntryActive({ status: 'active', revokedAt: '2026-10-03T20:14:16.061Z' })).toBe(false);
    expect(isRegistryEntryActive({ status: 'revoked', revokedAt: '2026-10-03T20:14:16.061Z' })).toBe(false);
    expect(isRegistryEntryActive({ status: 'pending' })).toBe(false);
  });
});

describe('MachineIdentityManager with a half-revoked registry entry', () => {
  let tmp: string;
  let manager: MachineIdentityManager;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-2122-'));
    const instarDir = path.join(tmp, '.instar');
    fs.mkdirSync(path.join(instarDir, 'machines'), { recursive: true });
    const entry = (over: Record<string, unknown>) => ({
      name: 'mac-studio', status: 'active', role: 'standby', pairedAt: '2026-10-03T19:46:05.275Z',
      lastSeen: '2026-10-03T20:05:32.802Z', ...over,
    });
    fs.writeFileSync(path.join(instarDir, 'machines', 'registry.json'), JSON.stringify({
      version: 1,
      machines: {
        m_ghost: entry({ nickname: 'Mac Studio', role: 'awake', revokedAt: '2026-10-03T20:14:16.061Z', revokedBy: 'm_laptop' }),
        m_laptop: entry({ name: 'justin-mbp', nickname: 'Justin Mbp' }),
        m_studio: entry({ nickname: 'Mac Studio 2' }),
      },
    }));
    manager = new MachineIdentityManager(instarDir);
  });

  afterEach(() => SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/unit/second-machine-copied-config.test.ts:afterEach' }));

  it('leaves the revoked identity out of the active peer list', () => {
    expect(manager.getActiveMachines().map((m) => m.machineId).sort()).toEqual(['m_laptop', 'm_studio']);
  });

  it('does not report the revoked identity as active or awake', () => {
    expect(manager.isMachineActive('m_ghost')).toBe(false);
    expect(manager.isMachineActive('m_studio')).toBe(true);
    expect(manager.getAwakeMachine()).toBeNull();
  });
});
