import { parentPort, workerData } from 'node:worker_threads';
import { scanClaudeJsonlQuota } from './QuotaCollector.js';

if (!parentPort || typeof workerData !== 'string') {
  throw new Error('Quota JSONL scan requires a worker and a projects directory');
}

const result = await scanClaudeJsonlQuota(workerData);
parentPort.postMessage(result);
