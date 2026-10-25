/** Forced known-state canary for OWN config/crypto/filesystem contracts.
 * Native CLI formats and OS-keychain access are deliberately not simulated as proof.
 * RULE 3.1 RATIONALE: critical authority readers; hourly isolated diagnostics;
 * stable owned schemas; real source failures still fail closed independently.
 * Deterministic known-input checks use actual file-key SecretStore and readers.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SecretStore } from '../../core/SecretStore.js';
import { OriginConfigReader } from './OriginConfigReader.js';
import { OriginNoticePolicyObserver } from './OriginNoticePolicyObserver.js';
import { SafeFsExecutor } from '../../core/SafeFsExecutor.js';

export const OWNED_CANARY_CHECKS = ['encrypted-config-read', 'exact-hub-permission', 'opt-out-observed', 'hub-rebind-refused', 'credential-rotation-refused', 'malformed-source-refused'] as const;
let phase = 'fixture-initialization';

async function run(): Promise<void> {
  let reader: OriginConfigReader | undefined;
  let observer: OriginNoticePolicyObserver | undefined;
  let directory: string | undefined;
  try {
    const input = workerData as { directory: string; configWorkerUrl: string };
    directory = input.directory;
    const { configWorkerUrl } = input;
    // The parent creates this private directory; this worker never reads agent state.
    const filename = path.join(directory, 'config.json'), hubFile = path.join(directory, 'state/agent-attention-topic.json');
    await mkdir(path.join(directory, 'state'), { recursive: true });
    const config = { messaging: [{ type: 'telegram', enabled: true, config: { token: { secret: true }, chatId: { secret: true },
      messageOrigin: { outageNotice: { enabled: true } } } }] };
    const secrets = new SecretStore({ stateDir: directory, forceFileKey: true });
    secrets.write({ messaging: [{ config: { token: '123:canary-only', chatId: '-100123' } }] });
    await writeFile(filename, JSON.stringify(config), { mode: 0o600 }); await writeFile(hubFile, '42', { mode: 0o600 });
    reader = new OriginConfigReader(directory, new URL(configWorkerUrl));
    const activeReader = reader;
    const checks: string[] = [];
    const requireCheck = (name: string, condition: unknown) => { phase = name; if (!condition) throw new Error('canary-check-failed'); checks.push(name); };
    const freshRead = async () => {
      for (let n = 0; n < 3; n++) {
        await new Promise(resolve => setTimeout(resolve, 25));
        try { return await activeReader.read(); } catch { /* Bounded watcher-stable reobservation. */ }
      }
      throw new Error('canary-source-unavailable');
    };
    const settle = async () => {
      // Bounded source reobservation after watcher invalidation; never reuse an old projection.
      for (let n = 0; n < 3; n++) {
        await new Promise(resolve => setTimeout(resolve, 25));
        try { await activeReader.read(); await observer!.refresh(); if (observer!.getHealth().state === 'healthy') return; } catch { /* Next bounded fresh read. */ }
      }
      throw new Error('canary-source-unavailable');
    };
    // Fresh fixture creation can deliver queued watcher invalidations. Accept
    // only a subsequent successful real read, within this bounded attempt.
    const value = await freshRead();
    requireCheck('encrypted-config-read', value.config.messaging[0].config.token === '123:canary-only' && value.config.messaging[0].config.chatId === '-100123');
    observer = await OriginNoticePolicyObserver.open({ stateDir: directory, accountId: '123', token: '123:canary-only', configReader: reader });
    const destination = { accountId: '123', chatId: '-100123', topicId: '42' };
    requireCheck('exact-hub-permission', observer.read(destination)?.authorized === true && observer.read(destination)?.optedOut === false &&
      observer.read({ ...destination, topicId: '43' }) === null);
    config.messaging[0].config.messageOrigin.outageNotice.enabled = false;
    await writeFile(filename, JSON.stringify(config)); await settle();
    requireCheck('opt-out-observed', observer.read(destination)?.optedOut === true);
    await writeFile(hubFile, '43'); await settle();
    requireCheck('hub-rebind-refused', observer.read(destination) === null && observer.read({ ...destination, topicId: '43' })?.optedOut === true);
    secrets.set('messaging.0.config.token', '123:rotated-canary-only');
    await new Promise(resolve => setTimeout(resolve, 25));
    await freshRead(); await observer.refresh();
    requireCheck('credential-rotation-refused', observer.read({ ...destination, topicId: '43' }) === null);
    await writeFile(filename, '{malformed'); await new Promise(resolve => setTimeout(resolve, 25));
    let refused = false; try { await reader.read(); } catch { refused = true; }
    await observer.refresh();
    requireCheck('malformed-source-refused', refused && reader.getHealth().state === 'unavailable' && observer.read({ ...destination, topicId: '43' }) === null);
    // Contract completion is distinct from synchronous native watcher teardown.
    // The parent still requires the following cleanup proof and actual resource
    // termination before it can expose passing diagnostic health.
    parentPort!.postMessage({ type: 'checks', passed: true, checks, checkedAt: performance.now() });
  } catch {
    parentPort!.postMessage({ type: 'checks', passed: false, phase, checkedAt: performance.now() });
  } finally {
    let verified = true;
    try {
      if (directory) await SafeFsExecutor.safeRm(directory, { recursive: true, force: true, operation: 'origin-detector-canary-worker-fixture-cleanup' });
    } catch { verified = false; }
    // Worker-thread performance clocks share a process time origin. Sending
    // the completion instant lets the parent distinguish actual slow cleanup
    // from an acknowledgement that sat queued during a parent event-loop stall.
    parentPort!.postMessage({ type: 'cleanup', verified, fixtureRemoved: verified, completedAt: performance.now() });
    // This worker is the isolation boundary for its real FSWatcher set. On
    // macOS, closing those watchers one-by-one can synchronously block for
    // tens of seconds under load. The fixture is already gone; terminating
    // this disposable thread closes every remaining watcher as one owned
    // resource boundary. The parent owns forced termination after this proof
    // and still requires the actual exit event before exposing passing health.
  }
}
if (parentPort) {
  void run().catch(() => parentPort!.postMessage({ type: 'cleanup', verified: false, fixtureRemoved: false, completedAt: performance.now() }));
}
