/**
 * Helper routes (docs/specs/local-verify-borrowed-unit-slices.md, B "What the helper service builds"):
 *
 *   POST /local-verify/helper-slice          a signed slice (or `prepare: true`, or `retrial: true`)
 *   POST /local-verify/helper-slice/cancel   a signed cancel of one run's work (stops it; deletes its trees)
 *   POST /local-verify/helper-learned        signed learned-list observations (pinned requesters only)
 *   GET  /local-verify/helper-status         state, prepared trees, containment, the learned list
 *   POST /local-verify/helper-pause          { paused } the owner's pause toggle (dashboard / phone)
 *
 * All answer 404 while the helper role is disabled (absent or malformed setting). Requests through
 * the Cloudflare tunnel (`cf-connecting-ip`) are refused on the signed routes: they are served on
 * the Tailscale or LAN interface only. The pause toggle is the owner's and stays reachable from
 * the phone; pausing is always the safe direction.
 */
import type { Request, Response, Router } from 'express';
import type { HelperService } from './HelperService.js';
import { routeRefusal } from './admission.js';

export interface HelperRouteDeps {
  helper: () => HelperService | null;
}

function facts(req: Request): { cfConnectingIp: string | string[] | undefined; localAddress: string | undefined } {
  return { cfConnectingIp: req.headers['cf-connecting-ip'], localAddress: req.socket?.localAddress };
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
    res.json(svc.status());
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
