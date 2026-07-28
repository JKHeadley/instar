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

let activeGitPid: number | null = null;
parentPort?.on('message', (msg: { kind?: string }) => {
  if (msg.kind !== 'cancel' || activeGitPid == null) return;
  try { process.kill(activeGitPid, 'SIGKILL'); } catch { /* @silent-fallback-ok — already exited is the desired terminal state */ }
});

async function main(): Promise<void> {
  const job = workerData as WorkerJob;
  if (!parentPort) return; // not run as a worker — nothing to post to
  const port = parentPort;
  try {
    if (job.mode === 'detect') {
      port.postMessage({ ok: true, result: await runDetect(job.input, undefined, {
        onGitSpawn: (pid) => { activeGitPid = pid; port.postMessage({ kind: 'git-child-spawned', pid }); },
        onGitClose: (pid) => { activeGitPid = null; port.postMessage({ kind: 'git-child-closed', pid }); },
      }) });
    } else if (job.mode === 'apply-deltas') {
      port.postMessage({ ok: true, result: applyIndexDeltas(job.input) });
    } else {
      port.postMessage({ ok: false, error: `unknown worker mode` });
    }
  } catch (err) {
    port.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

void main();
