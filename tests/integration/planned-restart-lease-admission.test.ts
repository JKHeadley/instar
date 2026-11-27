import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { ForegroundRestartWatcher } from '../../src/core/ForegroundRestartWatcher.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { DegradationReporter } from '../../src/monitoring/DegradationReporter.js';
import { readPlannedRestartVerifyState } from '../../src/core/PlannedRestartVerifyGuard.js';
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
  const foregroundShutdown = vi.fn();
  const watcher = new ForegroundRestartWatcher({
    stateDir, plannedLeaseAdmission: checkAdmission, exitOnRestart: false,
    onRestartDetected: foregroundShutdown,
  });
  const checkWatcher = () => (watcher as unknown as { check(): Promise<void> }).check();
  const restart = vi.spyOn(supervisor, 'performGracefulRestart').mockResolvedValue(true);
  const check = () => (supervisor as unknown as { checkRestartRequest(): Promise<void> }).checkRestartRequest();
  const write = (requestedAt: string, requestedBy = 'fixture-supervisor') =>
    writeFileSync(flag, JSON.stringify({ requestedAt, requestedBy, plannedRestart: true }));
  const report = vi.spyOn(DegradationReporter.getInstance(), 'report').mockImplementation(() => {});
  try {
    mkdirSync(join(stateDir, 'state'));
    write(earlier);
    await check();
    await checkWatcher();
    expect(foregroundShutdown).not.toHaveBeenCalled();
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


    const expired = new Date(Date.now() - 16 * 60_000).toISOString();
    write(expired);
    await check();
    expect(existsSync(flag)).toBe(true);
    expect(readPlannedRestartVerifyState(stateDir).pending).toBe(false);
    await checkWatcher();
    await checkWatcher();
    expect(report).toHaveBeenCalledOnce();
    expect(foregroundShutdown).not.toHaveBeenCalled();
    write(later);
    await checkWatcher();
    expect(foregroundShutdown).toHaveBeenCalledOnce();
    expect(existsSync(flag)).toBe(false);
    expect(restart).toHaveBeenCalledTimes(2);
  } finally {
    report.mockRestore();
    SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'planned-restart-lease-admission:cleanup' });
  }
});
