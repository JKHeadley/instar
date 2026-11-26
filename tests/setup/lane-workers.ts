/**
 * Worker count for the parallel unit lane (spec: local-verify-merge-authority §1).
 *
 * INSTAR_TEST_WORKERS wins when it is a positive integer. Otherwise 8 workers on
 * a host with 12 or more cores (measured on the 16-core Mac Studio: the full unit
 * lane in under 4 minutes, every test passing), else half the cores, rounded up.
 * The integration and e2e lanes do not use this: they stay at one worker until
 * their isolation follow-ups land.
 */
import os from 'node:os';

export function resolveUnitLaneWorkers(
  env: NodeJS.ProcessEnv = process.env,
  cores: number = os.availableParallelism?.() ?? os.cpus().length,
): number {
  const raw = env['INSTAR_TEST_WORKERS'];
  if (raw !== undefined && /^\d+$/.test(raw.trim())) {
    const n = Number(raw.trim());
    if (n >= 1) return n;
  }
  const c = Number.isFinite(cores) && cores >= 1 ? Math.floor(cores) : 1;
  return c >= 12 ? 8 : Math.ceil(c / 2);
}
