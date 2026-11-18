/**
 * Project apps part 2 — the agent's routes for custom apps (docs/specs/project-apps-sandbox.md §3.1, §3.4).
 *
 *   POST /project-apps                    Bearer (the agent)   {conversationKey, title, specPath} → {appId}
 *   PUT  /project-apps/:appId/source      Bearer (the agent)   {html, note} → a new source revision and,
 *                                                               on the lease holder, the app's version card
 *   GET  /project-apps                    Bearer               the apps (no source, no data)
 *
 * The agent's Bearer is NOT an approval: a new version runs only after the owner approves its card
 * on their phone. Off (`projectApps.custom.enabled`) ⇒ every route answers 503.
 */
import type { Request, Response, Router } from 'express';
import type { ProjectAppCustomSource } from './ProjectAppCustomSource.js';
import { APP_ID_RE } from './ProjectAppSandbox.js';

export interface ProjectAppCustomRouteDeps {
  source: () => ProjectAppCustomSource | null;
  enabled: () => boolean;
  bearerOk: (req: Request) => boolean;
  log?: (entry: Record<string, unknown>) => void;
}

export function mountProjectAppCustomRoutes(router: Router, deps: ProjectAppCustomRouteDeps): void {
  const gate = (req: Request, res: Response): ProjectAppCustomSource | null => {
    res.set('Cache-Control', 'no-store');
    if (!deps.enabled()) { res.status(503).json({ error: 'custom-apps-off', detail: 'Custom apps are switched off on this agent.' }); return null; }
    if (!deps.bearerOk(req)) { res.status(403).json({ error: 'agent-only', detail: 'Only the agent writes custom apps.' }); return null; }
    const s = deps.source();
    if (!s) { res.status(503).json({ error: 'custom-apps-starting' }); return null; }
    return s;
  };
  const fail = (res: Response, r: { status: number; error: string; [k: string]: unknown }) => {
    const { ok: _ok, status, ...rest } = r as { ok?: boolean; status: number };
    res.status(status).json(rest);
  };

  router.get('/project-apps', (req, res) => {
    const s = gate(req, res); if (!s) return;
    res.json({ apps: s.apps().map((a) => ({ appId: a.appId, appRef: `custom:${a.appId}`, conversationKey: a.conversationKey, title: a.title, specPath: a.specPath, served: s.servedVersion(a.appId).state })) });
  });

  router.post('/project-apps', (req, res) => {
    const s = gate(req, res); if (!s) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const r = s.createApp({ conversationKey: b.conversationKey, title: b.title, specPath: b.specPath });
    if (!r.ok) { fail(res, r); return; }
    deps.log?.({ event: 'custom-app-created', appId: r.appId });
    res.status(201).json({ appId: r.appId, appRef: `custom:${r.appId}` });
  });

  router.put('/project-apps/:appId/source', (req, res) => {
    const s = gate(req, res); if (!s) return;
    const appId = String(req.params.appId ?? '');
    if (!APP_ID_RE.test(appId)) { res.status(404).json({ error: 'unknown-app' }); return; }
    const b = (req.body ?? {}) as Record<string, unknown>;
    const r = s.writeSource(appId, b.html, b.note);
    if (!r.ok) { fail(res, r); return; }
    res.json(r);
  });
}
