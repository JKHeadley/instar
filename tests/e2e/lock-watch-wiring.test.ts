/**
 * restart-lock-continuity part C.1: production wiring is alive. The lock reader is
 * created outside the machine-maintenance gate, the lock watch starts for Local
 * Verify or self-maintaining machines, and the lock-state route reports the watch.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const read = (p: string) => fs.readFileSync(path.join(__dirname, '../..', p), 'utf8');
const server = read('src/commands/server.ts');

describe('lock watch wiring', () => {
  it('creates the lock reader before the machine-maintenance gate, and the gate reuses it', () => {
    const early = server.indexOf("if (!getActiveMachineLockStateReader()) setActiveMachineLockStateReader(new MachineLockStateReader());");
    expect(early).toBeGreaterThan(0);
    const gateReuse = server.indexOf("// Usually already created at startup for the lock watch");
    expect(gateReuse).toBeGreaterThan(early);
  });

  it('starts the lock watch for Local Verify or enrolled self-care machines and registers it', () => {
    expect(server).toMatch(/if \(lvSvc \|\| enrolledSelfCare\(\)\) \{/);
    expect(server).toMatch(/setActiveLockWatch\(lockWatch\);\s*\n\s*lockWatch\.start\(\);/);
    expect(server).toMatch(/hostDir: path\.join\(os\.homedir\(\), '\.instar', 'host-maintenance'\)/);
    expect(server).toMatch(/defaultDoNotMaintainPath\(\)/);
  });

  it('the lock-state route includes the watch status', () => {
    const routes = read('src/server/routes.ts');
    expect(routes).toMatch(/lockWatch: watch \? watch\.status\(\) : null/);
  });
});
