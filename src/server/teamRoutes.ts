/**
 * The team access routes (docs/specs/team-roles-and-access.md §3.3, §3.4, §4.1). Step 2a: one machine,
 * and the owner's phone is the only person writer. Every write stores the phone's whole signed
 * request, and events are read from that signed body. The bearer token can only take access away.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Router, type Request, type Response } from 'express';
import { deviceKeyHashOf, type MachineSigner } from '../core/AppRecordSignatures.js';
import { displayCode } from '../core/MobileDeviceKeys.js';
import { parseSignedEvents, type RequestEvent } from '../core/TeamAccessEvents.js';
import type { ConfinedEntry, TeamAccessRow } from '../core/TeamAccessLog.js';
import { ORG_ROLES, type OrgRole } from '../permissions/types.js';
import { tierOfRole } from '../permissions/TeamAccess.js';
import { topicPlaceKey } from '../users/TeamConfinement.js';
import { buildSignedOrigin } from './mobileConversationRoutes.js';
import { devicePersonOf, principalOf, type MobilePairingService } from './mobilePairingRoutes.js';

export interface TeamRouteDeps {
  signer: () => MachineSigner | null;
  /** Ends a conversation's live session under its lock, then runs the change. */
  applyConversationChange: <T>(ref: string, change: () => Promise<T> | T) => Promise<T>;
  /** Attention, Agent Updates, the lifeline: never shared. */
  isSystemTopic: (topicId: number) => boolean;
  /** Bound to a job, whose purpose feeds owner-reach prompts. */
  isJobTopic: (topicId: number) => boolean;
  /** A topic pinned to a framework with no sandbox adapter. */
  isUnconfinableTopic?: (topicId: number) => boolean;
  /** The resolved owner's profile id, and whether several claim to be the owner. */
  ownerProfile: () => { userId: string | null; several: boolean; links: Record<string, string | number> };
  logsDir: string;
  /** Conversations to confine on a restore: those holding team-phone messages, and every one. */
  restoreRefs: () => { teamRefs: ConfinedEntry[]; allRefs: () => ConfinedEntry[] };
  /** Turn memory privacy on here and restart this machine (§3.6). */
  requireMemoryPrivacy: () => Promise<boolean> | boolean;
  now?: () => number;
}

type Refusal = { status: number; error: string; detail: string };

/** Said to the owner at invite and to each person on first use (§3.6): owner-reach jobs are disclosed, not hidden. */
export const TEAM_DISCLOSURE = 'Scheduled jobs run for the owner and can read messages here.';

const LOG_UNREADABLE: Refusal = { status: 409, error: 'team-access-unreadable', detail: 'The team access record cannot be read, so no one can be changed. Restore it from the People screen.' };

const refuseText: Record<string, string> = {
  'memory-privacy-required': 'Team members need memory privacy on. Turn it on first.',
  'team-needs-one-machine': 'Team members work on agents running on one machine for now. Support for several machines is the next step. You can still use owner and MSP phones.',
};

/** Why this conversation cannot be shared, or null. Runs before anything is written. */
export function grantRefusal(svc: MobilePairingService, deps: TeamRouteDeps, ref: string): Refusal | null {
  if (ref.startsWith('slack:')) return { status: 409, error: 'slack-not-yet', detail: 'Slack conversations cannot be shared in the app yet.' };
  const topic = /^telegram:(\d+)$/.exec(ref);
  if (topic) {
    const id = Number(topic[1]);
    if (deps.isSystemTopic(id)) return { status: 409, error: 'system-topic', detail: 'A system topic cannot be shared.' };
    if (deps.isJobTopic(id)) return { status: 409, error: 'job-topic', detail: 'A topic a scheduled job posts to cannot be shared, because the job runs with your full reach.' };
    if (deps.isUnconfinableTopic?.(id)) return { status: 409, error: 'topic-cannot-be-confined', detail: 'This topic runs on a framework that memory privacy cannot confine yet.' };
    return null;
  }
  const own = svc.appConversationOwner?.(ref);
  if (own === undefined) return { status: 404, error: 'unknown-conversation', detail: 'That conversation does not exist.' };
  if (own !== null || svc.teamLog()?.ownerOf(ref)) return { status: 409, error: 'own-conversation', detail: 'A person\'s own conversation cannot be shared, because its memory is theirs.' };
  return null;
}

