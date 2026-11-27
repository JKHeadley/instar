/**
 * The name a person already calls their computer becomes the machine's nickname, with no
 * question asked (operator report 2026-11-12: a footer read "bob · Machine m_4851af").
 */
import { describe, it, expect } from 'vitest';
import { friendlyNameFrom, prettifyHostname, sanitizeFriendlyName, detectFriendlyMachineName } from '../../src/core/friendlyMachineName.js';
import { isValidNickname, assignNickname } from '../../src/core/NicknameAssigner.js';

describe('friendlyNameFrom', () => {
  it('macOS uses the ComputerName as written, apostrophe included', () => {
    expect(friendlyNameFrom({ platform: 'darwin', computerName: "Justin's MacBook Pro", hostname: 'justins-mbp.local' })).toBe("Justin's MacBook Pro");
    expect(friendlyNameFrom({ platform: 'darwin', computerName: 'Justin’s Mac mini', hostname: 'x' })).toBe("Justin's Mac mini");
  });
  it('Linux uses the pretty hostname', () => {
    expect(friendlyNameFrom({ platform: 'linux', prettyHostname: 'Mama PC', hostname: 'mama-pc' })).toBe('Mama PC');
  });
  it('falls back to a prettified hostname when the platform name is empty or unusable', () => {
    expect(friendlyNameFrom({ platform: 'linux', prettyHostname: '', hostname: 'dev-box-2.example.com' })).toBe('Dev Box 2');
    expect(friendlyNameFrom({ platform: 'darwin', computerName: null, hostname: 'justins-mbp.local' })).toBe('Justins Mbp');
    expect(friendlyNameFrom({ platform: 'win32', hostname: 'DESKTOP-ABC123' })).toBe('DESKTOP ABC123');
  });
  it('returns null when nothing usable exists (empty, id-shaped or localhost)', () => {
    expect(friendlyNameFrom({ platform: 'darwin', computerName: '', hostname: '' })).toBeNull();
    expect(friendlyNameFrom({ platform: 'linux', prettyHostname: null, hostname: 'localhost' })).toBeNull();
    expect(friendlyNameFrom({ platform: 'darwin', computerName: 'm_4851af0011', hostname: null })).toBeNull();
  });
});

describe('sanitizeFriendlyName', () => {
  it('drops characters outside the nickname alphabet, collapses space and bounds length', () => {
    expect(sanitizeFriendlyName('  Bob’s   "Studio" \n')).toBe("Bob's Studio");
    expect(sanitizeFriendlyName('🍎 Kitchen Mac')).toBe('Kitchen Mac');
    const long = sanitizeFriendlyName('A'.repeat(80));
    expect(long).toHaveLength(40);
    expect(isValidNickname(long)).toBe(true);
  });
  it('never returns a value the nickname validator would refuse', () => {
    for (const raw of ["Justin's MacBook Pro", '---', "'quoted'", 'Mac/Studio', '\u0000\u0007']) {
      const out = sanitizeFriendlyName(raw);
      expect(out === null || isValidNickname(out)).toBe(true);
    }
  });
});

describe('prettifyHostname', () => {
  it('title-cases plain words and keeps words that already carry capitals', () => {
    expect(prettifyHostname('mac-studio.local')).toBe('Mac Studio');
    expect(prettifyHostname('MacBook-Air')).toBe('MacBook Air');
  });
});

describe('assignNickname keepCase', () => {
  it('keeps a person-given name verbatim and still disambiguates a collision', () => {
    expect(assignNickname({ identityName: "Justin's MacBook Pro", keepCase: true, existingNicknames: [] })).toBe("Justin's MacBook Pro");
    expect(assignNickname({ identityName: 'Mac mini', keepCase: true, existingNicknames: ['mac mini'] })).toBe('Mac mini 2');
  });
});

describe('detectFriendlyMachineName', () => {
  it('never throws and returns a valid nickname or null on this host', () => {
    const out = detectFriendlyMachineName();
    expect(out === null || isValidNickname(out)).toBe(true);
  });
});
