import { Router, type Request, type Response } from 'express';
import { compareProjectLists, type AuthorizedProjectListSnapshot } from '../core/ProjectListComparison.js';

type ComparisonView = 'differences' | 'matches' | 'all';
type VerifiedRead = {
  snapshot: AuthorizedProjectListSnapshot;
  /** This must synchronously prove current authority, access and erasure for this exact projection. */
  release(): boolean;
};

export interface ProjectComparisonSource {
  /** The promise must remain pending until any spawned worker exits, including after abort. */
  read(signal: AbortSignal): Promise<VerifiedRead | null>;
}

export interface ProjectComparisonSources {
  projects?: ProjectComparisonSource;
  chiefOfStaff?: ProjectComparisonSource;
}

interface ProjectComparisonRouteOptions {
  enabled(): boolean;
  mayReadPrivateWork(req: Request, res: Response): boolean;
  sources: ProjectComparisonSources;
  providerCutoffMs?: number;
  responseDeadlineMs?: number;
}

const MAX_ROWS = 150;
const MAX_BYTES = 128 * 1024;
const DEFAULT_PROVIDER_CUTOFF_MS = 1_500;
const DEFAULT_RESPONSE_DEADLINE_MS = 2_000;

function viewOf(req: Request): ComparisonView | null {
  if (req.get('Transfer-Encoding') || !['0', undefined].includes(req.get('Content-Length'))) return null;
  const entries = [...new URL(req.originalUrl, 'http://project-comparison.local').searchParams];
  if (!entries.length) return 'differences';
  if (entries.length !== 1 || entries[0][0] !== 'view') return null;
  const value = entries[0][1];
  return value === 'differences' || value === 'matches' || value === 'all' ? value : null;
}

function observe(source: ProjectComparisonSource | undefined, cutoffMs: number, cancellation: AbortSignal) {
  if (!source) return { answer: Promise.resolve(null), exited: Promise.resolve() };
  const controller = new AbortController();
  const cutoffAt = performance.now() + cutoffMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stop = () => {};
  const exit = Promise.resolve()
    .then(() => controller.signal.aborted ? null : source.read(controller.signal))
    .catch(() => null); // A failed private source contributes no details or absence claim.
  const answer = new Promise<VerifiedRead | null>(resolve => {
    const finish = (value: VerifiedRead | null) => {
      if (timer) clearTimeout(timer);
      cancellation.removeEventListener('abort', stop);
      resolve(value);
    };
    stop = () => { controller.abort(); finish(null); };
    if (cancellation.aborted) { stop(); return; }
    cancellation.addEventListener('abort', stop, { once: true });
    timer = setTimeout(stop, cutoffMs);
    timer.unref();
    void exit.then(value => finish(performance.now() < cutoffAt ? value : null));
  });
  return { answer, exited: exit.then(() => undefined) };
}

function release(read: VerifiedRead | null): AuthorizedProjectListSnapshot | undefined {
  try {
    return read?.release() === true ? read.snapshot : undefined;
  } catch {
    return undefined; // A failed synchronous freshness proof withholds this source.
  }
}

export function createProjectListComparisonRouter(options: ProjectComparisonRouteOptions): Router {
  const providerCutoffMs = options.providerCutoffMs ?? DEFAULT_PROVIDER_CUTOFF_MS;
  const responseDeadlineMs = options.responseDeadlineMs ?? DEFAULT_RESPONSE_DEADLINE_MS;
  if (!Number.isFinite(providerCutoffMs) || !Number.isFinite(responseDeadlineMs)
    || providerCutoffMs <= 0 || providerCutoffMs >= responseDeadlineMs) {
    throw new RangeError('Project comparison must reserve time to release its response');
  }
  const router = Router();
  let busy = false;
  const unavailable = (res: Response, view: ComparisonView) => res.status(503).json(compareProjectLists({
    view, observedAt: new Date().toISOString(), maxRows: MAX_ROWS, maxBytes: MAX_BYTES,
  }));

  // Advertise only the current scoped door. HEAD never takes the comparison
  // slot or enters either source, including Express's implicit HEAD fallback.
  router.head('/work/projects/compare', (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!options.mayReadPrivateWork(req, res)) { res.status(403).end(); return; }
    if (req.originalUrl.includes('?') || !viewOf(req)) { res.status(400).end(); return; }
    res.status(options.enabled() ? 204 : 503).end();
  });

  router.get('/work/projects/compare', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!options.mayReadPrivateWork(req, res)) {
      res.status(403).json({ error: 'private-work-owner-required' });
      return;
    }
    const view = viewOf(req);
    if (!view) {
      res.status(400).json({ error: 'invalid-project-comparison-request' });
      return;
    }
    if (!options.enabled()) { unavailable(res, view); return; }
    if (busy) {
      res.set('Retry-After', '1').status(429).json({ error: 'project-comparison-busy' });
      return;
    }
    busy = true;
    const startedAt = performance.now();
    const cancellation = new AbortController();
    const cancel = () => cancellation.abort();
    res.once('close', cancel);
    const projects = observe(options.sources.projects, providerCutoffMs, cancellation.signal);
    const chiefOfStaff = observe(options.sources.chiefOfStaff, providerCutoffMs, cancellation.signal);
    void Promise.all([projects.exited, chiefOfStaff.exited]).then(() => { busy = false; });
    try {
      const [projectRead, staffRead] = await Promise.all([projects.answer, chiefOfStaff.answer]);
      if (cancellation.signal.aborted || res.destroyed) return;
      if (!options.mayReadPrivateWork(req, res)) {
        res.status(403).json({ error: 'private-work-owner-required' });
        return;
      }
      if (!options.enabled() || performance.now() - startedAt >= responseDeadlineMs) {
        unavailable(res, view);
        return;
      }
      // No await from the source proofs through serialization.
      const result = compareProjectLists({
        projects: release(projectRead), chiefOfStaff: release(staffRead),
        view, observedAt: new Date().toISOString(), maxRows: MAX_ROWS, maxBytes: MAX_BYTES,
      });
      if (performance.now() - startedAt >= responseDeadlineMs) { unavailable(res, view); return; }
      res.status(result.status === 'unavailable' ? 503 : 200).json(result);
    } catch {
      if (!res.headersSent && !res.destroyed) unavailable(res, view);
    } finally {
      res.removeListener('close', cancel);
    }
  });
  return router;
}
