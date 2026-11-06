/**
 * Routes of the attribution paper trail. docs/specs/attribution-paper-trail.md.
 * Mounted from createRoutes; Bearer auth comes from the server's usual middleware. All 503 when the
 * feature is off, so an older hook or a peer reads that as "not here", never as absence.
 */
import { Router, type Request, type RequestHandler } from 'express';
import type { AttributionRuntime } from '../core/attribution/attributionRuntime.js';
import type { AttributionSurface } from '../core/attribution/AttributionLedger.js';
import { isInScope, realpathLoose } from '../core/attribution/attributionScope.js';
import { parseMarkers, SOURCE_CHANNELS, type SourceChannel, type SourceRef } from '../core/attribution/marker.js';

const SURFACES: AttributionSurface[] = ['note-write', 'send', 'threadline', 'memory-route', 'audit'];

function refFromQuery(req: Request): SourceRef | { error: string } | null {
  const { marker, channel, conversation, message, date } = req.query;
  if (typeof marker === 'string') {
    const parsed = parseMarkers(marker);
    return parsed.markers[0]?.ref ?? { error: 'marker does not parse' };
  }
  if (typeof channel !== 'string' && typeof conversation !== 'string') return null;
  if (typeof channel !== 'string' || !(SOURCE_CHANNELS as readonly string[]).includes(channel)) return { error: 'unknown channel' };
  if (typeof conversation !== 'string' || typeof message !== 'string' || typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { error: 'channel, conversation, message and date are required' };
  }
  return { channel: channel as SourceChannel, conversation, message, date };
}

function isError(value: unknown): value is { error: string } {
  return !!value && typeof value === 'object' && 'error' in value;
}

/**
 * Express 4 does not catch a rejected async handler, and an unhandled rejection can take the server
 * down. Any failure here answers 500, which the hook reads as a pass.
 */
function safely(handler: RequestHandler): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch((err: unknown) => {
      if (res.headersSent) { res.end(); return; }
      res.status(500).json({ error: 'attribution-route-failed', detail: err instanceof Error ? err.message : String(err) });
    });
  };
}

export function createAttributionRoutes(runtime: () => AttributionRuntime | null | undefined): Router {
  const router = Router();

  router.use('/attribution', (_req, res, next) => {
    const live = runtime();
    if (!live || !live.enabled) {
      res.status(503).json({ error: 'attribution-disabled', enabled: false });
      return;
    }
    next();
  });

  router.post('/attribution/check', safely(async (req, res) => {
    const live = runtime()!;
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.toolName === 'string') {
      const input = body.toolInput && typeof body.toolInput === 'object' ? (body.toolInput as Record<string, unknown>) : {};
      const answer = await live.checkWrite({ toolName: body.toolName, toolInput: input });
      res.status(answer.status === 'recording' ? 202 : 200).json(answer);
      return;
    }
    if (typeof body.text !== 'string' || !body.text.trim()) {
      res.status(400).json({ error: 'text or toolName is required' });
      return;
    }
    if (body.text.length > 256_000) {
      res.status(413).json({ error: 'text is too long' });
      return;
    }
    const surface = SURFACES.includes(body.surface as AttributionSurface) ? (body.surface as AttributionSurface) : 'note-write';
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = live.checkText(body.text, {
      surface,
      path: typeof body.path === 'string' ? body.path : undefined,
      recentConversation: typeof body.recentConversation === 'string' ? body.recentConversation : undefined,
      enforced: false,
    });
    const timeout = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), live.routeBudgetMs); });
    const outcome = await Promise.race([check, timeout]).catch((err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }));
    if (timer) clearTimeout(timer);
    if (outcome === 'timeout') {
      live.budget.count('hookTimeouts');
      void check.catch(() => {});
      res.json({ verdict: 'timeout', findings: [], malformed: [] });
      return;
    }
    if ('error' in outcome) {
      res.status(500).json({ error: 'check-failed', detail: outcome.error });
      return;
    }
    const { written: _written, ...result } = outcome;
    res.json(result);
  }));

  router.get('/attribution/resolve', safely(async (req, res) => {
    const live = runtime()!;
    const ref = refFromQuery(req);
    if (!ref || isError(ref)) {
      res.status(400).json({ error: ref?.error ?? 'marker or channel, conversation, message and date are required' });
      return;
    }
    // A local answer never fans out, so peers asking each other cannot recurse.
    if (req.query.scope === 'local') {
      res.json(await live.resolveLocal(ref));
      return;
    }
    res.json(await live.resolve(ref));
  }));

  router.get('/attribution/find', safely(async (req, res) => {
    const live = runtime()!;
    const { person, claim, date, topicId, scope } = req.query;
    if (typeof person !== 'string' || typeof claim !== 'string' || !person.trim() || !claim.trim()) {
      res.status(400).json({ error: 'person and claim are required' });
      return;
    }
    const around = {
      ...(typeof date === 'string' ? { date } : {}),
      ...(typeof topicId === 'string' && /^-?\d+$/.test(topicId) ? { topicId: Number(topicId) } : {}),
    };
    if (scope === 'local') {
      res.json({ candidates: await live.findLocal({ person, claim, around }) });
      return;
    }
    res.json(await live.find({ person, claim, around }));
  }));

  router.get('/attribution/trace', safely(async (req, res) => {
    const live = runtime()!;
    const ref = refFromQuery(req);
    if (isError(ref)) {
      res.status(400).json({ error: ref.error });
      return;
    }
    const claim = typeof req.query.claim === 'string' ? req.query.claim : undefined;
    const q = typeof req.query.q === 'string' ? req.query.q : undefined;
    if (!claim && !q && !ref) {
      res.status(400).json({ error: 'claim, ref or q is required' });
      return;
    }
    const includeArchives = req.query.archives === '1';
    if (req.query.scope === 'local') {
      res.json({ rows: live.traceLocal({ claim, q, ref: ref ?? undefined, includeArchives }).slice(-500) });
      return;
    }
    const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined;
    res.json(await live.trace({
      claim, q, ref: ref ?? undefined, includeArchives,
      cursor: typeof req.query.cursor === 'string' ? req.query.cursor : undefined,
      limit: limit !== undefined && Number.isFinite(limit) && limit > 0 ? limit : undefined,
    }));
  }));

  router.get('/attribution/status', (_req, res) => {
    res.json(runtime()!.status());
  });

  router.post('/attribution/audit', safely(async (req, res) => {
    const live = runtime()!;
    const paths = (req.body as { paths?: unknown } | undefined)?.paths;
    let files: string[] | undefined;
    if (paths !== undefined) {
      if (!Array.isArray(paths) || paths.some((p) => typeof p !== 'string')) {
        res.status(400).json({ error: 'paths must be a list of file paths' });
        return;
      }
      // Realpath-confined: a link out of scope, or a path outside it, is refused by name.
      const outside = (paths as string[]).filter((p) => !isInScope(p, live.scope()));
      if (outside.length) {
        res.status(400).json({ error: 'path-out-of-scope', paths: outside });
        return;
      }
      files = (paths as string[]).map(realpathLoose);
    }
    const report = await live.runAudit(files);
    res.json({ report });
  }));

  return router;
}
