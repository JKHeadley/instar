/** Secret resolution is independent of origin workers and never blocks notice egress. */
import { parentPort } from 'node:worker_threads';
import { mergeConfigWithSecrets } from '../../core/SecretMigrator.js';
if (!parentPort) throw new Error('origin-config-reader requires worker');
parentPort.on('message', (input: { id: number; stateDir: string; config: Record<string, unknown> }) => {
  try { parentPort!.postMessage({ id: input.id, config: mergeConfigWithSecrets(input.config, input.stateDir) }); }
  catch { parentPort!.postMessage({ id: input.id, error: 'origin-config-secret-source-unavailable' }); }
});
