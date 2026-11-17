/**
 * Project apps routes (docs/specs/project-apps.md §3.3).
 *
 *   POST /work/projects/:key/app-offers                  Bearer      the agent's one suggestion
 *   POST /work/projects/:key/apps/:appRef/answer          owner proof attach | decline | detach
 *                                                         Bearer      withdraw (an open offer only)
 *   POST /work/projects/:key/apps/:appRef/pin-retry       owner proof or Bearer  retry | update-link | post-again
 *   POST /work/projects/:key/apps/:appRef/opened          any caller of the dashboard  an Open tap, app ref only
 *   GET  /work/projects/apps/stats                        Bearer      counts for the maturation decision
 *
 * Owner proof is the operator session the console holds after the dashboard unlock (or the desktop
 * console's). A plain Bearer is NOT owner proof: the agent holds it. The route decides `by`/`via`
 * from the proof it verified, never from the body.
 */
import type { Request, Response, Router } from 'express';
import type { ProjectAppsRuntime } from './ProjectAppsRuntime.js';
import type { AnswerVia } from '../core/ProjectAppStore.js';

export interface ProjectAppsRouteDeps {
  runtime: () => ProjectAppsRuntime | null;
  /** The feature switch (projectApps.enabled with the Chief of Staff on). */
  enabled: () => boolean;
  bearerOk: (req: Request) => boolean;
  /** The verified owner proof on this request, or null. */
  ownerProof: (req: Request) => { via: AnswerVia; principal?: string } | null;
  /** Clear the Work read cache so the next read shows the change. */
  invalidateWork: () => void;
  log: (entry: Record<string, unknown>) => void;
  opens: () => Array<{ appRef: string; conversationKey: string; at: string }>;
  now?: () => number;
}

const KEY_RE = /^(telegram|app|slack|imessage|whatsapp):[A-Za-z0-9_.:-]{1,128}$/;
const REF_RE = /^(builtin:[a-z0-9-]{1,40}|custom:pa_[0-9a-f]{16})$/;

export function mountProjectAppsRoutes(router: Router, deps: ProjectAppsRouteDeps): void {
  const gate = (res: Response): ProjectAppsRuntime | null => {
    res.set('Cache-Control', 'no-store');
    if (!deps.enabled()) { res.status(503).json({ error: 'project-apps-off', detail: 'Project apps are switched off on this agent.' }); return null; }
    const rt = deps.runtime();
    if (!rt) { res.status(503).json({ error: 'project-apps-starting' }); return null; }
    return rt;
  };
  const params = (req: Request, res: Response): { key: string; ref: string } | null => {
    const key = decodeURIComponent(String(req.params.key ?? ''));
    const ref = decodeURIComponent(String(req.params.appRef ?? ''));
    if (!KEY_RE.test(key)) { res.status(400).json({ error: 'bad-project-key' }); return null; }
    if (req.params.appRef !== undefined && !REF_RE.test(ref)) { res.status(400).json({ error: 'bad-app-ref' }); return null; }
    return { key, ref };
  };
  const send = (res: Response, r: { ok: true } | { ok: false; status: number; error: string; detail?: string }, extra: Record<string, unknown> = {}) => {
    if (r.ok) { deps.invalidateWork(); res.json({ ok: true, ...extra, ...(r as Record<string, unknown>) }); return; }
    res.status(r.status).json({ error: r.error, ...(r.detail ? { detail: r.detail } : {}) });
  };

  router.post('/work/projects/:key/app-offers', (req, res) => {
    const rt = gate(res); if (!rt) return;
    if (!deps.bearerOk(req)) { res.status(403).json({ error: 'agent-only' }); return; }
    const p = params(req, res); if (!p) return;
    const body = (req.body ?? {}) as { appRef?: unknown; why?: unknown };
    const ref = String(body.appRef ?? '');
    if (!REF_RE.test(ref)) { res.status(400).json({ error: 'bad-app-ref' }); return; }
    send(res, rt.offer(p.key, ref, String(body.why ?? '')));
  });

  router.post('/work/projects/:key/apps/:appRef/answer', (req, res) => {
    const rt = gate(res); if (!rt) return;
    const p = params(req, res); if (!p) return;
    const body = (req.body ?? {}) as { answer?: unknown; requestId?: unknown };
    const answer = String(body.answer ?? '');
    const requestId = typeof body.requestId === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(body.requestId) ? body.requestId : undefined;
    const owner = deps.ownerProof(req);
    if (owner) { send(res, rt.answer(p.key, p.ref, answer, { by: 'owner', ...owner }, requestId)); return; }
    if (deps.bearerOk(req)) {
      if (answer !== 'withdraw') { res.status(403).json({ error: 'owner-proof-required', detail: 'Only the owner can attach, decline or remove an app. Unlock the dashboard and tap it there.' }); return; }
      send(res, rt.answer(p.key, p.ref, answer, { by: 'agent', via: 'bearer' }, requestId));
      return;
    }
    res.status(401).json({ error: 'unauthorized' });
  });

  router.post('/work/projects/:key/apps/:appRef/pin-retry', (req, res) => {
    const rt = gate(res); if (!rt) return;
    const p = params(req, res); if (!p) return;
    if (!deps.ownerProof(req) && !deps.bearerOk(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const action = String(((req.body ?? {}) as { action?: unknown }).action ?? 'retry');
    if (action !== 'retry' && action !== 'update-link' && action !== 'post-again') { res.status(400).json({ error: 'bad-action' }); return; }
    send(res, rt.requestPinAct(p.key, p.ref, action));
  });

  router.post('/work/projects/:key/apps/:appRef/opened', (req, res) => {
    const rt = gate(res); if (!rt) return;
    const p = params(req, res); if (!p) return;
    rt.recordOpen(p.key, p.ref);
    res.json({ ok: true });
  });

  router.get('/work/projects/apps/stats', (req, res) => {
    const rt = gate(res); if (!rt) return;
    if (!deps.bearerOk(req) && !deps.ownerProof(req)) { res.status(403).json({ error: 'forbidden' }); return; }
    res.json(rt.stats(deps.opens()));
  });
}
