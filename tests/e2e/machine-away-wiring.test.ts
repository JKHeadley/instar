/**
 * restart-lock-continuity part B: production wiring is alive. The shutdown handler
 * announces before the coordinator stops; the mesh dispatcher records announcements
 * bound to the sender; presence results clear them; the pool rows show the reason.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const read = (p: string) => fs.readFileSync(path.join(__dirname, '../..', p), 'utf8');
const server = read('src/commands/server.ts');

describe('machine-away wiring', () => {
  it('announces in the shutdown handler before the coordinator stops', () => {
    const announce = server.indexOf('await announceMachineAway({ peers');
    const stop = server.indexOf('      coordinator.stop();');
    expect(announce).toBeGreaterThan(0);
    expect(stop).toBeGreaterThan(announce);
    expect(server).toMatch(/serverStartedAt: SERVER_STARTED_AT_ISO/);
  });

  it('registers the mesh handler bound to the authenticated sender', () => {
    expect(server).toMatch(/'machine-away': \(cmd, sender\) => \{/);
    expect(server).toMatch(/getActiveMachineAwayBook\(\)\?\.receive\(sender, away\)/);
    expect(server).toMatch(/setActiveMachineAwayBook\(new MachineAwayBook\(/);
  });

  it('feeds presence results to the book and advertises this server instance', () => {
    expect(server).toMatch(/onPresenceResult: \(machineId, ok, startedAt\) => \{ getActiveMachineAwayBook\(\)\?\.observePresence\(machineId, ok, startedAt\); \}/);
    expect(server).toMatch(/return \{ \.\.\.base, serverStartedAt: SERVER_STARTED_AT_ISO,/);
  });

  it('the pool rows read the away reason', () => {
    const routes = read('src/server/routes.ts');
    expect(routes).toMatch(/awayText: describeAway\(rec, Date\.now\(\)\)/);
    const rpc = read('src/core/MeshRpc.ts');
    expect(rpc).toMatch(/case 'machine-away':/);
  });
});
