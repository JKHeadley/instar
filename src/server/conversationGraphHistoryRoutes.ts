/** Owner-authenticated source history for the Conversations panel.
 * The graph service resolves source identity; callers cannot supply an alias,
 * machine URL, or destination. A remote Slack alias always goes to its holder.
 * Spec: conversation-effort-hierarchy-v3 §4, §6, §7.4.
 */
import { Router, type Request } from 'express';
import { isPeerUrlAllowedForCredentials, type PeerEndpointSelection } from './peerUrlGuard.js';
import { poolPeerFetch, type RopeResultRecorder } from './poolPeerFetch.js';

export interface GraphHistorySource {
  platform: 'telegram' | 'slack' | 'app';
  conversationId: number | string;
  machine?: string | null;
}
export interface ConversationGraphHistoryDeps {
  /** Actual boot/catch-up/witness/member proof, never merely a feature flag. */
  ready(): boolean;
  /** Both ordinary bearer and this machine's live owner operator proof. */
  verifyOwner(req: Request): boolean;
  /** Canonical route ref -> source through the authorized graph projection. */
  resolveSource(routeRef: string, req: Request): Promise<GraphHistorySource | null> | GraphHistorySource | null;
  selfMachineId: string;
  localBaseUrl(): string;
  peers(): Array<{ machineId: string } & PeerEndpointSelection>;
  authToken(): string;
  agentId: string;
  peerHostAllowlist?: readonly string[];
  recordRopeResult?: RopeResultRecorder;
}

export function graphHistoryPath(source: GraphHistorySource, query: { before?: string; beforeMessageId?: string; limit?: string }): string | null {
  const q = new URLSearchParams({ limit: String(Math.max(1, Math.min(100, Number(query.limit) || 50))) });
  if (query.before) q.set('before', query.before);
  if (query.beforeMessageId) q.set('beforeMessageId', query.beforeMessageId);
  if (source.platform === 'telegram' && Number.isSafeInteger(source.conversationId) && Number(source.conversationId) > 0) {
    q.set('scope', 'pool');
    return `/telegram/topics/${source.conversationId}/messages?${q}`;
  }
  if (source.platform === 'slack' && Number.isSafeInteger(source.conversationId) && Number(source.conversationId) < 0 && source.machine) {
    q.set('machine', source.machine);
    return `/mobile/chat/slack/${source.conversationId}/messages?${q}`;
  }
  if (source.platform === 'app' && typeof source.conversationId === 'string' && source.conversationId.length <= 100) {
    q.set('scope', 'pool');
    return `/mobile/chat/app/${encodeURIComponent(source.conversationId)}/messages?${q}`;
  }
  return null;
}

export function createConversationGraphHistoryRoutes(deps: ConversationGraphHistoryDeps): Router {
  const router = Router();
  router.get('/conversation-graph/nodes/:ref/messages', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!deps.verifyOwner(req)) { res.status(403).json({ code: 'hierarchy-owner-only' }); return; }
    if (!deps.ready()) { res.status(503).json({ code: 'conversation-graph-off' }); return; }
    const ref = String(req.params.ref);
    if (!ref || ref.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(ref)) { res.status(404).json({ code: 'conversation-unavailable' }); return; }
    const before = typeof req.query.before === 'string' ? req.query.before : undefined;
    const beforeMessageId = typeof req.query.beforeMessageId === 'string' ? req.query.beforeMessageId : undefined;
    if ((before && before.length > 512) || (beforeMessageId && !/^[1-9]\d{0,15}$/.test(beforeMessageId))) {
      res.status(400).json({ code: 'history-cursor-invalid' }); return;
    }
    try {
      const source = await deps.resolveSource(ref, req);
      if (!source) { res.status(404).json({ code: 'conversation-unavailable' }); return; }
      const path = graphHistoryPath(source, { before, beforeMessageId, limit: typeof req.query.limit === 'string' ? req.query.limit : undefined });
      if (!path) { res.status(404).json({ code: 'conversation-unavailable' }); return; }
      let url = deps.localBaseUrl();
      let peer: ReturnType<ConversationGraphHistoryDeps['peers']>[number] | undefined;
      if (source.platform === 'slack' && source.machine !== deps.selfMachineId) {
        peer = deps.peers().find((p) => p.machineId === source.machine);
        if (!peer || !isPeerUrlAllowedForCredentials(peer, deps.peerHostAllowlist).ok) {
          res.status(502).json({ code: 'history-holder-unavailable' }); return;
        }
        url = peer.url;
      }
      const base = new URL(url);
      // Credentials and attacker-supplied suffixes never come from request data.
      if (base.username || base.password || base.search || base.hash || base.pathname !== '/') {
        res.status(502).json({ code: 'history-holder-unavailable' }); return;
      }
      const options = { headers: { Authorization: `Bearer ${deps.authToken()}`, 'X-Instar-AgentId': deps.agentId },
        signal: AbortSignal.timeout(15000), redirect: 'error' as const };
      // The rope helper can fall through after an awaited failed dial. Recheck
      // the original request's live owner proof before EVERY credentialed hop.
      const stillAdmitted = () => deps.verifyOwner(req) && deps.ready();
      const admittedFetch: typeof fetch = async (input, init) => {
        if (!stillAdmitted()) { const error = new Error('history-admission-expired'); error.name = 'AbortError'; throw error; }
        return fetch(input, init);
      };
      const recordRope: RopeResultRecorder = (...args) => {
        // Owner expiry is not evidence that a network transport failed.
        if (stillAdmitted()) deps.recordRopeResult?.(...args);
      };
      const response = peer ? await poolPeerFetch(recordRope, peer, path, options, admittedFetch)
        : await admittedFetch(base.origin + path, options);
      const reader = response.body?.getReader();
      if (!reader) throw new Error('source-history-unreadable');
      const chunks: Uint8Array[] = []; let bytes = 0;
      while (true) {
        const next = await reader.read(); if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > 4 * 1024 * 1024) { await reader.cancel(); throw new Error('source-history-too-large'); }
        chunks.push(next.value);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      // Recheck expiry and catch-up after the remote read. A grant or boot-state
      // change cannot turn an earlier authorization into a later private reply.
      if (!deps.verifyOwner(req)) { res.status(403).json({ code: 'hierarchy-owner-only' }); return; }
      if (!deps.ready()) { res.status(503).json({ code: 'conversation-graph-off' }); return; }
      const freshSource = await deps.resolveSource(ref, req);
      if (!freshSource || freshSource.platform !== source.platform || freshSource.conversationId !== source.conversationId
          || freshSource.machine !== source.machine) {
        res.status(404).json({ code: 'conversation-unavailable' }); return;
      }
      if (!deps.verifyOwner(req)) { res.status(403).json({ code: 'hierarchy-owner-only' }); return; }
      // Source resolution may await current authority. A handover beginning
      // during that await must withhold the already-fetched private history.
      if (!deps.ready()) { res.status(503).json({ code: 'conversation-graph-off' }); return; }
      if (!response.ok || !Array.isArray(body.messages)) {
        res.status(response.status === 404 ? 404 : 502).json({ code: 'source-history-unavailable' }); return;
      }
      res.json(body);
    } catch {
      if (!deps.verifyOwner(req)) { res.status(403).json({ code: 'hierarchy-owner-only' }); return; }
      res.status(502).json({ code: 'source-history-unavailable' });
    }
  });
  return router;
}
