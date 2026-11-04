/**
 * Wiring integrity for lease-takeover-no-shared-medium: the production composition in
 * server.ts must hand the coordinator and the store the real live checks, and the switch must
 * stay dark by default. Without these the unit and integration tests pass and nothing changes.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { getInitDefaults } from '../../src/config/ConfigDefaults.js';

const server = fs.readFileSync(path.join(process.cwd(), 'src/commands/server.ts'), 'utf-8');

describe('lease takeover wiring in server.ts', () => {
  it('the switch ships dark', () => {
    const d = getInitDefaults('standalone') as { multiMachine?: { leaseSelfHeal?: { soloCaptainHold?: { enabled?: boolean } } } };
    expect(d.multiMachine?.leaseSelfHeal?.soloCaptainHold?.enabled).toBe(false);
  });
  it('the coordinator receives survivorMayHold', () => {
    const start = server.indexOf('new LeaseCoordinator({');
    expect(start).toBeGreaterThan(-1);
    expect(server.slice(start, start + 4000)).toMatch(/\n\s+survivorMayHold,\n/);
  });
  it('the git store receives localCommitIsFinal, tied to the switch, the peer check and the remote read', () => {
    const start = server.indexOf('leaseStore = new GitLeaseStore({');
    const block = server.slice(start, start + 900);
    expect(block).toContain('localCommitIsFinal');
    expect(block).toContain('soloCaptainHold?.enabled');
    expect(block).toContain('survivorMayHold()');
    expect(block).toContain('gitLeaseHasNoRemote(config.projectDir) === true');
  });
  it('survivorMayHold needs a non-revoked peer and no named preferred machine', () => {
    const start = server.indexOf('const survivorMayHold = ');
    const block = server.slice(start, start + 300);
    expect(block).toContain('preferredAwakeMachineId');
    expect(block).toContain('!entry.revokedAt');
  });
});
