/**
 * agentWorktreeEvaluation.worker — the trivial `worker_threads` entry for the
 * AgentWorktreeReaper's dry-run pass off the server's main thread. It holds no
 * logic that can drift: it reads `workerData`, runs runAgentWorktreeEvaluation()
 * and posts the result back. See agentWorktreeEvaluationJob.ts for why.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { runAgentWorktreeEvaluation, type AgentWorktreeEvaluationInput } from './agentWorktreeEvaluationJob.js';

async function main(): Promise<void> {
  if (!parentPort) return; // not run as a worker: nothing to post to
  try {
    parentPort.postMessage(await runAgentWorktreeEvaluation(workerData as AgentWorktreeEvaluationInput));
  } catch (error) {
    parentPort.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

void main();
