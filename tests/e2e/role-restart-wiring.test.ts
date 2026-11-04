/** Wiring integrity: the check must sit on the real role event, behind the real conditions. */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const server = fs.readFileSync(path.join(process.cwd(), 'src/commands/server.ts'), 'utf-8');

describe('role restart wiring in server.ts', () => {
  const start = server.indexOf('const reconcileRole = (): void => {');
  const block = server.slice(start, start + 1900);
  it('subscribes to the role change', () => expect(start).toBeGreaterThan(-1));
  it('reads the role this process booted with, before the scheduler is built', () => {
    expect(start).toBeLessThan(server.indexOf('scheduler = new JobScheduler('));
    expect(server.slice(start - 300, start)).toContain('const bootAwake = coordinator.isAwake;');
  });
  it('losing the role pauses jobs at once, independent of any restart', () => {
    expect(block).toContain("coordinator.on('roleChange'");
    expect(block).toContain('scheduler?.pause()');
    expect(block).toContain('scheduler?.resume()');
  });
  it('a throttled or failed restart is retried', () => expect(block).toContain('setInterval(reconcileRole, 60_000)'));
  it('applies only with the switch on, no named preferred machine, and a peer', () => {
    expect(block).toContain('soloCaptainHold?.enabled');
    expect(block).toContain('preferredAwakeMachineId');
    expect(block).toContain('!entry.revokedAt');
  });
  it('asks for the restart only on the decision', () => expect(block).toMatch(/decision === 'restart'[\s\S]*requestRoleRestart/));
});
