/**
 * The test routes of the stand-in owner chat (docs/specs/throwaway-owner-chat.md §3).
 *
 * Mounted only when the stand-in passed its conditions at boot. Every route needs ALL of: the agent's
 * master bearer token exactly (not merely any credential the auth middleware accepts: a dashboard
 * session or a paired phone's device signature is refused, so the phone under test can never press
 * its own Approve); no X-Instar-Device and no Origin header; and a loopback request addressed to
 * this server's own localhost port with no forwarding headers. Anything else is 404.
 */
import type { Express, Request, Response } from 'express';
import { bearerMatches } from './middleware.js';
import { ownLoopbackHost } from './documentLinkRoutes.js';
import type { RouteAnswer, ThrowawayOwnerChat } from './throwawayOwnerChat.js';

export interface ThrowawayOwnerChatRouteDeps {
  authToken: () => string | undefined;
  port: () => unknown;
}

/** The route gate (§3): true only for a local test holding the master token. */
export function standInCallerAllowed(req: Request, deps: ThrowawayOwnerChatRouteDeps): boolean {
  const token = deps.authToken();
  // bearerMatches answers true when no token is configured; the stand-in never does.
  if (!token) return false;
  if (!bearerMatches(req as unknown as { headers: Record<string, unknown> }, token)) return false;
  if (req.headers['x-instar-device'] !== undefined || req.headers.origin !== undefined) return false;
  const host = typeof req.headers.host === 'string' ? req.headers.host : '';
  return ownLoopbackHost(req, host, deps.port());
}

export function mountThrowawayOwnerChatRoutes(app: Express, chat: ThrowawayOwnerChat, deps: ThrowawayOwnerChatRouteDeps): void {
  const answer = (res: Response, a: RouteAnswer) => { res.status(a.status).json(a.body); };
  const guarded = (fn: (req: Request) => RouteAnswer) => (req: Request, res: Response) => {
    if (!standInCallerAllowed(req, deps)) { res.status(404).json({ error: 'Not found' }); return; }
    answer(res, fn(req));
  };
  app.get('/throwaway/owner-chat/messages', guarded((req) => {
    const after = Number(req.query.after ?? 0);
    return chat.messages(Number.isFinite(after) ? after : 0);
  }));
  app.post('/throwaway/owner-chat/tap', guarded((req) => chat.tap((req.body ?? {}).messageId, (req.body ?? {}).button)));
  app.post('/throwaway/owner-chat/command', guarded((req) => chat.command((req.body ?? {}).text)));
}
