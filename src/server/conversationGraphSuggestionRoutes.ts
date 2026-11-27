/**
 * Conversations suggestion routes (docs/specs/conversation-graph-suggestions.md §3,
 * docs/specs/conversation-groups-phone.md §2). Owner only. The dashboard surface takes the operator-session
 * proof; the /mobile surface takes the owner phone's device signature (route allowlist in
 * mobilePairingRoutes.ts). Suggestions are advice: only Accept writes graph events, and it runs the ordinary
 * owner changes with the caller's own request.
 *
 *   GET  {prefix}/suggestions               the offerable suggestions (starts a stale build)
 *   POST {prefix}/suggestions/refresh       ask for a fresh build (rate-bounded)
 *   POST {prefix}/suggestions/:id/accept    group them: the whole Accept in one call (resumable)
 *   POST {prefix}/suggestions/:id/reject    never offer this grouping again
 *   POST /conversation-graph/suggestions/:id/start|accepted  (dashboard pages loaded before the one-call Accept)
 *        compatibility: /start answers the same derived create id, so an old page and the one call make ONE group.
 *
 * {prefix} is /conversation-graph (dashboard) or /mobile/conversation-graph (owner phone).
 */
import { Router, type Request, type Response } from 'express';
import type { ConversationGraphReadModel, GraphViewer } from '../core/conversationGraphRead.js';
import type { ConversationGraphSuggestionService } from './ConversationGraphSuggestionService.js';
import type { ConversationGraphOwnerChanges } from './ConversationGraphOwnerChanges.js';
import { runSuggestionAccept, suggestionAcceptPort, type SuggestionAcceptOptions, type SuggestionAcceptStep } from './ConversationGraphSuggestionAccept.js';

