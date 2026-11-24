import { parentPort, workerData } from 'node:worker_threads';
import { readLocalJobDefinitionPreviewSnapshot } from './JobDefinitionPreview.js';
import { buildJobDefinitionPreviewPage } from './JobDefinitionPreviewWorker.js';
import type { JobDefinitionPreviewPosition } from './JobDefinitionPreviewCursor.js';

const port = parentPort;
if (port) {
  const controller = new AbortController();
  port.on('message', message => {
    if (message === 'cancel') controller.abort();
  });
  const { jobsFile, continuation } = workerData as { jobsFile: string; continuation?: JobDefinitionPreviewPosition };
  try {
    const snapshot = await readLocalJobDefinitionPreviewSnapshot(jobsFile, controller.signal);
    controller.signal.throwIfAborted();
    port.postMessage(buildJobDefinitionPreviewPage(snapshot, continuation));
  } catch {
    port.postMessage({ status: 'unavailable' });
  } finally {
    port.close();
  }
}
