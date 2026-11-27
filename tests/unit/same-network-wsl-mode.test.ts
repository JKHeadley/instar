/**
 * Identity A4, WSL bind: the networking mode is READ (wslinfo, else the Windows user's .wslconfig and
 * WSL 2's default), never guessed from an address range, and the bind plan fails closed. Every
 * combination of mode x NAT address x the Windows app's word, and every source of the reading.
 */
import { describe, it, expect } from 'vitest';
import {
  WSLCONFIG_CLOCK_MARGIN_MS, parseWslMode, readWslNetworkingMode, wslBindPlan, wslconfigNetworkingMode,
  type WslModeDeps, type WslModeReading, type WslNetworkingMode,
} from '../../src/core/SameNetworkNetwork.js';

const WSL2 = 'Linux version 6.18.33.2-microsoft-standard-WSL2 (root@x) #1 SMP';
const WSL1 = 'Linux version 4.4.0-19041-Microsoft (Microsoft@Microsoft.com) (gcc version 5.4.0) #1237-Microsoft';
const BOOT = Date.parse('2026-11-20T08:00:00Z');
const enoent = (): never => { const e = new Error('nope') as NodeJS.ErrnoException; e.code = 'ENOENT'; throw e; };

function deps(o: Partial<WslModeDeps> & { config?: string | null; configMtime?: number } = {}): WslModeDeps {
  return {
    procVersion: () => WSL2,
    wslinfo: async () => { throw new Error('wslinfo: not found'); },
    windowsProfile: async () => '/mnt/c/Users/owner',
    bootTimeMs: () => BOOT,
    mtimeMs: (f) => { expect(f).toBe('/mnt/c/Users/owner/.wslconfig'); return o.config === null || o.config === undefined ? enoent() : (o.configMtime ?? BOOT - 3_600_000); },
    readFile: () => (o.config ?? ''),
    ...o,
  };
}

