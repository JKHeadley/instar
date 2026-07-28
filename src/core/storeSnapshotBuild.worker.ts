/**
 * storeSnapshotBuild.worker — the TRIVIAL `worker_threads` entrypoint for the
 * off-event-loop single-origin snapshot build (WS2 replicated-store foundation
 * §6.3 step 2; the instar#1069 event-loop-safety requirement, mirroring
 * cartographerDetect.worker.ts).
 *
 * It contains NO logic that can drift: it reads `workerData`, dispatches to the
 * pure `materializeSnapshot()` in StoreSnapshot.ts, posts the bounded result back,
 * and exits. The whole-store materialization (the O(entries) fold + the
 * per-recordKey HLC-max merge over a potentially large own-stream) happens HERE,
 * on a worker thread — NEVER on the server's main event loop.
 *
 * The engine spawns this with an explicit minimal `env` allowlist (NOT the parent
 * process.env), so the Telegram token / Anthropic keys / Bearer authToken / PIN
 * material are absent — the build reads journal entries the caller already loaded
 * + passed in, never blob content or secrets, so it needs none of them.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { materializeSnapshot, type MaterializeInput } from './StoreSnapshot.js';

function main(): void {
  if (!parentPort) return; // not run as a worker — nothing to post to
  try {
    const input = workerData as MaterializeInput;
    parentPort.postMessage({ ok: true, result: materializeSnapshot(input) });
  } catch (err) {
    parentPort.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

main();
