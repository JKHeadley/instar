import path from 'node:path';
import { Router, type Request, type Response } from 'express';
import { JobDefinitionPreviewCursor } from '../scheduler/JobDefinitionPreviewCursor.js';
import type { JobDefinitionPreviewWorker } from '../scheduler/JobDefinitionPreviewWorker.js';

const PATH = '/jobs/reconcile';

function previewParams(req: Request): URLSearchParams {
  return new URL(req.originalUrl, 'http://job-preview.local').searchParams;
}

export function isJobDefinitionPreviewRequest(req: Request): boolean {
  const query = previewParams(req);
  return query.has('preview') || query.has('cursor');
}

interface Options {
  available(): boolean;
  verifyCurrentOwner(req: Request, res: Response): string | null;
  jobsFile(): string | undefined;
  machineId: string;
  worker: Pick<JobDefinitionPreviewWorker, 'read'>;
}

export function createJobDefinitionPreviewRouter(options: Options): Router {
  const router = Router();
  const cursorCodec = new JobDefinitionPreviewCursor();

  router.head(PATH, (req, res, next) => {
    if (!isJobDefinitionPreviewRequest(req)) { next(); return; }
    res.set('Cache-Control', 'no-store').status(405).end();
  });
  router.get(PATH, async (req, res, next) => {
    if (!isJobDefinitionPreviewRequest(req)) { next(); return; }
    res.set('Cache-Control', 'no-store');
    const query = previewParams(req);
    const cursorTokens = query.getAll('cursor');
    const length = req.get('Content-Length');
    if (query.getAll('preview').length !== 1 || query.get('preview') !== 'job-definitions'
      || [...query.keys()].some(key => key !== 'preview' && key !== 'cursor')
      || cursorTokens.length > 1 || cursorTokens[0] === ''
      || req.get('Transfer-Encoding') || (length !== undefined && length !== '0')) {
      res.status(400).json({ error: 'invalid-job-preview-request' });
      return;
    }
    const initialOwner = options.verifyCurrentOwner(req, res);
    if (!initialOwner) { res.status(403).json({ error: 'owner-private-session-required' }); return; }
    const jobsFile = options.jobsFile();
    if (!options.available() || !jobsFile || !path.isAbsolute(jobsFile)) {
      res.status(503).json({ error: 'job-preview-unavailable' });
      return;
    }
    const context = { sessionId: initialOwner, machineId: options.machineId };
    const continuation = cursorTokens.length ? cursorCodec.decode(context, cursorTokens[0]) : undefined;
    if (continuation === null) { res.status(409).json({ error: 'job-preview-restart' }); return; }

    const controller = new AbortController();
    const cancel = () => controller.abort();
    res.once('close', cancel);
    try {
      const result = await options.worker.read({ jobsFile, signal: controller.signal, continuation });
      if (controller.signal.aborted || res.destroyed) return;
      // Check the original authenticated session and the serving definition path again.
      if (options.verifyCurrentOwner(req, res) !== initialOwner) {
        res.status(403).json({ error: 'owner-private-session-required' });
        return;
      }
      if (!options.available() || options.jobsFile() !== jobsFile) {
        res.status(503).json({ error: 'job-preview-unavailable' });
        return;
      }
      if (result.status === 'busy') {
        res.set('Retry-After', '1').status(429).json({ error: 'job-preview-busy' });
      } else if (result.status === 'restart') {
        res.status(409).json({ error: 'job-preview-restart' });
      } else if (result.status === 'unavailable') {
        res.status(503).json({ error: 'job-preview-unavailable' });
      } else {
        const cursor = result.continuation ? cursorCodec.encode(context, result.continuation) : undefined;
        res.json({ ...result.page, schemaVersion: 1, ...(cursor ? { cursor } : {}) });
      }
    } catch {
      if (!res.headersSent && !res.destroyed) res.status(503).json({ error: 'job-preview-unavailable' });
    } finally {
      res.removeListener('close', cancel);
    }
  });
  return router;
}