export function createConversationGraphSuggestionRouter(deps: {
  model: ConversationGraphReadModel;
  service: ConversationGraphSuggestionService;
  resolveViewer(req: Request, surface: 'dashboard' | 'mobile'): GraphViewer | null;
  /** The owner change pipeline Accept runs through. Absent ⇒ Accept answers 503 (older compositions). */
  changes?: ConversationGraphOwnerChanges;
  acceptOptions?: SuggestionAcceptOptions;
}): Router {
  const router = Router();
  const validId = (id: unknown): id is string => typeof id === 'string' && /^sg-[0-9a-f]{20}$/.test(id);
  // One Accept at a time per suggestion on this machine: a second call while one runs answers `working`.
  // An entry older than the call budget plus a margin is treated as gone, so a wait that never returns
  // cannot hold the suggestion forever (the request ids are derived, so a second runner is harmless anyway).
  const running = new Map<string, { step: SuggestionAcceptStep; at: number }>();
  const lockMs = (deps.acceptOptions?.budgetMs ?? 15_000) + 30_000;
  const busyWith = (id: string) => { const b = running.get(id); return b && Date.now() - b.at < lockMs ? b : null; };

  for (const [base, surface] of [['/conversation-graph', 'dashboard'], ['/mobile/conversation-graph', 'mobile']] as const) {
    const prefix = `${base}/suggestions`;
    const owner = (req: Request, res: Response): GraphViewer | null => {
      res.setHeader('Cache-Control', 'no-store');
      const viewer = deps.resolveViewer(req, surface);
      if (!viewer) { res.status(403).json({ code: 'hierarchy-owner-only' }); return null; }
      return viewer;
    };
    /** The owner proof is re-read before any answer leaves: a phone revoked mid-request gets nothing. */
    const stillOwner = (req: Request, viewer: GraphViewer): boolean => {
      const current = deps.resolveViewer(req, surface);
      return current !== null && current.principalKey === viewer.principalKey && current.grantVersion === viewer.grantVersion;
    };

    router.get(prefix, (req, res) => {
      const viewer = owner(req, res); if (!viewer) return;
      const unassigned = deps.model.unassignedConversations(viewer);
      if (!unassigned) return void res.status(503).json({ code: 'conversation-graph-pending' });
      res.json(deps.service.view(unassigned));
    });

    router.post(`${prefix}/refresh`, (req, res) => {
      const viewer = owner(req, res); if (!viewer) return;
      const unassigned = deps.model.unassignedConversations(viewer);
      if (!unassigned) return void res.status(503).json({ code: 'conversation-graph-pending' });
      const result = deps.service.refresh(unassigned);
      res.status(result.started ? 202 : result.reason === 'model-unavailable' ? 503 : 429).json(result);
    });

    router.post(`${prefix}/:id/accept`, async (req, res) => {
      const viewer = owner(req, res); if (!viewer) return;
      const id = req.params.id;
      if (!validId(id)) return void res.status(400).json({ code: 'invalid-suggestion-id' });
      if (!deps.changes) return void res.status(503).json({ code: 'conversation-graph-changes-off' });
      const busy = busyWith(id);
      if (busy) return void res.status(202).json({ id, state: 'working', step: busy.step, text: 'This group is already being made. Check again in a moment.', waitingMachines: [], agentNotAnswering: false, retryAfterMs: 3000 });
      const marker = { step: 'checking' as SuggestionAcceptStep, at: Date.now() };
      running.set(id, marker);
      let out;
      try {
        out = await runSuggestionAccept(id, deps.service, suggestionAcceptPort({ model: deps.model, changes: deps.changes, resolveViewer: deps.resolveViewer }, req, surface), deps.acceptOptions);
      } finally { if (running.get(id) === marker) running.delete(id); }
      // A request queued behind a long pass may already have been answered 408; the next call resumes.
      if (res.headersSent) return;
      if (out.kind === 'not-owner' || !stillOwner(req, viewer)) return void res.status(403).json({ code: 'hierarchy-owner-only' });
      if (out.kind === 'unknown') return void res.status(404).json({ code: 'unknown-suggestion' });
      if (out.kind === 'accepted') return void res.json({ id, state: 'accepted', group: out.group, moved: out.moved, skipped: out.skipped, placedElsewhere: out.placedElsewhere });
      // `next` is read from the server's own state, so a client never guesses from codes: the suggestion is closed
      // (finished), the Accept was handed back so Accept again and Reject both work, or its progress is kept (continue).
      if (out.kind === 'refused') {
        const next = out.code === 'group-gone' ? 'finished' : deps.service.acceptStarted(id) ? 'continue' : 'accept-or-reject';
        return void res.status(409).json({ id, state: 'refused', step: out.step, code: out.code, text: out.text, next });
      }
      res.status(202).json({ id, state: 'working', step: out.step, text: out.text, waitingMachines: out.waitingMachines, agentNotAnswering: out.agentNotAnswering, retryAfterMs: 3000 });
    });

    router.post(`${prefix}/:id/reject`, (req, res) => {
      const viewer = owner(req, res); if (!viewer) return;
      const id = req.params.id;
      if (!validId(id)) return void res.status(400).json({ code: 'invalid-suggestion-id' });
      // Once an Accept has sent its create, the group may exist: rejecting now could leave it half-filled.
      if (busyWith(id) || deps.service.acceptStarted(id)) return void res.status(409).json({ code: 'accept-started', text: 'This group is already being made. Tap Continue to finish it.' });
      if (!deps.service.reject(id)) return void res.status(404).json({ code: 'unknown-suggestion' });
      res.json({ ok: true, id, state: 'rejected' });
    });
  }

  // Compatibility for dashboard pages loaded before the one-call Accept (they run the steps themselves). The create
  // id they get is the same derived id the server uses, so an old page and the one call still make ONE group.
  const dashboardOwner = (req: Request, res: Response): GraphViewer | null => {
    res.setHeader('Cache-Control', 'no-store');
    const viewer = deps.resolveViewer(req, 'dashboard');
    if (!viewer) { res.status(403).json({ code: 'hierarchy-owner-only' }); return null; }
    return viewer;
  };
  router.post('/conversation-graph/suggestions/:id/start', (req, res) => {
    const viewer = dashboardOwner(req, res); if (!viewer) return;
    if (!validId(req.params.id)) return void res.status(400).json({ code: 'invalid-suggestion-id' });
    const started = deps.service.beginAccept(req.params.id);
    if (!started) return void res.status(404).json({ code: 'unknown-suggestion' });
    res.json({ id: req.params.id, ...started });
  });
  router.post('/conversation-graph/suggestions/:id/accepted', (req, res) => {
    const viewer = dashboardOwner(req, res); if (!viewer) return;
    if (!validId(req.params.id)) return void res.status(400).json({ code: 'invalid-suggestion-id' });
    if (!deps.service.accepted(req.params.id)) return void res.status(404).json({ code: 'unknown-suggestion' });
    res.json({ ok: true, id: req.params.id, state: 'accepted' });
  });
  return router;
}
