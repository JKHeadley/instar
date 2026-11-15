/**
 * Conversations suggestion routes (docs/specs/conversation-graph-suggestions.md §3). Owner only,
 * dashboard surface (the operator-session proof). Advice only: none of these writes a graph event.
 *
 *   GET  /conversation-graph/suggestions               the offerable suggestions (starts a stale build)
 *   POST /conversation-graph/suggestions/refresh       ask for a fresh build (rate-bounded)
 *   POST /conversation-graph/suggestions/:id/start     the one create request id for this Accept
 *   POST /conversation-graph/suggestions/:id/reject    never offer this grouping again
 *   POST /conversation-graph/suggestions/:id/accepted  the dashboard finished every owner change
 */
import { Router, type Request, type Response } from 'express';
import type { ConversationGraphReadModel, GraphViewer } from '../core/conversationGraphRead.js';
import type { ConversationGraphSuggestionService } from './ConversationGraphSuggestionService.js';

export function createConversationGraphSuggestionRouter(deps: {
  model: ConversationGraphReadModel;
  service: ConversationGraphSuggestionService;
  resolveViewer(req: Request, surface: 'dashboard' | 'mobile'): GraphViewer | null;
}): Router {
  const router = Router();
  const prefix = '/conversation-graph/suggestions';
  const owner = (req: Request, res: Response): GraphViewer | null => {
    res.setHeader('Cache-Control', 'no-store');
    const viewer = deps.resolveViewer(req, 'dashboard');
    if (!viewer) { res.status(403).json({ code: 'hierarchy-owner-only' }); return null; }
    return viewer;
  };
  const validId = (id: unknown): id is string => typeof id === 'string' && /^sg-[0-9a-f]{20}$/.test(id);

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

  router.post(`${prefix}/:id/start`, (req, res) => {
    const viewer = owner(req, res); if (!viewer) return;
    if (!validId(req.params.id)) return void res.status(400).json({ code: 'invalid-suggestion-id' });
    const started = deps.service.beginAccept(req.params.id);
    if (!started) return void res.status(404).json({ code: 'unknown-suggestion' });
    res.json({ id: req.params.id, ...started });
  });

  for (const action of ['reject', 'accepted'] as const) {
    router.post(`${prefix}/:id/${action}`, (req, res) => {
      const viewer = owner(req, res); if (!viewer) return;
      if (!validId(req.params.id)) return void res.status(400).json({ code: 'invalid-suggestion-id' });
      const ok = action === 'reject' ? deps.service.reject(req.params.id) : deps.service.accepted(req.params.id);
      if (!ok) return void res.status(404).json({ code: 'unknown-suggestion' });
      res.json({ ok: true, id: req.params.id, state: action === 'reject' ? 'rejected' : 'accepted' });
    });
  }
  return router;
}
