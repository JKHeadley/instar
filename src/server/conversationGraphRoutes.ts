/**
 * Conversations hierarchy read routes (docs/specs/conversation-effort-hierarchy-v3.md §7.1–7.5).
 *
 *   GET /conversation-graph/roots?view=overview|all&q=&cursor=
 *   GET /conversation-graph/nodes/:ref?cursor=         (:ref = base64url canonical JSON NodeRef)
 *   GET /mobile/conversation-graph/roots …              (same bodies; device-signed)
 *   GET /mobile/conversation-graph/nodes/:ref …
 *
 * Owner-only in v1. The caller supplies `resolveViewer`, which turns an authenticated request into
 * the owner's GraphViewer (dashboard owner proof, or a device signature resolved to the owner) or
 * null — and null is 403 `hierarchy-owner-only`, never a narrower view. This module never decides
 * who the viewer is, and never reads graph state except through the read model.
 *
 * Readiness comes from the read model's source (the increment-A proof runtime): until it is ready
 * every request is 503. Mounting this router does not make the feature available.
 *
 * E2E-PAIRING: EXEMPT — this router is not mounted by AgentServer in this change, so no production
 * path exists to exercise; the runtime owner adds the mount, the device allowlist and capability
 * entries, and the alive e2e test together (Echo topic 137342). Route behaviour is covered over HTTP
 * by tests/unit/conversation-graph-read.test.ts.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { decodeRouteRef } from '../core/conversationGraph.js';
import type { ConversationGraphReadModel, GraphViewer, ReadResult } from '../core/conversationGraphRead.js';

export interface ConversationGraphRouteDeps {
  model: ConversationGraphReadModel;
  /** The owner's viewer for this request, or null (not the owner, or not authenticated as such). */
  resolveViewer: (req: Request, surface: 'dashboard' | 'mobile') => GraphViewer | null;
}

function send(res: Response, r: ReadResult): void {
  res.status(r.status).json(r.body);
}

/**
 * A query value: absent → null; one string within bounds → the string; anything else (repeated,
 * array, object, too long) → 'invalid'. Invalid values are refused, never treated as absent.
 */
function param(v: unknown, max: number): string | null | 'invalid' {
  if (v === undefined) return null;
  return typeof v === 'string' && v.length <= max ? v : 'invalid';
}

export function createConversationGraphRouter(deps: ConversationGraphRouteDeps): Router {
  const router = Router();

  for (const [prefix, surface] of [['/conversation-graph', 'dashboard'], ['/mobile/conversation-graph', 'mobile']] as const) {
    router.get(`${prefix}/roots`, (req: Request, res: Response) => {
      const viewer = deps.resolveViewer(req, surface);
      if (!viewer) return void res.status(403).json({ code: 'hierarchy-owner-only' });
      const view = req.query.view === 'all' ? 'all' : req.query.view === undefined || req.query.view === 'overview' ? 'overview' : null;
      if (!view) return void res.status(400).json({ code: 'invalid-view' });
      const q = param(req.query.q, 200);
      if (q === 'invalid') return void res.status(400).json({ code: 'invalid-query' });
      const cursor = param(req.query.cursor, 200);
      if (cursor === 'invalid') return void res.status(409).json({ code: 'cursor-stale', reason: 'cursor-invalid' });
      send(res, deps.model.roots(viewer, { view, q, cursor }));
    });

    router.get(`${prefix}/nodes/:ref`, (req: Request, res: Response) => {
      const viewer = deps.resolveViewer(req, surface);
      if (!viewer) return void res.status(403).json({ code: 'hierarchy-owner-only' });
      const ref = decodeRouteRef(req.params.ref);
      if (!ref) return void res.status(404).json({ code: 'not-found' });
      const cursor = param(req.query.cursor, 200);
      if (cursor === 'invalid') return void res.status(409).json({ code: 'cursor-stale', reason: 'cursor-invalid' });
      send(res, deps.model.node(viewer, ref, { cursor }));
    });
  }

  return router;
}
