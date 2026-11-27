/**
 * Helper routes (docs/specs/local-verify-borrowed-unit-slices.md, B "What the helper service builds"):
 *
 *   POST /local-verify/helper-slice          a signed slice (queued and answered at once with its id), or `prepare: true`
 *   POST /local-verify/helper-slice/cancel   a signed cancel: of named slices, or of one run's work (`verifyOver` releases its tree)
 *   POST /local-verify/helper-learned        signed comparison results, keyed by tree hash (the pinned requester only)
 *   GET  /local-verify/helper-status         the SIGNED status: state, prepared trees, containment, the queue, the running
 *                                            slice's signed progress, finished slices' signed answers
 *                                            (?run=<runAttemptId>&since=<seq>), the learned list, and per lane the
 *                                            files this helper has been compared on (?compared=<lane> for the list)
 *   POST /local-verify/helper-pause          { paused } the owner's pause toggle (dashboard / phone)
 *
 * All answer 404 while the helper role is disabled (absent or malformed setting). Requests through
 * the Cloudflare tunnel (`cf-connecting-ip`) are refused on the signed routes: they are served on
 * the Tailscale or LAN interface only. The pause toggle is the owner's and stays reachable from
 * the phone; pausing is always the safe direction.
 */
import type { Request, Response, Router } from 'express';
import type { HelperService, HelperStatusQuery } from './HelperService.js';
import { arrivalOf } from '../../core/requestArrival.js';
import { routeRefusal, type RouteFacts } from './admission.js';
import { HELPER_ID_RE, HELPER_LANES, type HelperLane } from './helperProtocol.js';

/** The status request's query, strictly: a malformed value is ignored, never guessed at. */
export function parseStatusQuery(q: Record<string, unknown>): HelperStatusQuery {
  const out: HelperStatusQuery = {};
  if (typeof q.run === 'string' && HELPER_ID_RE.test(q.run)) out.runAttemptId = q.run;
  if (typeof q.since === 'string' && /^\d{1,15}$/.test(q.since)) out.sinceSeq = Number(q.since);
  if (typeof q.compared === 'string' && (HELPER_LANES as readonly string[]).includes(q.compared)) out.comparedLane = q.compared as HelperLane;
  return out;
}

export interface HelperRouteDeps {
  helper: () => HelperService | null;
}

function facts(req: Request): RouteFacts {
  const arrival = arrivalOf(req);
  const listenerAddress = req.socket?.localAddress;
  return { arrival, cfConnectingIp: req.headers['cf-connecting-ip'], listenerAddress };
}

export function registerHelperRoutes(router: Router, deps: HelperRouteDeps): void {
  const gate = (res: Response): HelperService | null => {
    let svc: HelperService | null = null;
    try { svc = deps.helper(); } catch { svc = null; } // @silent-fallback-ok: an unreadable helper setting is the disabled role (404)
    if (!svc || !svc.enabled()) { res.status(404).json({ error: 'not found' }); return null; }
    return svc;
  };
  const send = (res: Response, a: { status: number; body: unknown }) => { res.status(a.status).json(a.body); };

  router.post('/local-verify/helper-slice', async (req: Request, res: Response) => {
    const svc = gate(res);
    if (!svc) return;
    try { send(res, await svc.handleSlice(req.body, facts(req))); }
    catch (e) { res.status(500).json({ state: 'refused', reason: 'helper-error', detail: String(e instanceof Error ? e.message : e).slice(0, 200) }); }
  });

  router.post('/local-verify/helper-slice/cancel', async (req: Request, res: Response) => {
    const svc = gate(res);
    if (!svc) return;
    try { send(res, await svc.handleCancel(req.body, facts(req))); }
    catch (e) { res.status(500).json({ error: 'helper-error', detail: String(e instanceof Error ? e.message : e).slice(0, 200) }); }
  });

  router.post('/local-verify/helper-learned', async (req: Request, res: Response) => {
    const svc = gate(res);
    if (!svc) return;
    try { send(res, await svc.handleLearned(req.body, facts(req))); }
    catch (e) { res.status(500).json({ error: 'helper-error', detail: String(e instanceof Error ? e.message : e).slice(0, 200) }); }
  });

  router.get('/local-verify/helper-status', (req: Request, res: Response) => {
    const svc = gate(res);
    if (!svc) return;
    if (routeRefusal(facts(req), { allowLoopback: true })) { res.status(403).json({ error: 'tunnel' }); return; }
    res.json(svc.status(parseStatusQuery(req.query as Record<string, unknown>)));
  });

  router.post('/local-verify/helper-pause', async (req: Request, res: Response) => {
    const svc = gate(res);
    if (!svc) return;
    const b = req.body as { paused?: unknown } | null;
    if (!b || typeof b !== 'object' || typeof b.paused !== 'boolean' || Object.keys(b).length !== 1) {
      res.status(400).json({ error: 'body must be exactly {"paused": true|false}' });
      return;
    }
    await svc.setPaused(b.paused, 'dashboard');
    res.json({ paused: svc.paused() });
  });
}
