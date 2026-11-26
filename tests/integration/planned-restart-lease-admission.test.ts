import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { ServerSupervisor } from '../../src/lifeline/ServerSupervisor.js';

it('retains a planned request until its exact current lease window is admitted', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'restart-lease-admission-'));
  const flag = join(stateDir, 'state', 'restart-requested.json');
  const earlier = new Date(Date.now() - 1000).toISOString();
  const later = new Date().toISOString();
  let confirmed = '';
  const checkAdmission = vi.fn(({ requestedAt }) => requestedAt === confirmed ? 'ready' as const : 'wait' as const);
  const supervisor = new ServerSupervisor({
    projectDir: stateDir, stateDir, projectName: 'fixture', port: 59998, plannedLeaseAdmission: checkAdmission,
  });
  const restart = vi.spyOn(supervisor, 'performGracefulRestart').mockResolvedValue(true);
  const check = () => (supervisor as unknown as { checkRestartRequest(): Promise<void> }).checkRestartRequest();
  const write = (requestedAt: string, requestedBy = 'fixture-supervisor') =>
    writeFileSync(flag, JSON.stringify({ requestedAt, requestedBy, plannedRestart: true }));
  try {
    mkdirSync(join(stateDir, 'state'));
    write(earlier);
    await check();
    expect(existsSync(flag)).toBe(true);
    expect(restart).not.toHaveBeenCalled();
    confirmed = earlier;
    write(later);
    await check();
    expect(existsSync(flag)).toBe(true);
    expect(restart).not.toHaveBeenCalled();
    confirmed = later;
    let settle!: (value: 'ready') => void;
    checkAdmission.mockImplementationOnce(() => new Promise(resolve => { settle = resolve; }) as never);
    const inFlight = check();
    write(earlier);
    settle('ready');
    await inFlight;
    expect(restart).not.toHaveBeenCalled();
    expect(existsSync(flag)).toBe(true);
    write(later);
    await check();
    expect(restart).toHaveBeenCalledOnce();
    expect(existsSync(flag)).toBe(false);

    checkAdmission.mockClear();
    write(later, 'role-change');
    await check();
    expect(checkAdmission).not.toHaveBeenCalled();
    expect(restart).toHaveBeenCalledTimes(2);
  } finally {
    SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'planned-restart-lease-admission:cleanup' });
  }
});