export function confinedEntryFor(ref: string): ConfinedEntry {
  return ref.startsWith('telegram:') ? { ref, placeKey: topicPlaceKey(ref) } : { ref, placeKey: `app:${ref}` };
}

/** Refusals, capped to one row per device, route and minute (§3.11). */
export class TeamRefusalLog {
  private readonly seen = new Map<string, number>();
  constructor(private readonly file: string, private readonly now: () => number = Date.now) {}

  record(deviceId: string, route: string, reason: string): void {
    const key = `${deviceId}|${route}`;
    const t = this.now();
    if (t - (this.seen.get(key) ?? -Infinity) < 60_000) return;
    this.seen.set(key, t);
    if (this.seen.size > 5_000) this.seen.clear();
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, `${JSON.stringify({ at: new Date(t).toISOString(), deviceId, route, reason })}\n`);
    } catch (err) {
      console.warn(`[team-access] refusal not logged: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** Plain lines for Activity, from the signed log. */
export function activityLines(rows: ReadonlyArray<TeamAccessRow>, nameOf: (personKey: string) => string): Array<{ seq: number; text: string }> {
  const out: Array<{ seq: number; text: string }> = [];
  for (const row of rows) {
    if (row.kind === 'machine') {
      for (const e of row.events) if (e.type === 'lower') out.push({ seq: row.seq, text: e.remove ? `${nameOf(e.personKey)} was removed` : `Access was lowered for ${nameOf(e.personKey)}` });
      continue;
    }
    let events: RequestEvent[] | null = null;
    try { events = parseSignedEvents(JSON.parse(Buffer.from(row.signedOrigin.bodyB64, 'base64').toString('utf8'))); } catch { events = null; } // @silent-fallback-ok — an unreadable row shows no line
    for (const e of events ?? []) {
      if (e.type === 'person-add') out.push({ seq: row.seq, text: `${e.name} was invited` });
      else if (e.type === 'person-remove') out.push({ seq: row.seq, text: `${nameOf(e.personKey)} was removed` });
      else if (e.type === 'grant') out.push({ seq: row.seq, text: `${nameOf(e.personKey)} was given ${e.access === 'use' ? 'use of' : 'read access to'} a conversation` });
      else if (e.type === 'grant-remove') out.push({ seq: row.seq, text: `${nameOf(e.personKey)} lost access to a conversation` });
      else if (e.type === 'team-off') out.push({ seq: row.seq, text: 'Team access was turned off' });
    }
  }
  return out;
}

export function createTeamRouter(svc: MobilePairingService, deps: TeamRouteDeps): Router {
  const router = Router();
  const refusals = new TeamRefusalLog(path.join(deps.logsDir, 'team-access.jsonl'), deps.now);
  const now = () => (deps.now ?? Date.now)();

  const send = (res: Response, r: Refusal): void => { res.status(r.status).json({ error: r.error, detail: r.detail }); };

  /** A write that fails answers plainly: an access change must never leave a request hanging. */
  const write = (handler: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response): void => {
    if (svc.teamLog()?.healthState() === 'unreadable') { send(res, LOG_UNREADABLE); return; }
    handler(req, res).catch((err: unknown) => {
      console.warn(`[team-access] ${req.path} failed: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) res.status(500).json({ error: 'team-access-write-failed', detail: 'That change was not saved. Try again.' });
    });
  };

  /** The owner's phone, or a refusal already sent. */
  const ownerDevice = (req: Request, res: Response): string | null => {
    res.setHeader('Cache-Control', 'no-store');
    const p = principalOf(req);
    const person = devicePersonOf(req);
    if (p.kind !== 'device' || person?.role !== 'owner') {
      if (p.kind === 'device') refusals.record(p.deviceId, req.path, 'owner-phone-required');
      res.status(403).json({ error: 'owner-phone-required' });
      return null;
    }
    return p.deviceId;
  };

  /** Bind the signer's key, then store its signed request. */
  const appendRequest = (req: Request, deviceId: string): void => {
    const log = svc.teamLog();
    const signer = deps.signer();
    const dev = svc.devices.get(deviceId);
    if (!log || !signer || !dev?.publicKey) throw new Error('team-access-no-identity');
    const keyHash = deviceKeyHashOf(dev.publicKey);
    if (log.state().bindings.get(keyHash) !== 'owner') log.appendMachineEvents([{ type: 'phone-bind', keyHash, deviceId, boundTo: 'owner' }]);
    const receivedAt = new Date(now()).toISOString();
    const { origin, receipt } = buildSignedOrigin(req, svc, deviceId, '', [], signer, receivedAt);
    if (!origin || !('bodyB64' in origin) || !origin.bodyB64) throw new Error('team-access-unsigned');
    log.appendSignedRequest({ receivedAt, signedOrigin: origin as never, receipt: receipt as never });
  };

  const eventsOf = (req: Request, res: Response): RequestEvent[] | null => {
    const events = parseSignedEvents(req.body);
    if (!events) res.status(400).json({ error: 'bad-events', detail: 'The request does not hold valid access changes.' });
    return events;
  };

  /** Every refusal check, then the confined list, then each session ended, then the event. */
  const applyGrants = async (events: RequestEvent[]): Promise<Refusal | null> => {
    const grants = events.filter((e): e is Extract<RequestEvent, { type: 'grant' }> => e.type === 'grant');
    const log = svc.teamLog();
    if (!log) return { status: 503, error: 'team-access-unavailable', detail: 'Team access is not available on this agent.' };
    const added = new Set(events.flatMap((e) => (e.type === 'person-add' ? [e.personKey] : [])));
    for (const g of grants) {
      if (!added.has(g.personKey) && !log.state().people.has(g.personKey)) return { status: 404, error: 'unknown-person', detail: 'That person is not on this agent.' };
      const r = grantRefusal(svc, deps, g.ref);
      if (r) return r;
    }
    log.ensureConfinedFile();
    for (const g of grants) {
      log.confine(confinedEntryFor(g.ref));
      await deps.applyConversationChange(g.ref, () => undefined);
    }
    return null;
  };

  svc.teamActionRunner = async (kind, req, deviceId) => {
    const log = svc.teamLog();
    if (!log) return { status: 503, body: { error: 'team-access-unavailable' } };
    if (kind === 'team-memory-privacy') {
      const restarting = await deps.requireMemoryPrivacy();
      return { status: restarting ? 200 : 503, body: restarting ? { ok: true, restarting: true } : { error: 'restart-unavailable', detail: 'Memory privacy is set, but this machine could not restart itself.' } };
    }
    if (kind === 'team-restore') {
      const result = log.restore(deps.restoreRefs());
      return { status: 200, body: { ok: true, ...result } };
    }
    const events = parseSignedEvents(req.body);
    if (events?.length !== 1 || events[0].type !== 'team-off') return { status: 400, body: { error: 'bad-events' } };
    for (const entry of log.readConfined() ?? []) await deps.applyConversationChange(entry.ref, () => undefined);
    appendRequest(req, deviceId);
    return { status: 200, body: { ok: true } };
  };

  router.get('/mobile/team/context', (req, res) => {
    if (!ownerDevice(req, res)) return;
    const owner = deps.ownerProfile();
    const log = svc.teamLog();
    res.json({
      ownerPersonKey: log?.state().ownerPersonKey ?? owner.userId, ownerLinks: owner.links, several: owner.several,
      teamOn: svc.teamOn(), refusal: svc.teamRefusal(),
      people: [...(log?.state().people.values() ?? [])].map((p) => ({ personKey: p.personKey, name: p.name, role: p.role })),
    });
  });

  router.post('/mobile/team/invites', write(async (req, res) => {
    const deviceId = ownerDevice(req, res);
    if (!deviceId) return;
    const stop = svc.teamRefusal();
    if (stop) { res.status(409).json({ error: stop, detail: refuseText[stop] }); return; }
    const log = svc.teamLog();
    if (!log || !deps.signer()) { res.status(409).json({ error: 'team-access-no-identity', detail: 'This machine has no identity key, so it cannot sign access changes.' }); return; }
    if (!svc.pairingOrigin()) { res.status(503).json({ error: 'no-pairing-origin', detail: 'This agent has no secure address for a phone to reach yet.' }); return; }
    if (deps.ownerProfile().several) { res.status(409).json({ error: 'several-owners', detail: 'Several people are marked as the owner on this agent. Fix that first.' }); return; }
    const body = (req.body ?? {}) as { existingPersonKey?: unknown; label?: unknown };
    const existing = typeof body.existingPersonKey === 'string' ? body.existingPersonKey : null;
    // A replacement phone keeps the person: no new person, and nothing else to sign.
    if (existing) {
      if (!log.state().people.has(existing)) { res.status(404).json({ error: 'unknown-person', detail: 'That person is not on this agent.' }); return; }
      const link = svc.mintTeamLink(existing, typeof body.label === 'string' ? body.label : null);
      if (!link.ok) { res.status(link.status).json({ error: link.error }); return; }
      res.json({ personKey: existing, link: link.link, expiresAt: link.expiresAt, disclosure: TEAM_DISCLOSURE });
      return;
    }
    const events = eventsOf(req, res);
    if (!events) return;
    const add = events.find((e): e is Extract<RequestEvent, { type: 'person-add' }> => e.type === 'person-add');
    if (!add) { res.status(400).json({ error: 'person-required', detail: 'An invite names a person.' }); return; }
    if (!log.state().on && !(events.some((e) => e.type === 'team-on') && events.some((e) => e.type === 'owner-pin'))) {
      res.status(400).json({ error: 'first-invite-incomplete', detail: 'The first invite also turns team access on.' });
      return;
    }
    const refused = await applyGrants(events);
    if (refused) { send(res, refused); return; }
    appendRequest(req, deviceId);
    const link = svc.mintTeamLink(add.personKey, typeof body.label === 'string' ? body.label : null);
    if (!link.ok) { res.status(link.status).json({ error: link.error }); return; }
    res.json({ personKey: add.personKey, link: link.link, expiresAt: link.expiresAt, disclosure: TEAM_DISCLOSURE });
  }));

  router.get('/mobile/team/invites/:personKey', (req, res) => {
    if (!ownerDevice(req, res)) return;
    const key = String(req.params.personKey);
    const waiting = svc.dashboardApprovals().filter((a) => a.device.role === 'team' && a.device.userId === key);
    res.json({ waiting: waiting.map((a) => ({ deviceId: a.device.id, deviceName: a.device.deviceName, code: displayCode(a.code), expiresAt: new Date(a.expiresAt).toISOString() })) });
  });

  router.post('/mobile/team/grants', write(async (req, res) => {
    const deviceId = ownerDevice(req, res);
    if (!deviceId) return;
    const stop = svc.teamRefusal();
    if (stop) { res.status(409).json({ error: stop, detail: refuseText[stop] }); return; }
    const events = eventsOf(req, res);
    if (!events) return;
    if (events.some((e) => e.type !== 'grant' && e.type !== 'grant-remove')) { res.status(400).json({ error: 'bad-events', detail: 'Only grants belong here.' }); return; }
    const refused = await applyGrants(events);
    if (refused) { send(res, refused); return; }
    for (const e of events) if (e.type === 'grant-remove') await deps.applyConversationChange(e.ref, () => undefined);
    appendRequest(req, deviceId);
    res.json({ ok: true });
  }));

  router.post('/mobile/team/people/:personKey', write(async (req, res) => {
    const deviceId = ownerDevice(req, res);
    if (!deviceId) return;
    const events = eventsOf(req, res);
    if (!events) return;
    if (events.some((e) => (e.type !== 'person-set' && e.type !== 'person-remove') || e.personKey !== req.params.personKey)) {
      res.status(400).json({ error: 'bad-events', detail: 'Only changes to this person belong here.' });
      return;
    }
    const log = svc.teamLog();
    if (!log?.state().people.has(String(req.params.personKey))) { res.status(404).json({ error: 'unknown-person', detail: 'That person is not on this agent.' }); return; }
    for (const ref of log.state().grants.get(String(req.params.personKey))?.keys() ?? []) await deps.applyConversationChange(ref, () => undefined);
    appendRequest(req, deviceId);
    res.json({ ok: true });
  }));

  router.get('/mobile/team/people', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const log = svc.teamLog();
    const person = devicePersonOf(req);
    const rows = [...(log?.state().people.values() ?? [])].map((p) => ({
      personKey: p.personKey, name: p.name, role: p.role, tier: tierOfRole(p.role),
      conversations: [...(log?.state().grants.get(p.personKey)?.entries() ?? [])].map(([ref, access]) => ({ ref, access })),
    }));
    if (person?.role === 'owner') { res.json({ people: rows, teamOn: svc.teamOn() }); return; }
    res.json({ people: rows.filter((r) => r.personKey === person?.userId), disclosure: TEAM_DISCLOSURE });
  });

  router.get('/mobile/team/activity', (req, res) => {
    if (!ownerDevice(req, res)) return;
    const log = svc.teamLog();
    const state = log?.state();
    res.json({ lines: activityLines(log?.allRows() ?? [], (key) => state?.people.get(key)?.name ?? 'Someone').slice(-200) });
  });

  // The agent can take access away, and never give it (§3.3).
  router.post('/team/people/:personKey/lower', write(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (principalOf(req).kind !== 'token') { res.status(403).json({ error: 'agent-token-required' }); return; }
    const log = svc.teamLog();
    if (!log) { res.status(503).json({ error: 'team-access-unavailable' }); return; }
    const personKey = String(req.params.personKey);
    const b = (req.body ?? {}) as { remove?: unknown; ref?: unknown; role?: unknown };
    const person = log.state().people.get(personKey);
    if (!person) { res.status(404).json({ error: 'unknown-person' }); return; }
    const role = typeof b.role === 'string' && (ORG_ROLES as readonly string[]).includes(b.role) ? b.role as OrgRole : undefined;
    const rank = (r: OrgRole) => ORG_ROLES.indexOf(r);
    if (role && (role === 'owner' || rank(role) >= rank(person.role))) { res.status(403).json({ error: 'can-only-lower' }); return; }
    const ref = typeof b.ref === 'string' ? b.ref : undefined;
    if (!ref && !role && b.remove !== true) { res.status(400).json({ error: 'nothing-to-lower' }); return; }
    const refs = ref ? [ref] : [...(log.state().grants.get(personKey)?.keys() ?? [])];
    for (const r of refs) await deps.applyConversationChange(r, () => undefined);
    log.appendMachineEvents([{ type: 'lower', personKey, ...(ref ? { ref } : {}), ...(role ? { role } : {}), ...(b.remove === true ? { remove: true } : {}) }]);
    res.json({ ok: true });
  }));

  return router;
}
