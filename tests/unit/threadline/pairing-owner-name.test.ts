import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readPairingOwnerName, resolvePairingOwnerName } from '../../../src/threadline/pairingOwnerName.js';

const verified = (uid: string, names: string[]) => ({
  platform: 'telegram', uid, names, boundAt: '', boundFrom: 'authenticated-inbound',
  establishmentEvidence: { kind: 'authenticated-inbound', ingress: 'telegram-lifeline-forward', authorization: 'telegram-is-authorized-sender', senderUid: uid, messageId: '1' },
});

describe('resolvePairingOwnerName', () => {
  it('prefers the explicit setting over everything else', () => {
    expect(resolvePairingOwnerName({ configured: ' Carl ', users: [{ name: 'Ann', permissions: ['admin'] }] })).toBe('Carl');
  });

  it('prefers an admin user over an earlier non-admin user', () => {
    expect(resolvePairingOwnerName({ users: [{ name: 'Bo', permissions: [] }, { name: 'Ann', permissions: ['admin'] }] })).toBe('Ann');
  });

  it('falls back to the one verified Telegram operator, title-cased', () => {
    expect(resolvePairingOwnerName({ users: [], configuredOwnerUid: 77, operatorBindings: [verified('77', ['justin'])], everVerifiedUids: ['77'] })).toBe('Justin');
  });

  it('never takes a name from an unverified record', () => {
    expect(resolvePairingOwnerName({ configuredOwnerUid: 77, operatorBindings: [{ platform: 'telegram', uid: '77', names: ['mallory'], boundFrom: 'manual' }], everVerifiedUids: ['77'] })).toBe('');
  });

  it('does not pick between two verified operators when no owner is configured', () => {
    expect(resolvePairingOwnerName({ operatorBindings: [verified('1', ['ann']), verified('2', ['bo'])], everVerifiedUids: ['1', '2'] })).toBe('');
  });

  it('is blank when nothing names an owner', () => {
    expect(resolvePairingOwnerName({})).toBe('');
  });
});

describe('readPairingOwnerName (real file locations)', () => {
  const home = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pairing-owner-'));
  const uid = '77';
  const bind = (stateDir: string) => {
    fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'state', 'topic-operators.json'), JSON.stringify({ 5: verified(uid, ['justin']) }));
  };

  it('finds the verified operator where the server stores it', () => {
    const dir = home();
    bind(dir);
    expect(readPairingOwnerName(dir, [], 77)).toBe('Justin');
  });

  it('picks up threadline.ownerName from the config file with no restart', () => {
    const dir = home();
    expect(readPairingOwnerName(dir, [], undefined)).toBe('');
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ threadline: { ownerName: 'Justin' } }));
    expect(readPairingOwnerName(dir, [], undefined)).toBe('Justin');
  });

  it('treats a name of only invisible characters as blank', () => {
    expect(resolvePairingOwnerName({ configured: '\u200b' })).toBe('');
  });

  it('writes nothing and survives a corrupt users file', () => {
    const dir = home();
    fs.writeFileSync(path.join(dir, 'users.json'), '{not json');
    expect(readPairingOwnerName(dir, [{ name: 'Ann', permissions: ['admin'] }], undefined)).toBe('Ann');
    expect(fs.readdirSync(dir)).toEqual(['users.json']);
  });
});
