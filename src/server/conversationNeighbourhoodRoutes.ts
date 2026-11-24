/**
 * The agent's scoped read of a conversation's neighbourhood (docs/specs/work-front-doors.md §4.3).
 *
 *   GET /conversation-neighbourhood?conversation=telegram:N | app:KEY
 *     The full read: project, open cards and whose turn, related conversations, people on those
 *     cards, open promises made here — each group with `complete` and its reasons, the source versions
 *     consumed, the ceilings applied, and what could not be checked. Scoped to the conversation's
 *     least-privileged audience, never the owner's view by default.
 *
 *   GET /conversation-neighbourhood/session-context?topicId=N (or ?conversation=KEY)
 *     The block the session-start and compaction-recovery hooks inject: `{present:false}` when there is
 *     nothing to say, else `{present:true, block, revision}`.
 *
 * Who may ask: the agent's bearer (any conversation), or a session token for its OWN conversation only
 * (the conversation comes from the token's place, and naming another one is refused). A phone or a
 * browser is refused: this is the agent's read, not a person's (§4.3; the screens use their own routes).
 * 503 while the feature is off (`relationshipIndex.enabled`, dev-gated).
 */
import type { Router, Request, Response } from 'express';
import { deriveNeighbourhood, renderNeighbourhoodBlock, isConversationKey, type NeighbourhoodSources, type NeighbourhoodCeilings, type Neighbourhood } from '../core/RelationshipIndex.js';
import { conversationOfPlace } from './documentRoutes.js';

export interface ConversationNeighbourhoodRouteDeps {
  enabled: () => boolean;
  /**
   * One read's sources (built per request, so its audience and permission checks agree). `sessionAudience` is
   * the calling session token's memory-privacy audience key, or null for the agent's bearer.
   */
  sources: (caller: { sessionAudience: string | null }) => NeighbourhoodSources;
  ceilings: () => NeighbourhoodCeilings;
  log?: (event: string, detail: Record<string, unknown>) => void;
  now?: () => number;
}

/** How long the per-prompt path reuses one conversation's block. */
export const BLOCK_REUSE_MS = 5_000;

type Locals = { memorySession?: { placeKey?: string | null; audience?: { kind?: string; userId?: string; placeKey?: string } } };

function isPersonPrincipal(req: Request): boolean {
  const kind = (req as unknown as { instarPrincipal?: { kind?: string } }).instarPrincipal?.kind;
  return kind === 'device' || kind === 'device-notify';
}

/** The conversation this request may read, or the refusal to send. */
function conversationFor(req: Request, res: Response): { key: string; sessionAudience: string | null } | { status: number; error: string } {
  const named = typeof req.query.conversation === 'string' ? req.query.conversation
    : typeof req.query.topicId === 'string' && /^-?\d{1,20}$/.test(req.query.topicId) ? `telegram:${req.query.topicId}` : null;
  if (isPersonPrincipal(req)) return { status: 403, error: 'agent-read-only' };
  const session = (res.locals as Locals).memorySession;
  if (session) {
    const own = conversationOfPlace(session.placeKey ?? '');
    if (!own) return { status: 403, error: 'session-has-no-conversation' };
    if (named !== null && named !== own) return { status: 403, error: 'own-conversation-only' };
    const a = session.audience;
    // The token's own audience, in MemoryPrivacy's key form; a malformed one reads as unknown downstream.
    const sessionAudience = !a?.kind ? 'none' : a.kind === 'owner' || a.kind === 'person' ? `${a.kind}:${a.userId ?? ''}` : a.kind === 'place' ? `place:${a.placeKey ?? ''}` : a.kind;
    return { key: own, sessionAudience };
  }
  if (named === null) return { status: 400, error: 'conversation or topicId is required' };
  if (!isConversationKey(named)) return { status: 400, error: 'conversation must be telegram:<topic>, app:<key> or slack:<id>' };
  return { key: named, sessionAudience: null };
}

/** The block for one conversation, for the per-prompt route (null while the feature is off). */
export type NeighbourhoodBlockFor = (key: string) => { block: string; revision: string } | null;

export function registerConversationNeighbourhoodRoutes(router: Router, deps: ConversationNeighbourhoodRouteDeps): NeighbourhoodBlockFor {
  const read = (req: Request, res: Response): Neighbourhood | null => {
    if (!deps.enabled()) { res.status(503).json({ error: 'relationship-index-off', message: 'The conversation neighbourhood is off on this agent (relationshipIndex.enabled).' }); return null; }
    const target = conversationFor(req, res);
    if ('error' in target) { res.status(target.status).json({ error: target.error }); return null; }
    const n = deriveNeighbourhood(target.key, deps.sources({ sessionAudience: target.sessionAudience }), deps.ceilings());
    if (!n.complete) deps.log?.('neighbourhood-incomplete', { conversation: target.key, couldNotCheck: n.couldNotCheck, audience: n.audience.kind });
    return n;
  };

  router.get('/conversation-neighbourhood/session-context', (req, res) => {
    const n = read(req, res);
    if (!n) return;
    const block = renderNeighbourhoodBlock(n);
    res.json(block ? { present: true, block, revision: n.revision } : { present: false, revision: n.revision });
  });

  router.get('/conversation-neighbourhood', (req, res) => {
    const n = read(req, res);
    if (!n) return;
    res.json({ schema: 'conversation-neighbourhood/1', asOf: new Date().toISOString(), ...n });
  });

  // The per-prompt path asks on every prompt of every session; a read reduces the graph, so one result per
  // conversation is reused for a few seconds (bounded), which a session's next prompt never notices.
  const recent = new Map<string, { at: number; value: { block: string; revision: string } }>();
  const now = deps.now ?? Date.now;
  return (key) => {
    if (!deps.enabled() || !isConversationKey(key)) return null;
    const t = now();
    const hit = recent.get(key);
    if (hit && t - hit.at < BLOCK_REUSE_MS) return hit.value;
    const n = deriveNeighbourhood(key, deps.sources({ sessionAudience: null }), deps.ceilings());
    const value = { block: renderNeighbourhoodBlock(n), revision: n.revision };
    recent.delete(key);
    recent.set(key, { at: t, value });
    while (recent.size > 500) recent.delete(recent.keys().next().value as string);
    return value;
  };
}