describe('reading WSL networking mode', () => {
  it('parses every mode name WSL knows, and nothing else', () => {
    expect(parseWslMode('nat\n')).toBe('nat');
    expect(parseWslMode('NAT')).toBe('nat');
    expect(parseWslMode('Mirrored')).toBe('mirrored');
    for (const m of ['virtioproxy', 'none', 'bridged']) expect(parseWslMode(m)).toBe('other');
    for (const m of ['', 'natt', 'mirror', 'unknown']) expect(parseWslMode(m)).toBeNull();
  });

  it('reads [wsl2] networkingMode, then the older [experimental] key; other sections and comments do not count', () => {
    expect(wslconfigNetworkingMode('[wsl2]\nmemory=12GB\nnetworkingMode=NAT\n')).toBe('nat');
    expect(wslconfigNetworkingMode('[wsl2]\r\nnetworkingMode = mirrored\r\n')).toBe('mirrored');
    expect(wslconfigNetworkingMode('﻿[WSL2]\nnetworkingmode="mirrored"\n')).toBe('mirrored');
    expect(wslconfigNetworkingMode('[experimental]\nnetworkingMode=mirrored\n')).toBe('mirrored');
    expect(wslconfigNetworkingMode('[experimental]\nnetworkingMode=mirrored\n[wsl2]\nnetworkingMode=nat\n')).toBe('nat');
    expect(wslconfigNetworkingMode('[wsl2]\n# networkingMode=mirrored\nmemory=4GB\n')).toBeUndefined();
    expect(wslconfigNetworkingMode('[other]\nnetworkingMode=mirrored\n')).toBeUndefined();
    expect(wslconfigNetworkingMode('')).toBeUndefined();
    expect(wslconfigNetworkingMode('[wsl2]\nnetworkingMode=sideways\n')).toBeNull();
  });

  it('wslinfo is authoritative when it answers', async () => {
    expect(await readWslNetworkingMode(deps({ wslinfo: async () => 'nat\n', config: '[wsl2]\nnetworkingMode=mirrored' }))).toMatchObject({ mode: 'nat', source: 'wslinfo' });
    expect(await readWslNetworkingMode(deps({ wslinfo: async () => 'mirrored\n', config: '[wsl2]\nnetworkingMode=nat' }))).toMatchObject({ mode: 'mirrored', source: 'wslinfo' });
    expect(await readWslNetworkingMode(deps({ wslinfo: async () => 'virtioproxy' }))).toMatchObject({ mode: 'other', source: 'wslinfo' });
    // An answer it does not know is unknown, not a reason to go and read the file instead.
    expect(await readWslNetworkingMode(deps({ wslinfo: async () => 'quantum', config: '[wsl2]\nnetworkingMode=nat' }))).toMatchObject({ mode: 'unknown', source: 'wslinfo' });
  });

  it('without wslinfo: the .wslconfig, else WSL 2\'s default (NAT) when the file is there and names no mode', async () => {
    expect(await readWslNetworkingMode(deps({ config: '[wsl2]\nnetworkingMode=mirrored' }))).toMatchObject({ mode: 'mirrored', source: 'wslconfig' });
    expect(await readWslNetworkingMode(deps({ config: '[wsl2]\nnetworkingMode=NAT' }))).toMatchObject({ mode: 'nat', source: 'wslconfig' });
    expect(await readWslNetworkingMode(deps({ config: '[wsl2]\nmemory=4GB' }))).toMatchObject({ mode: 'nat', source: 'default' });
    // No file at all: unknown, not the default (a file removed after a mirrored WSL started leaves no trace).
    expect(await readWslNetworkingMode(deps({ config: null }))).toMatchObject({ mode: 'unknown' });
    expect(await readWslNetworkingMode(deps({ config: '[wsl2]\nnetworkingMode=sideways' }))).toMatchObject({ mode: 'unknown' });
  });

  it('a .wslconfig changed after WSL started is not in effect yet: unknown', async () => {
    expect(await readWslNetworkingMode(deps({ config: '[wsl2]\nnetworkingMode=nat', configMtime: BOOT + 5000 }))).toMatchObject({ mode: 'unknown' });
    // Within the clock-drift margin before WSL started: not trusted either.
    expect(await readWslNetworkingMode(deps({ config: '[wsl2]\nnetworkingMode=nat', configMtime: BOOT - WSLCONFIG_CLOCK_MARGIN_MS + 1000 }))).toMatchObject({ mode: 'unknown' });
    expect(await readWslNetworkingMode(deps({ config: '[wsl2]\nnetworkingMode=nat', configMtime: BOOT - WSLCONFIG_CLOCK_MARGIN_MS - 1000 }))).toMatchObject({ mode: 'nat' });
    expect(await readWslNetworkingMode(deps({ config: '[wsl2]\nnetworkingMode=nat', bootTimeMs: () => null }))).toMatchObject({ mode: 'unknown' });
  });

  it('a .wslconfig saved between its time check and its read is unknown (the time must belong to the text read)', async () => {
    // First stat: an old time (trusted); the read sees new text; the second stat sees the save's new time.
    let calls = 0;
    const racing = deps({ config: '[wsl2]\nnetworkingMode=nat', mtimeMs: () => (++calls === 1 ? BOOT - 3_600_000 : BOOT + 60_000) });
    expect(await readWslNetworkingMode(racing)).toMatchObject({ mode: 'unknown', detail: '.wslconfig changed while it was read' });
    expect(calls).toBe(2);
    // Removed between the read and the second stat: unknown too.
    let n = 0;
    const vanished = deps({ config: '[wsl2]\nnetworkingMode=nat', mtimeMs: () => (++n === 1 ? BOOT - 3_600_000 : enoent()) });
    expect(await readWslNetworkingMode(vanished)).toMatchObject({ mode: 'unknown' });
    // Unchanged across the read: the reading stands (positive control).
    expect(await readWslNetworkingMode(deps({ config: '[wsl2]\nnetworkingMode=nat' }))).toMatchObject({ mode: 'nat', source: 'wslconfig' });
  });

  it('anything unreadable is unknown: no Windows user folder, an unreadable file, a failing interop', async () => {
    expect(await readWslNetworkingMode(deps({ windowsProfile: async () => null }))).toMatchObject({ mode: 'unknown' });
    expect(await readWslNetworkingMode(deps({ windowsProfile: async () => { throw new Error('interop off'); } }))).toMatchObject({ mode: 'unknown' });
    expect(await readWslNetworkingMode(deps({ mtimeMs: () => { const e = new Error('EACCES') as NodeJS.ErrnoException; e.code = 'EACCES'; throw e; } }))).toMatchObject({ mode: 'unknown' });
    expect(await readWslNetworkingMode(deps({ procVersion: () => { throw new Error('no /proc'); } }))).toMatchObject({ mode: 'unknown' });
  });

  it('WSL 1 shares Windows\' network: never NAT, whatever the file says', async () => {
    expect(await readWslNetworkingMode(deps({ procVersion: () => WSL1, wslinfo: async () => 'nat', config: '[wsl2]\nnetworkingMode=nat' }))).toMatchObject({ mode: 'other', source: 'wsl1' });
  });
});

