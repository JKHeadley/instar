/**
 * cartographerDetect.worker — the TRIVIAL `worker_threads` entrypoint for the
 * off-event-loop cartographer detect / index-write (fix instar#1069).
 *
 * It contains NO logic that can drift: it reads `workerData`, dispatches to the
 * pure module (`runDetect` / `applyIndexDeltas` in cartographerDetect.ts), posts
 * the bounded result back, and exits. The 67MB parse + O(nodeCount) walk happen
 * HERE, on a worker thread — never on the server's main event loop.
 *
 * The engine spawns this with an explicit minimal `env` allowlist (NOT the parent
 * process.env), so the Telegram token / Anthropic keys / Bearer authToken / PIN
 * material are absent — the detect worker reads paths + git oids only, never blob
 * content, so it needs none of them.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { runDetect, applyIndexDeltas, type DetectInput, type ApplyDeltasInput } from './cartographerDetect.js';

type WorkerJob =
  | { mode: 'detect'; input: DetectInput }
  | { mode: 'apply-deltas'; input: ApplyDeltasInput };

function main(): void {
  const job = workerData as WorkerJob;
  if (!parentPort) return; // not run as a worker — nothing to post to
  try {
    if (job.mode === 'detect') {
      parentPort.postMessage({ ok: true, result: runDetect(job.input) });
    } else if (job.mode === 'apply-deltas') {
      parentPort.postMessage({ ok: true, result: applyIndexDeltas(job.input) });
    } else {
      parentPort.postMessage({ ok: false, error: `unknown worker mode` });
    }
  } catch (err) {
    parentPort.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

main();
