/**
 * "Open session" for the Instar iPhone app: which session drives a conversation on this machine,
 * and a dashboard link that opens straight onto it.
 *
 *   GET /mobile/conversations/session?ref=<conversationRef>
 *
 * `ref` takes the same values the media routes take: `app:<uuid>` (a live native app
 * conversation), `telegram:<topicId>` (a topic this machine knows), or a Slack conversation's
 * canonical key `slack:<team>:<channel>[:<thread>]` held by THIS machine. Device-signed only
 * (a Bearer request gets 403 `operator-device-required`); read-only; the phone's person must be
 * allowed to use the conversation (people and roles §3.4), otherwise 404 like an unknown one.
 *
 * Answer: `{ active, sessionName?, startedAt?, framework?, machineNickname, dashboardUrl?,
 * reason?, ownerMachine? }`. `active` is true only when a session record on THIS machine is
 * running for the conversation (the same records the dashboard lists, so its deep link finds the
 * session). The dashboard link is `<origin>/dashboard?session=<tmux name>`. Origin: with
 * multi-route on, the own name this request's signature was verified against (a name this
 * machine's configuration lists, and the request arrived through this machine's own TLS front),
 * so the link cannot land on a sibling's dashboard; otherwise the origin pairing uses (the running
 * Cloudflare named tunnel, else a verified Tailscale own name) unless an active sibling claims that
 * host; otherwise the paired host the signature was verified against. It never carries a token or PIN:
 * the dashboard asks for its PIN as usual. When the conversation runs on another machine of the
 * pool, the route finds that machine's session in the pool's session listing (rows carry their
 * `conversationRef`) and answers it as `active:true, remote:true` with `machineId`, so the phone opens
 * it natively through the relay routes (`/mobile/sessions/relay/:name/*`). No dashboard link is given
 * for it: the phone never has to go to another machine's dashboard. If that machine isn't answering,
 * the answer says so plainly with `retry:true` (Justin, topic 134088, 2026-11-06 22:08: "The session should just open, regardless of which machine it's running on").
 */
import os from 'node:os';
import { Router, type Request, type Response } from 'express';
import type { MobilePairingService } from './mobilePairingRoutes.js';
import { deviceAdmittedHost, deviceMayUse } from './mobilePairingRoutes.js';
import { parseAppCanonicalKey } from '../core/appConversationText.js';
import { verifiedEntityName } from '../messaging/shared/channelIdentity.js';

/** A parsed conversation reference (the media routes' `ref` forms). */
export type SessionConversationRef =
  | { kind: 'app'; ref: string; key: string }
  | { kind: 'telegram'; ref: string; topicId: number }
  | { kind: 'slack'; ref: string };

/** Parse `ref` with exactly the media routes' shapes; anything else is null (400). */
export function parseSessionConversationRef(raw: unknown): SessionConversationRef | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 128) return null;
  const app = parseAppCanonicalKey(raw);
  if (app) return { kind: 'app', ref: raw, key: app };
  const tg = /^telegram:([1-9][0-9]{0,15})$/.exec(raw);
  if (tg) {
    const topicId = Number(tg[1]);
    return Number.isSafeInteger(topicId) ? { kind: 'telegram', ref: raw, topicId } : null;
  }
  if (/^slack:[^\s]+$/.test(raw)) return { kind: 'slack', ref: raw };
  return null;
}

/** The ref the shared people-and-roles check takes (the bare uuid for an app conversation). */
export function mayUseRefOf(r: SessionConversationRef): string { return r.kind === 'app' ? r.key : r.ref; }

export const NO_SESSION_REASON = 'No session is running for this chat right now; your next message starts one.';

export interface OpenSessionAnswer {
  active: boolean;
  sessionName?: string;
  startedAt?: string;
  framework?: string;
  /** This machine's verified name (null only when no verified name exists). */
  machineNickname: string | null;
  dashboardUrl?: string;
  reason?: string;
  /** Present when the conversation runs on another machine of the pool. */
  ownerMachine?: { machineId: string; nickname: string | null };
  /** True when the session runs on `ownerMachine`; the phone opens it through the relay routes. */
  remote?: boolean;
  /** The machine running the session (for `remote`). */
  machineId?: string;
  /** True when trying again later may work (that machine isn't answering right now). */
  retry?: boolean;
}

/** What the pool listing says about the conversation's session on its owner machine. */
export type RemoteSessionLookup =
  | { state: 'found'; name: string; startedAt?: string | null; framework?: string | null }
  | { state: 'none' }
  | { state: 'unreachable' }
  | { state: 'too-old' };

