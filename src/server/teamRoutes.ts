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
import { streamKey } from '../core/TeamAccessMerge.js';
import { TEAM_ACCESS_WRITE_PATHS, eventsFitPath, type ConfinedEntry, type TeamAccessRow } from '../core/TeamAccessLog.js';
import { ORG_ROLES, type OrgRole } from '../permissions/types.js';
import { tierOfRole } from '../permissions/TeamAccess.js';
import { TeamRequests, eventsMatchChange, parseRequestChange, requestSummary, type Requester } from '../core/TeamRequests.js';
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
  stateDir: string;
  /** A plain name for a conversation or place, for the owner's Requests list. */
  conversationTitle: (refOrPlace: string) => string | null;
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
  'access-being-checked': 'The access record is being checked across your machines. Team phones and changes wait until that finishes.',
};

/** Why this conversation cannot be shared, or null. Runs before anything is written. */
export function grantRefusal(svc: MobilePairingService, deps: TeamRouteDeps, ref: string): Refusal | null {
  if (ref.startsWith('slack:')) return { status: 409, error: 'slack-not-yet', detail: 'Slack conversations cannot be shared in the app yet.' };
  if (ref.startsWith('telegram:') && !/^telegram:[1-9]\d*$/.test(ref)) return { status: 400, error: 'bad-conversation', detail: 'That is not a conversation on this agent.' };
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

const grantRefs = (events: RequestEvent[]): string[] => events.flatMap((e) => (e.type === 'grant' || e.type === 'grant-remove' ? [e.ref] : []));

/** Plain lines for Activity, from the signed log. */
export function activityLines(rows: ReadonlyArray<TeamAccessRow>): Array<{ seq: number; text: string }> {
  const out: Array<{ seq: number; text: string }> = [];
  const eventsOfRow = (row: Extract<TeamAccessRow, { kind: 'request' }>): RequestEvent[] | null => {
    try { return parseSignedEvents(JSON.parse(Buffer.from(row.signedOrigin.bodyB64, 'base64').toString('utf8'))); } catch { return null; } // @silent-fallback-ok — an unreadable row shows no line
  };
  // Names come from the log, so a person removed since still reads by name in the history.
  const names = new Map<string, string>();
  for (const row of rows) {
    if (row.kind !== 'request') continue;
    for (const e of eventsOfRow(row) ?? []) if (e.type === 'person-add') names.set(e.personKey, e.name);
  }
  const nameOf = (personKey: string) => names.get(personKey) ?? 'Someone';
  for (const row of rows) {
    if (row.kind === 'machine') {
      for (const e of row.events) if (e.type === 'lower') out.push({ seq: row.seq, text: e.remove ? `${nameOf(e.personKey)} was removed` : `Access was lowered for ${nameOf(e.personKey)}` });
      continue;
    }
    for (const e of eventsOfRow(row) ?? []) {
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

  const requests = new TeamRequests(deps.stateDir, deps.now);

  /** Who is asking, from the session and never from the body. */
  const requesterOf = (res: Response): Requester => {
    const session = res.locals.memorySession as { audience?: { kind: string; userId?: string; placeKey?: string }; placeKey?: string | null } | undefined;
    const audience = session?.audience;
    if (audience?.kind === 'person' && audience.userId) {
      return { kind: 'person', key: audience.userId, label: svc.teamLog()?.state().people.get(audience.userId)?.name ?? 'Someone' };
    }
    const place = audience?.kind === 'place' ? audience.placeKey : session?.placeKey;
    if (session && place) return { kind: 'place', key: place, label: `Someone in ${deps.conversationTitle(place) ?? 'a shared conversation'}` };
    return { kind: 'agent', key: 'agent', label: 'The agent' };
  };

  /** A write that answers a request must do exactly what it asked. Null means carry on. */
  const requestCheck = (req: Request, events: RequestEvent[]): Refusal | null => {
    const id = (req.body as { requestId?: unknown } | undefined)?.requestId;
    if (id === undefined) return null;
    const open = typeof id === 'string' ? requests.get(id) : null;
    if (!open) return { status: 404, error: 'request-gone', detail: 'That request has expired or was already answered.' };
    return eventsMatchChange(open.change, events) ? null : { status: 409, error: 'request-mismatch', detail: 'This change is not the one that was asked for.' };
  };
  const closeAnswered = (req: Request): void => {
    const id = (req.body as { requestId?: unknown } | undefined)?.requestId;
    if (typeof id === 'string') requests.close(id);
  };

  const send = (res: Response, r: Refusal): void => { res.status(r.status).json({ error: r.error, detail: r.detail }); };

  // One access change at a time: each check below must still be true when its row is written.
  let writes: Promise<unknown> = Promise.resolve();
  const inTurn = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = writes.then(fn, fn);
    writes = run.catch(() => undefined);
    return run;
  };

  /** A write that fails answers plainly: an access change must never leave a request hanging. */
  const write = (handler: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response): void => {
    if (svc.teamLog()?.healthState() === 'unreadable') { send(res, LOG_UNREADABLE); return; }
    // Express also matches a trailing slash or a query, and the log would refuse that row after the
    // conversation had already changed. Refuse it before anything moves.
    if (req.originalUrl.startsWith('/mobile/') && !TEAM_ACCESS_WRITE_PATHS.some((re) => re.test(req.originalUrl))) {
      res.status(400).json({ error: 'bad-path', detail: 'That address is not one this change can be signed for.' });
      return;
    }
    inTurn(() => handler(req, res)).catch((err: unknown) => { // @silent-fallback-ok — the caller is told the change was not saved
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
    if (!events || !eventsFitPath(req.originalUrl, events)) {
      res.status(400).json({ error: 'bad-events', detail: 'The request does not hold valid access changes.' });
      return null;
    }
    if (events.some((e) => (e.type === 'person-add' || e.type === 'person-set') && tierOfRole(e.role) === 'admin')) {
      res.status(409).json({ error: 'admin-not-yet', detail: 'Team members can be members or guests for now. Admin access comes with the maintenance step.' });
      return null;
    }
    return events;
  };

  /**
   * End each conversation's session and write the change while holding every affected lock, so no
   * replacement session can start under the old access. Sorted, so two changes never deadlock.
   */
  const underLocks = async (refs: Iterable<string>, commit: () => void): Promise<void> => {
    const ordered = [...new Set(refs)].sort();
    const step = async (i: number): Promise<void> => {
      if (i === ordered.length) { commit(); return; }
      await deps.applyConversationChange(ordered[i], () => step(i + 1));
    };
    await step(0);
  };

  /** Every conversation a change to this person touches: what they were given, and what is theirs. */
  const refsOf = (personKey: string): string[] => {
    const state = svc.teamLog()?.state();
    const owned = [...(state?.owned.entries() ?? [])].filter(([, key]) => key === personKey).map(([ref]) => ref);
    return [...new Set([...(state?.grants.get(personKey)?.keys() ?? []), ...owned])];
  };

  /** Every refusal check, then the confined list. The caller ends each session and writes the event under its lock. */
  const applyGrants = async (events: RequestEvent[]): Promise<Refusal | null> => {
    const grants = events.filter((e): e is Extract<RequestEvent, { type: 'grant' }> => e.type === 'grant');
    const log = svc.teamLog();
    if (!log) return { status: 503, error: 'team-access-unavailable', detail: 'Team access is not available on this agent.' };
    // In order, as the log will apply them: a grant before its person would silently do nothing.
    const added = new Set<string>();
    for (const e of events) {
      if (e.type === 'person-add') added.add(e.personKey);
      if (e.type === 'grant' && !added.has(e.personKey) && !log.state().people.has(e.personKey)) return { status: 404, error: 'unknown-person', detail: 'That person is not on this agent.' };
    }
    for (const g of grants) {
      const r = grantRefusal(svc, deps, g.ref);
      if (r) return r;
    }
    log.ensureConfinedFile();
    for (const g of grants) log.confine(confinedEntryFor(g.ref));
    return null;
  };

  // A peer can sign a grant to a topic it does not know is a job's here. The row that undoes it is
  // signed by this machine, so every machine reaches the same answer from the log alone.
  svc.teamGrantCheck = () => {
    const log = svc.teamLog();
    if (!log) return;
    for (const [personKey, refs] of log.state().grants) {
      for (const ref of [...refs.keys()]) {
        const why = grantRefusal(svc, deps, ref)?.error;
        if (why === 'system-topic' || why === 'job-topic' || why === 'topic-cannot-be-confined') log.appendMachineEvents([{ type: 'lower', personKey, ref }]);
      }
    }
  };

  svc.teamActionRunner = (kind, req, deviceId) => inTurn(async () => {
    const log = svc.teamLog();
    if (!log) return { status: 503, body: { error: 'team-access-unavailable', detail: 'Team access is not available on this agent.' } };
    if (kind === 'team-memory-privacy') {
      const restarting = await deps.requireMemoryPrivacy();
      return { status: restarting ? 200 : 503, body: restarting ? { ok: true, restarting: true } : { error: 'restart-unavailable', detail: 'Memory privacy is set, but this machine could not restart itself.' } };
    }
    if (kind === 'team-restore') {
      // Confinement has no undo, so a restore runs only when something is actually damaged.
      if (log.healthState() !== 'unreadable' && log.readConfined() !== null) {
        return { status: 409, body: { error: 'nothing-to-restore', detail: 'The team access record is fine, so there is nothing to restore.' } };
      }
      // Restoring can confine any conversation, so every session ends first: a rare repair, and strict.
      const refs = deps.restoreRefs();
      let result: ReturnType<typeof log.restore> | null = null;
      await underLocks(refs.allRefs().map((entry) => entry.ref), () => { result = log.restore(refs); });
      return { status: 200, body: { ok: true, ...(result as unknown as object) } };
    }
    if (log.healthState() === 'unreadable') return { status: 409, body: { error: LOG_UNREADABLE.error, detail: LOG_UNREADABLE.detail } };
    const events = parseSignedEvents(req.body);
    if (kind === 'team-origin-gone') {
      const gone = events?.length === 1 && events[0].type === 'origin-gone' ? events[0] : null;
      if (!gone) return { status: 400, body: { error: 'bad-events', detail: 'The request does not hold valid access changes.' } };
      // Only a stream this log has rows from can be gone. This machine's earlier stream can, its current one cannot.
      if (gone.machine === deps.signer()?.machineId() && gone.incarnation === log.currentIncarnation()) return { status: 409, body: { error: 'origin-is-this-machine', detail: 'This is the machine you are connected to, so it cannot be marked as gone.' } };
      const held = log.vector()[streamKey(gone.machine, gone.incarnation)];
      // A machine with no rows here can still be retired, so it stops being waited for.
      const noRowsPeer = held === undefined && gone.throughSeq === 0 && (svc.teamPuller?.knows(gone.machine) ?? false);
      if (!noRowsPeer && (held === undefined || gone.throughSeq > held)) return { status: 409, body: { error: 'unknown-origin', detail: 'This machine holds no such record to settle.' } };
      appendRequest(req, deviceId);
      svc.reconcileTeamPhones();
      return { status: 200, body: { ok: true } };
    }
    if (events?.length !== 1 || events[0].type !== 'team-off') return { status: 400, body: { error: 'bad-events', detail: 'The request does not hold valid access changes.' } };
    await underLocks((log.readConfined() ?? []).map((entry) => entry.ref), () => appendRequest(req, deviceId));
    svc.revokePersonPhones(null);
    return { status: 200, body: { ok: true } };
  });

  /** A machine last known unable to keep a team's promises blocks anything new, and existing phones keep working (§3.6). */
  const floorOk = (res: Response): boolean => {
    const behind = svc.teamPuller?.belowFloor() ?? [];
    if (behind.length === 0) return true;
    res.status(409).json({ error: 'machine-below-floor', machines: behind, detail: `${behind.length === 1 ? 'A machine' : 'Some machines'} on this agent cannot keep team access private yet. Update ${behind.length === 1 ? 'it' : 'them'} or mark ${behind.length === 1 ? 'it' : 'them'} as gone first.` });
    return false;
  };

  // The agent, or a member's own session, asks. This gives nobody anything: only the owner's signed write does.
  router.post('/team/proposals', write(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (principalOf(req).kind !== 'token') { res.status(403).json({ error: 'agent-token-required' }); return; }
    const body = (req.body ?? {}) as { change?: unknown; reason?: unknown; expiresAt?: unknown };
    const change = parseRequestChange(body.change);
    if (!change) { res.status(400).json({ error: 'bad-change', detail: 'A request names a typed change: grant, role or invite.' }); return; }
    const reason = typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim() : null;
    const r = requests.add(requesterOf(res), change, reason, body.expiresAt);
    if (!r.ok) { res.status(409).json({ error: r.error, detail: 'There is already a request waiting for the owner.' }); return; }
    res.status(201).json({ id: r.request.id, expiresAt: r.request.expiresAt, detail: 'The owner will see this in the app.' });
  }));

  router.get('/mobile/team/requests', (req, res) => {
    if (!ownerDevice(req, res)) return;
    const state = svc.teamLog()?.state();
    const nameOf = (key: string) => state?.people.get(key)?.name ?? 'someone';
    const titleOf = (ref: string) => deps.conversationTitle(ref) ?? 'a conversation';
    res.json({ requests: requests.open().map((r) => ({
      id: r.id, requester: { kind: r.requester.kind, label: r.requester.label }, change: r.change, summary: requestSummary(r, nameOf, titleOf),
      reason: r.reason, createdAt: r.createdAt, expiresAt: r.expiresAt,
    })) });
  });

  router.post('/mobile/team/requests/:id/decline', (req, res) => {
    if (!ownerDevice(req, res)) return;
    if (!requests.close(String(req.params.id))) { res.status(404).json({ error: 'request-gone', detail: 'That request has expired or was already answered.' }); return; }
    res.json({ ok: true });
  });

  router.get('/mobile/team/context', (req, res) => {
    if (!ownerDevice(req, res)) return;
    const owner = deps.ownerProfile();
    const log = svc.teamLog();
    res.json({
      ownerPersonKey: log?.state().ownerPersonKey ?? owner.userId, ownerLinks: owner.links, several: owner.several,
      teamOn: svc.teamOn(), refusal: svc.teamRefusal(), held: log?.gaps() ?? [], openRequests: requests.open().length,
      machinesBelowFloor: svc.teamPuller?.belowFloor() ?? [], waitingOn: svc.teamPuller?.waitingOn() ?? [],
      // What marking a machine as gone has to name: each stream held here and how far it runs.
      streams: log?.vector() ?? {},
      // Restore is offered up front, not only after a write fails.
      record: { health: log?.healthState() ?? 'absent', restoreNeeded: !!log && (log.healthState() === 'unreadable' || log.readConfined() === null) },
      // An invite makes these phones read-only into sessions with the owner's reach (§3.2).
      mspPhones: svc.devices.list().filter((d) => d.role === 'msp' && d.status === 'active').map((d) => {
        const p = svc.personOfDevice(d);
        return { deviceName: d.deviceName, personName: p.ok ? p.name : null };
      }),
      people: [...(log?.state().people.values() ?? [])].map((p) => ({ personKey: p.personKey, name: p.name, role: p.role })),
    });
  });

  router.post('/mobile/team/invites', write(async (req, res) => {
    const deviceId = ownerDevice(req, res);
    if (!deviceId) return;
    const stop = svc.teamRefusal();
    if (stop) { res.status(409).json({ error: stop, detail: refuseText[stop] }); return; }
    if (!floorOk(res)) return;
    // Nobody may invite a person they could not later remove: turning access off takes Face ID.
    if (!svc.devices.get(deviceId)?.presenceKey) { res.status(409).json({ error: 'face-id-required', detail: 'Set up Face ID for this phone in the app first, so you can turn team access off later.' }); return; }
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
    const adds = events.filter((e): e is Extract<RequestEvent, { type: 'person-add' }> => e.type === 'person-add');
    if (adds.length !== 1) { res.status(400).json({ error: 'person-required', detail: 'An invite names one person.' }); return; }
    const add = adds[0];
    const mismatch = requestCheck(req, events);
    if (mismatch) { send(res, mismatch); return; }
    if (!log.state().on && !(events.some((e) => e.type === 'team-on') && events.some((e) => e.type === 'owner-pin'))) {
      res.status(400).json({ error: 'first-invite-incomplete', detail: 'The first invite also turns team access on.' });
      return;
    }
    if (log.everHeld(add.personKey)) { res.status(409).json({ error: 'person-key-used', detail: 'That person was on this agent before. Invite them as someone new.' }); return; }
    // The link first: its code means nothing until the person is in the log, and a mint that fails here
    // leaves nothing saved or confined, so a plain retry works.
    const link = svc.mintTeamLink(add.personKey, typeof body.label === 'string' ? body.label : null);
    if (!link.ok) { res.status(link.status).json({ error: link.error }); return; }
    const refused = await applyGrants(events);
    if (refused) { send(res, refused); return; }
    await underLocks(grantRefs(events), () => appendRequest(req, deviceId));
    closeAnswered(req);
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
    if (!floorOk(res)) return;
    const events = eventsOf(req, res);
    if (!events) return;
    const mismatch = requestCheck(req, events);
    if (mismatch) { send(res, mismatch); return; }
    const refused = await applyGrants(events);
    if (refused) { send(res, refused); return; }
    await underLocks(grantRefs(events), () => appendRequest(req, deviceId));
    closeAnswered(req);
    res.json({ ok: true });
  }));

  router.post('/mobile/team/people/:personKey', write(async (req, res) => {
    const deviceId = ownerDevice(req, res);
    if (!deviceId) return;
    const events = eventsOf(req, res);
    if (!events) return;
    const log = svc.teamLog();
    if (!log?.state().people.has(String(req.params.personKey))) { res.status(404).json({ error: 'unknown-person', detail: 'That person is not on this agent.' }); return; }
    const mismatch = requestCheck(req, events);
    if (mismatch) { send(res, mismatch); return; }
    await underLocks(refsOf(String(req.params.personKey)), () => appendRequest(req, deviceId));
    if (events.some((e) => e.type === 'person-remove')) svc.revokePersonPhones(String(req.params.personKey));
    closeAnswered(req);
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
    res.json({ lines: activityLines(svc.teamLog()?.allRows() ?? []).slice(-200) });
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
    // One change per row: the log applies only one, so asking for two must not answer ok.
    if ([ref, role, b.remove === true ? true : undefined].filter((x) => x !== undefined).length > 1) { res.status(400).json({ error: 'one-change-at-a-time' }); return; }
    const refs = ref ? [ref] : refsOf(personKey);
    await underLocks(refs, () => { log.appendMachineEvents([{ type: 'lower', personKey, ...(ref ? { ref } : {}), ...(role ? { role } : {}), ...(b.remove === true ? { remove: true } : {}) }]); });
    if (b.remove === true) svc.revokePersonPhones(personKey);
    res.json({ ok: true });
  }));

  return router;
}
