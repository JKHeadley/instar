import { parentPort } from 'node:worker_threads';
import { readTranscriptBatch, type TranscriptRequest } from './UsageLedgerTranscript.js';

if (!parentPort) throw new Error('Usage ledger transcript reader requires a worker');
const port = parentPort;
port.on('message', (request: TranscriptRequest) => {
  void readTranscriptBatch(request).then(
    batch => port.postMessage({ batch }),
    (error: NodeJS.ErrnoException) => port.postMessage({ failed: true, code: error.code }),
  );
});
