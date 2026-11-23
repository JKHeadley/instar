/**
 * Wiring integrity for lease-takeover-no-shared-medium: the production composition in
 * server.ts must hand the coordinator and the store the real live checks, and the switch must
 * stay dark by default. Without these the unit and integration tests pass and nothing changes.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { getInitDefaults } from '../../src/config/ConfigDefaults.js';
import { LocalLeaseStore } from '../../src/core/LocalLeaseStore.js';

const server = fs.readFileSync(path.join(process.cwd(), 'src/commands/server.ts'), 'utf-8');

describe('lease takeover wiring in server.ts', () => {
  it('the switch ships dark', () => {
    const d = getInitDefaults('standalone') as { multiMachine?: { leaseSelfHeal?: { soloCaptainHold?: { enabled?: boolean } } } };
    expect(d.multiMachine?.leaseSelfHeal?.soloCaptainHold?.enabled).toBe(false);
  });
  it('the store a pair with no git uses reports that it shares nothing, so a restart asks first', () => {
    const store = new LocalLeaseStore({ filePath: path.join(process.cwd(), 'unused-lease-wiring.json') });
    expect(store.hasNoSharedMedium()).toBe(true);
    expect(server).toMatch(/leaseStore = new LocalLeaseStore\(\{/);
    // A peer's signed pull reaches the holder through this one route, and has to count there.
    const agentServer = fs.readFileSync(path.join(process.cwd(), 'src/server/AgentServer.ts'), 'utf-8');
    expect(agentServer).toMatch(/onLeasePullRequest: \(\) => \{\s*options\.coordinator\?\.noteLeasePeerPull\(\);\s*return options\.onLeasePullRequest\?\.\(\) \?\? null;/);
    expect(server).toMatch(/new AgentServer\(\{[^\n]*coordinator: coordinator\.enabled/);
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
  it('only an unproved joiner is held back, and the coordinator receives it', () => {
    const start = server.indexOf('const acquireHeldBack = ');
    const line = server.slice(start, server.indexOf('\n', start));
    expect(line).toContain("pairRole === 'joiner'");
    expect(line).toContain('noLinkProved()');
    expect(server.slice(server.indexOf('const survivorMayHold = '), server.indexOf('const survivorMayHold = ') + 300)).toContain('!acquireHeldBack()');
    expect(server).toMatch(/new LeaseCoordinator\(\{[\s\S]{0,4000}acquireHeldBack,/);
  });
  it('survivorMayHold needs a non-revoked peer and no effective preferred machine', () => {
    const start = server.indexOf('const survivorMayHold = ');
    const preferredStart = server.indexOf('const effectivePreferred = ');
    expect(preferredStart).toBeGreaterThan(-1);
    expect(start).toBeGreaterThan(preferredStart);
    const preferred = server.slice(preferredStart, start);
    // A configured preference remains authoritative unless its machine is below the build fence.
    expect(preferred).toContain('config.multiMachine?.leaseSelfHeal?.preferredAwakeMachineId ?? null');
    expect(preferred).toContain('return p && ownerRecordWiring.ownerRecordIsBelow(p) ? null : p;');
    const block = server.slice(start, server.indexOf('_noLastingLinkYet = ', start));
    expect(block).toContain('!effectivePreferred()');
    expect(block).toContain('livePeerIds().length > 0');
    expect(block).toContain('!acquireHeldBack()');
    expect(server.slice(server.indexOf('const livePeerIds = '), preferredStart)).toContain('!entry.revokedAt');
  });
});