/** The dashboard deep link for a session (no token, no PIN). Null when no usable origin. */
export function dashboardSessionUrl(origin: string | null, sessionName: string): string | null {
  if (!origin) return null;
  let u: URL;
  try { u = new URL(origin); } catch { return null; } // @silent-fallback-ok — no link is the honest answer
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  return `${u.origin}/dashboard?session=${encodeURIComponent(sessionName)}`;
}

/**
 * Decide the answer from what this machine knows (pure; the unit tests cover both sides).
 * A running local session wins; otherwise a known other owner is named; otherwise no session.
 */
export function resolveOpenSession(input: {
  localSession: { name: string; startedAt?: string | null; framework?: string | null } | null;
  ownerMachineId: string | null;
  selfMachineId: string | null;
  ownerNickname: string | null;
  selfNickname: string | null;
  origin: string | null;
  /** The pool listing's answer for the owner machine (absent when there is no other owner). */
  remote?: RemoteSessionLookup | null;
}): OpenSessionAnswer {
  const base = { machineNickname: input.selfNickname };
  const s = input.localSession;
  if (s) {
    const url = dashboardSessionUrl(input.origin, s.name);
    return {
      active: true, sessionName: s.name,
      ...(s.startedAt ? { startedAt: s.startedAt } : {}),
      ...(s.framework ? { framework: s.framework } : {}),
      ...base,
      ...(url ? { dashboardUrl: url } : { reason: 'This machine has no dashboard address the phone can open yet.' }),
    };
  }
  const owner = input.ownerMachineId;
  if (owner && input.selfMachineId && owner !== input.selfMachineId) {
    const nick = input.ownerNickname;
    const where = nick ?? 'another of your machines, whose name I could not confirm,';
    const ownerMachine = { machineId: owner, nickname: nick };
    const r = input.remote ?? { state: 'unreachable' as const };
    if (r.state === 'found') {
      // Opened natively through the relay routes; never a link to another machine's dashboard.
      return {
        active: true, remote: true, sessionName: r.name, machineId: owner,
        ...(r.startedAt ? { startedAt: r.startedAt } : {}),
        ...(r.framework ? { framework: r.framework } : {}),
        machineNickname: nick, ownerMachine,
      };
    }
    if (r.state === 'none') return { active: false, ...base, reason: NO_SESSION_REASON, ownerMachine };
    if (r.state === 'too-old') {
      return { active: false, ...base, ownerMachine, reason: `${nick ?? 'The machine running this chat'} needs the latest Instar update before its session can open here.` };
    }
    return {
      active: false, ...base, ownerMachine, retry: true,
      reason: `This chat's session runs on ${where}, which isn't answering right now, so it can't open here. Try again in a moment.`,
    };
  }
  return { active: false, ...base, reason: NO_SESSION_REASON };
}

export interface MobileSessionRouteDeps {
  pairing: MobilePairingService;
  /** Whether this machine knows the conversation (the media routes' "held here" checks). */
  conversationKnown(ref: SessionConversationRef): boolean;
  /** The tmux session the conversation is bound to on this machine, or null. */
  sessionNameFor(ref: SessionConversationRef): string | null;
  /** The running session record for a tmux name (what the dashboard lists), or null. */
  runningSession(name: string): { startedAt?: string | null; framework?: string | null } | null;
  /** The machine expected to run this conversation (null = this machine / unknown). */
  ownerMachineFor(ref: SessionConversationRef): string | null;
  selfMachineId(): string | null;
  nicknameOf(machineId: string): string | null;
  /** The owner machine's session for the conversation, from the pool's session listing. */
  remoteSession?(ref: SessionConversationRef, ownerMachineId: string): Promise<RemoteSessionLookup>;
}

/**
 * Read the owner machine's session from a pool listing (`GET /sessions?scope=pool`): its row whose
 * `conversationRef` names this conversation. A listing that marks the machine failed is unreachable;
 * a machine whose rows carry no `conversationRef` at all runs an older version.
 */
export function findRemoteSession(listing: unknown, ref: SessionConversationRef, ownerMachineId: string): RemoteSessionLookup {
  if (!listing || typeof listing !== 'object') return { state: 'unreachable' };
  const o = listing as { sessions?: unknown; pool?: { failed?: unknown } };
  const failed = Array.isArray(o.pool?.failed) ? (o.pool!.failed as Array<{ machineId?: unknown }>) : [];
  if (failed.some((f) => f && f.machineId === ownerMachineId)) return { state: 'unreachable' };
  const rows = (Array.isArray(o.sessions) ? o.sessions : Array.isArray(listing) ? listing : []) as Array<Record<string, unknown>>;
  const theirs = rows.filter((r) => r && r.machineId === ownerMachineId && r.remote === true);
  const want = ref.kind === 'app' ? `app:${ref.key}` : ref.ref;
  const row = theirs.find((r) => r.conversationRef === want && (r.status === undefined || r.status === 'running' || r.status === 'starting'));
  if (row && typeof row.tmuxSession === 'string' && row.tmuxSession) {
    return { state: 'found', name: row.tmuxSession, startedAt: typeof row.startedAt === 'string' ? row.startedAt : null, framework: typeof row.framework === 'string' ? row.framework : null };
  }
  if (theirs.length > 0 && !theirs.some((r) => typeof r.conversationRef === 'string')) return { state: 'too-old' };
  return { state: 'none' };
}

