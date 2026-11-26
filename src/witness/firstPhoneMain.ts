import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { createFirstPhoneWitnessObservation, runFirstPhoneWitnessObservation } from '../core/FirstPhoneWitnessObservation.js';
import { OrderedWitnessSnapshotStore } from '../core/OrderedWitnessSnapshotStore.js';
import { SafeGitExecutor } from '../core/SafeGitExecutor.js';

interface WitnessConfig {
  enabled?: boolean;
  home: string;
  agentId: string;
  repository: string;
  ref: string;
  audience: string;
  intervalMs: number;
}

async function main(args: string[]): Promise<void> {
  if (args.length !== 1 || !isAbsolute(args[0])) throw new Error('Expected one absolute witness configuration path');
  const config = JSON.parse(readFileSync(args[0], 'utf8')) as Partial<WitnessConfig>;
  if (config?.enabled !== true) return;
  const { home, agentId, repository, ref, audience, intervalMs } = config;
  if (typeof home !== 'string' || !isAbsolute(home) ||
      typeof agentId !== 'string' || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(agentId) ||
      typeof repository !== 'string' || typeof ref !== 'string' || typeof audience !== 'string' ||
      typeof intervalMs !== 'number' || !Number.isSafeInteger(intervalMs) || intervalMs < 1000 || intervalMs > 2_147_483_647) {
    throw new Error('Invalid first-phone witness configuration');
  }

  const mirror = join(home, 'mirror.git');
  if (SafeGitExecutor.readSync(['rev-parse', '--is-bare-repository'], {
    cwd: mirror, operation: 'first-phone-witness:validate-isolated-mirror', timeout: 5000,
  }).trim() !== 'true') throw new Error('First-phone witness requires an isolated bare mirror');

  const store = OrderedWitnessSnapshotStore.open(join(home, 'witness.sqlite'));
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    const observe = createFirstPhoneWitnessObservation({
      enabled: true, target: { repository, ref, audience, scope: { agentId, namespace: 'machine-key-history' } },
      mirror, store,
    });
    await runFirstPhoneWitnessObservation({
      enabled: true, observe, intervalMs, signal: controller.signal,
      report: result => process.stdout.write(JSON.stringify({ event: 'first-phone-witness-observation', result }) + '\n'),
    });
  } finally {
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
    store.close();
  }
}

void main(process.argv.slice(2)).catch(() => {
  // Configuration may contain machine-local paths. Keep them out of service logs.
  process.stderr.write('First-phone witness could not start or continue.\n');
  process.exitCode = 1;
});