describe('the WSL bind plan: every combination fails closed', () => {
  const reading = (mode: WslNetworkingMode): WslModeReading => ({ mode, source: 'wslinfo', detail: mode });
  const NAT_ADDR = '172.25.237.197';

  it('covers every mode x NAT address x the Windows app\'s word', () => {
    const modes: WslNetworkingMode[] = ['nat', 'mirrored', 'other', 'unknown'];
    for (const mode of modes) {
      for (const nat of [NAT_ADDR, null]) {
        for (const declared of [false, true]) {
          const plan = wslBindPlan(reading(mode), nat, declared);
          const label = `${mode}/${nat ?? 'no-nat-address'}/${declared ? 'app-handles-rule' : 'no-word'}`;
          if (mode === 'nat' && nat) {
            // NAT, read: WSL's own NAT address; the pass-through limits each real caller.
            expect(plan, label).toEqual({ ok: true, bind: NAT_ADDR, mode: 'nat', perAddressLimit: false });
          } else if (mode === 'mirrored' && declared) {
            // Mirrored with the Windows app's word: loopback only, and the per-address limit stays on.
            expect(plan, label).toEqual({ ok: true, bind: '127.0.0.1', mode: 'mirrored', perAddressLimit: true });
          } else {
            expect(plan.ok, label).toBe(false);
          }
        }
      }
    }
  });

  it('mirrored on a private-range home network (172.16/12, 192.168/16, 10/8) is never bound on the LAN address, even when the address has the NAT shape', () => {
    // The old range guess would have taken this address; the plan never binds it in mirrored mode.
    const lanShaped = '172.20.10.5';
    expect(wslBindPlan(reading('mirrored'), lanShaped, false).ok).toBe(false);
    const withWord = wslBindPlan(reading('mirrored'), lanShaped, true);
    expect(withWord.ok && withWord.bind).toBe('127.0.0.1');
    expect(withWord.ok && withWord.perAddressLimit).toBe(true);
    // Since 2026-11-26 the NAT shape accepts every RFC 1918 block, so a mirrored WSL on a 192.168.x or
    // 10.x home LAN also has the shape. The read mode is the only protection, and it holds.
    for (const lan of ['192.168.1.20', '10.0.0.20']) {
      expect(wslBindPlan(reading('mirrored'), lan, false).ok).toBe(false);
      const p = wslBindPlan(reading('mirrored'), lan, true);
      expect(p.ok && p.bind).toBe('127.0.0.1');
      for (const mode of ['other', 'unknown'] as const) expect(wslBindPlan(reading(mode), lan, true).ok).toBe(false);
    }
  });

  it('a plan that would bind anything other than NAT address or loopback does not exist', () => {
    for (const mode of ['nat', 'mirrored', 'other', 'unknown'] as const) {
      for (const declared of [false, true]) {
        const p = wslBindPlan(reading(mode), NAT_ADDR, declared);
        if (p.ok) expect([NAT_ADDR, '127.0.0.1']).toContain(p.bind);
        if (p.ok && p.bind === '127.0.0.1') expect(p.perAddressLimit).toBe(true);
      }
    }
  });
});