type Principal = { kind: string };
const principalOf = (req: Request): Principal => ((req as unknown as { instarPrincipal?: Principal }).instarPrincipal) ?? { kind: 'token' };

/**
 * The origin for this machine's dashboard link. Never a sibling's: a multi-route request's
 * verified own name first; then the pairing origin unless an active sibling claims its host;
 * then the paired host the device signature was checked against.
 */
export function dashboardOriginFor(pairing: Pick<MobilePairingService, 'ownNames' | 'pairingOrigin' | 'siblingClaiming'>, admittedHost: string | null): string | null {
  if (pairing.ownNames && admittedHost && pairing.ownNames.accepts(admittedHost)) return `https://${admittedHost}`;
  const chosen = pairing.pairingOrigin();
  if (chosen && pairing.siblingClaiming(chosen.host) === null) return chosen.origin;
  return admittedHost ? `https://${admittedHost}` : null;
}

/** This machine's verified name: the pool's nickname, else the host name. */
export function selfMachineNickname(deps: Pick<MobileSessionRouteDeps, 'selfMachineId' | 'nicknameOf'>): string | null {
  const id = deps.selfMachineId();
  const pooled = id ? verifiedEntityName(id, deps.nicknameOf(id)) : null;
  if (pooled) return pooled;
  const host = os.hostname().replace(/\.local$/i, '');
  return verifiedEntityName(id ?? 'self', host);
}

export function createMobileSessionRouter(deps: MobileSessionRouteDeps): Router {
  const router = Router();
  router.get('/mobile/conversations/session', async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!deps.pairing.enabled()) { res.status(503).json({ error: 'mobile-pairing-off' }); return; }
    if (principalOf(req).kind !== 'device') { res.status(403).json({ error: 'operator-device-required' }); return; }
    const ref = parseSessionConversationRef(req.query.ref);
    if (!ref) { res.status(400).json({ error: 'bad-ref', detail: 'ref is app:<uuid>, telegram:<topicId>, or a Slack conversation key.' }); return; }
    let known = false;
    try { known = deps.conversationKnown(ref); } catch { known = false; } // @silent-fallback-ok — an unreadable store answers 404
    if (!known || !deviceMayUse(deps.pairing, req, mayUseRefOf(ref))) {
      res.status(404).json({ error: 'unknown-conversation' });
      return;
    }
    let name: string | null = null;
    try { name = deps.sessionNameFor(ref); } catch { name = null; } // @silent-fallback-ok — reported as no session
    let rec: ReturnType<MobileSessionRouteDeps['runningSession']> = null;
    try { rec = name ? deps.runningSession(name) : null; } catch { rec = null; } // @silent-fallback-ok — reported as no session
    const selfId = deps.selfMachineId();
    let owner: string | null = null;
    try { owner = deps.ownerMachineFor(ref); } catch { owner = null; } // @silent-fallback-ok — unknown owner reads as this machine
    let origin: string | null = null;
    try { origin = dashboardOriginFor(deps.pairing, deviceAdmittedHost(req)); } catch { origin = null; } // @silent-fallback-ok — answered without a link, with the reason
    const nick = (id: string): string | null => { try { return deps.nicknameOf(id); } catch { return null; } }; // @silent-fallback-ok — an unconfirmed name is said so
    // Another machine runs it: look it up there, so the phone can open it natively.
    let remote: RemoteSessionLookup | null = null;
    if (!(name && rec) && owner && selfId && owner !== selfId) {
      try { remote = deps.remoteSession ? await deps.remoteSession(ref, owner) : { state: 'unreachable' }; } catch { /* @silent-fallback-ok — worded as "isn't answering, try again" with retry:true */ remote = { state: 'unreachable' }; }
    }
    res.json(resolveOpenSession({
      remote,
      localSession: name && rec ? { name, startedAt: rec.startedAt ?? null, framework: rec.framework ?? null } : null,
      ownerMachineId: owner,
      selfMachineId: selfId,
      ownerNickname: owner ? verifiedEntityName(owner, nick(owner)) : null,
      selfNickname: selfMachineNickname({ selfMachineId: deps.selfMachineId, nicknameOf: nick }),
      origin,
    }));
  });
  return router;
}
