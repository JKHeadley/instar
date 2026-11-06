/**
 * The session screen's controls for the Instar iPhone app (docs/specs/mobile-native-session-controls.md).
 *
 *   GET /mobile/sessions/controls?name=<tmux>[&machine=<id>]  what the menu shows, in the phone's words
 *   GET /mobile/sessions/new-options[?machine=<id>]           what a new session can pick
 *   GET /mobile/sessions/history?name=<tmux>[&machine&before&limit]  the conversation record, secrets removed
 *
 * The Face ID-confirmed writes are routed in mobilePermissionsRoutes.ts (one gate, challenge store and
 * audit file) and run `runSessionAction` below.
 *
 * There is no second copy of what a session control does. Every read and write here calls the
 * dashboard's own route (`call`, with this server's token, or on the machine that holds the session), so
 * that route's rules and refusals stay in force and its answer reaches the phone. This file only trims
 * the answers and says them plainly; the dashboard's words live in dashboard/console/sessions-model.js
 * and are mirrored here because a server module cannot import the dashboard's.
 */
import type { Request, Response, Router } from 'express';
import { ownerOrBearer } from './mobileCapacityRoutes.js';
import { DEVICE_SESSION_NAME_RE, NOT_RUNNING_REASON, redactDeep, redactForDevice, peerTooOldReason } from './mobileSessionTerminalRoutes.js';
import type { ActionResult, SessionAction } from './mobilePermissionsRoutes.js';
import { verifiedEntityName } from '../messaging/shared/channelIdentity.js';

export const MOBILE_SESSION_CONTROLS_SCHEMA_VERSION = 1;
/** The dashboard's attachment limit (routes.ts DASHBOARD_ATTACHMENT_MAX_BYTES). */
export const ATTACH_MAX_BYTES = 8 * 1024 * 1024;
export const HISTORY_MAX_ENTRIES = 100;
export const HISTORY_ENTRY_MAX_CHARS = 8000;
export const OPEN_CONSOLE = 'To change this, open the console.';
/**
 * What a person reads for a door (the AI tool a session runs on). One place, mirroring the console's
 * sessions-model.js DOOR, so the word can change without touching the API, which keeps `framework`.
 */
export const DOOR = { word: 'door', Word: 'Door', words: 'doors' } as const;

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {});
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/** A dashboard route's answer; status 0 means it could not be reached at all. */
export interface RouteAnswer { status: number; body: unknown }

export interface MobileSessionControlsDeps {
  /** Call a dashboard route with the agent's token: on this server, or on `machine` when that is another machine. */
  call: (method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown, machine?: string | null) => Promise<RouteAnswer>;
  /** What this caller may change here (the permission routes' `actionsState`). */
  actions: (req: Request) => unknown;
  bearerOk: (req: Request) => boolean;
  selfMachineId: () => string | null;
  /** This machine's registry name for a machine. */
  nicknameOf?: (machineId: string) => string | null;
  /** Values removed from anything read out of a conversation. */
  secrets: () => Array<string | null | undefined>;
  now?: () => number;
}

// ── words (mirroring dashboard/console/sessions-model.js) ──────────────────────

export function modelWords(id: unknown): string | null {
  if (typeof id !== 'string' || !id) return null;
  const cap = (w: string): string => w.charAt(0).toUpperCase() + w.slice(1);
  let m = /^(fable|opus|sonnet|haiku)$/i.exec(id);
  if (m) return `${cap(m[1]!.toLowerCase())}, version not recorded`;
  m = /^claude-(fable|opus|sonnet|haiku)-(\d+)(?:-(\d{1,2}))?(?:-(\d{8}))?$/.exec(id);
  if (m) return `${cap(m[1]!)} ${m[2]}${m[3] ? '.' + m[3] : ''}`;
  m = /^gpt-(\d+(?:\.\d+)?)(?:-([a-z]+))?$/.exec(id);
  if (m) return `GPT-${m[1]}${m[2] ? ' ' + cap(m[2]) : ''}`;
  return id;
}

export function modelOptionWords(id: string): string {
  if (/^(fable|opus|sonnet|haiku)$/.test(id)) return `${id.charAt(0).toUpperCase()}${id.slice(1)} (latest)`;
  return modelWords(id) ?? id;
}

export function regimeWords(regime: unknown): string | null {
  if (regime === 'dry-run') return `On this agent a chosen model is recorded as intent, not applied; the ${DOOR.word} still switches.`;
  if (regime === 'disabled') return `On this agent the ${DOOR.word} switch works, but model choice is turned off; a model will be refused.`;
  return null;
}

export function profileSourceWords(profile: unknown): string {
  const p = rec(profile);
  const src = rec(rec(p.resolved).sources).framework;
  const by = rec(p.pin).updatedBy;
  if (src === 'profile-pin' && (by === 'system:dashboard-create' || by === 'system:new-topic-default')) return 'set when it was created';
  if (src === 'profile-pin') return 'pinned by you';
  return 'the default';
}

export interface MobileDoor { framework: string; label: string; selectable: boolean; reason: string | null; defaultModel: string | null; models: Array<{ id: string; label: string }> }

/** The doors, each with its models. Dated twins are folded away, as the console does. */
export function doorRows(options: unknown): MobileDoor[] {
  const doors = Array.isArray(rec(options).doors) ? rec(options).doors as unknown[] : [];
  return doors.map(rec).filter((d) => typeof d.framework === 'string').map((d) => {
    const models = (Array.isArray(d.models) ? d.models : []).filter((m): m is string => typeof m === 'string');
    const set = new Set(models);
    const shown = models.filter((m) => { const dated = /^(.*)-\d{8}$/.exec(m); return !(dated && set.has(dated[1]!)); });
    let label = str(d.label) ?? String(d.framework);
    if (d.availability === 'assumed') label += ' (not verified)';
    const selectable = d.selectable === true;
    return {
      framework: String(d.framework), label, selectable,
      reason: selectable ? null : (str(d.reason) ?? 'unavailable'),
      defaultModel: str(d.defaultModel),
      models: shown.map((id) => ({ id, label: modelOptionWords(id) })),
    };
  });
}

export function doorModelWords(doors: MobileDoor[], framework: unknown, model: unknown): string {
  const door = doors.find((d) => d.framework === framework);
  return `${door ? door.label : String(framework)} · ${typeof model === 'string' && model ? modelOptionWords(model) : 'Account default'}`;
}

export interface MobileMachine { machineId: string; label: string; selectable: boolean; reason: string | null; here: boolean }

/** The machines a session can go to; null below two. A machine that can't be picked says why. */
export function machineRows(pool: unknown): { selfMachineId: string | null; rows: MobileMachine[] } | null {
  const p = rec(pool);
  const machines = (Array.isArray(p.machines) ? p.machines : []).map(rec).filter((m) => typeof m.machineId === 'string');
  if (machines.length < 2) return null;
  const self = str(p.selfMachineId);
  const nameOf = (m: Rec): string | null => verifiedEntityName(String(m.machineId), typeof m.nickname === 'string' ? m.nickname : undefined) ?? null;
  // A machine shown under the same name as another can't be told apart, so it isn't offered.
  const seen = new Map<string, number>();
  for (const m of machines) { const n = (nameOf(m) ?? '').toLowerCase(); if (n) seen.set(n, (seen.get(n) ?? 0) + 1); }
  const rows = machines.map((m): MobileMachine => {
    const id = String(m.machineId);
    const name = nameOf(m);
    let reason: string | null = null;
    if (m.online !== true) {
      const ls = rec(m.liveness).state;
      reason = ls === 'unreachable' ? 'not answering' : ls === 'stale' ? 'not checked recently' : 'no recent contact';
    } else if (m.clockSkewStatus === 'suspect-clock-removed') reason = 'clock out of step';
    else if (!name) reason = 'name unavailable';
    else if ((seen.get(name.toLowerCase()) ?? 0) > 1) reason = 'another machine has the same name';
    const atLimit = rec(m.quotaState).blocked === true;
    return { machineId: id, label: `${name ?? 'Machine name unavailable'}${id === self ? ' (this machine)' : ''}${!reason && atLimit ? ' (at usage limit)' : ''}`, selectable: reason === null, reason, here: id === self };
  });
  return { selfMachineId: self, rows };
}

/** The Telegram topic a session belongs to, when it has one. Door and machine work on those, as on the dashboard. */
export function topicOf(row: Rec): number | null {
  const n = Number(row.platform === 'telegram' ? row.platformId : NaN);
  return Number.isSafeInteger(n) && n > 1 ? n : null;
}

function chatWords(row: Rec): string {
  if (row.platform === 'telegram') return 'a Telegram topic';
  if (row.platform === 'slack') return 'Slack';
  if (row.platform === 'whatsapp') return 'WhatsApp';
  return 'none (terminal only)';
}

const NOT_A_TOPIC = `${DOOR.Word} and machine can be changed for Telegram conversations. This session has no Telegram topic.`;
const ONE_MACHINE = 'This agent runs on one machine, so there is nowhere to move it.';
const CANT_READ_DOORS = `Can't read the ${DOOR.words} and models right now.`;
const CANT_READ_MACHINES = "Can't read the machines right now.";

// ── reads ──────────────────────────────────────────────────────────────────────

export interface ControlsParts {
  row: Rec;
  remote: boolean;
  options: RouteAnswer | null;
  profile: RouteAnswer | null;
  pool: RouteAnswer;
  /** The other machine's own rule about typing from another machine; null = it did not say (older, or not answering). */
  peerInput: boolean | null;
}

/** The menu's answer. Pure, so the decisions are tested on both sides. */
export function summarizeControls(parts: ControlsParts, actions: unknown, now: number): Rec {
  const { row, remote } = parts;
  const t = rec(row.telemetry);
  const topic = topicOf(row);
  const machines = parts.pool.status === 200 ? machineRows(parts.pool.body) : null;
  const machineId = str(row.machineId);

  let door: Rec;
  if (topic === null) door = { state: 'not-this-chat', reason: NOT_A_TOPIC, doors: [] };
  else if (!parts.options || parts.options.status !== 200 || !parts.profile || parts.profile.status !== 200) door = { state: 'unavailable', reason: CANT_READ_DOORS, doors: [] };
  else {
    const doors = doorRows(parts.options.body);
    const resolved = rec(rec(parts.profile.body).resolved);
    door = {
      state: 'ok', reason: null, topic: String(topic), doors,
      framework: str(resolved.framework), model: str(resolved.model),
      now: doorModelWords(doors, resolved.framework, resolved.model),
      source: profileSourceWords(parts.profile.body),
      note: regimeWords(rec(parts.options.body).regime),
    };
  }

  let move: Rec;
  if (topic === null) move = { state: 'not-this-chat', reason: NOT_A_TOPIC, choices: [] };
  else if (parts.pool.status !== 200) move = { state: 'unavailable', reason: CANT_READ_MACHINES, choices: [] };
  else if (!machines) move = { state: 'one-machine', reason: ONE_MACHINE, choices: [] };
  else move = { state: 'ok', reason: null, topic: String(topic), choices: machines.rows.filter((m) => m.machineId !== machineId) };

  // A session here takes typing, keys and files. On another machine, that machine's rule decides.
  const typing = !remote || parts.peerInput === true;
  const typingReason = typing ? null : parts.peerInput === false
    ? `Typing to ${str(row.machineNickname) ?? 'that machine'} from another machine is switched off there. Move this session here to type to it.`
    : `${str(row.machineNickname) ?? 'That machine'} needs the latest Instar update before this phone can type to its sessions. Move this session here to type to it.`;

  return {
    schemaVersion: MOBILE_SESSION_CONTROLS_SCHEMA_VERSION,
    generatedAt: new Date(now).toISOString(),
    actions,
    session: {
      tmuxSession: row.tmuxSession, id: row.id, name: row.name,
      machineId, machine: str(row.machineNickname), remote,
      model: str(row.model), modelWords: modelWords(row.model),
      kind: row.type === 'job' || row.jobSlug ? 'a scheduled job' : 'a conversation',
      chat: chatWords(row), startedAt: str(row.startedAt), lastActivity: str(t.lastActivity),
      tools: Array.isArray(t.toolsUsed) ? t.toolsUsed.filter((x) => typeof x === 'string').slice(0, 30) : [],
      backgroundTasks: Array.isArray(t.subagentsSpawned) ? t.subagentsSpawned.length : null,
      eventCount: typeof t.eventCount === 'number' ? t.eventCount : null,
      protected: row.protected === true,
    },
    door,
    move,
    close: { confirm: closeConfirmWords(row, remote) },
    typing: { can: typing, reason: typingReason },
    attach: { can: typing, reason: typingReason, maxBytes: ATTACH_MAX_BYTES },
  };
}

export function closeConfirmWords(row: Rec, remote: boolean): string[] {
  const where = remote ? ` on ${str(row.machineNickname) ?? 'another machine'}` : '';
  const lines = [`Close this session${where}? Its conversation is kept.`];
  if (row.protected === true) lines.push('This one is normally kept running.');
  else if (remote && row.protected === undefined) lines.push('That machine did not say whether this one is normally kept running.');
  return lines;
}

/** What a new session can pick. */
export function summarizeNewOptions(options: RouteAnswer, pool: RouteAnswer, actions: unknown, now: number): Rec {
  const o = options.status === 200 ? rec(options.body) : {};
  const doors = doorRows(o);
  const def = rec(o.newTopicDefault);
  const machines = pool.status === 200 ? machineRows(pool.body) : null;
  return {
    schemaVersion: MOBILE_SESSION_CONTROLS_SCHEMA_VERSION,
    generatedAt: new Date(now).toISOString(),
    actions,
    doorsState: options.status === 200 ? 'ok' : 'unavailable',
    doorsReason: options.status === 200 ? null : `Can't list the ${DOOR.words} right now. The session starts on the agent default.`,
    doors,
    note: regimeWords(o.regime),
    defaultFramework: str(def.framework),
    defaultModel: str(def.model),
    defaultWords: str(def.framework) ? `New topics start on ${doorModelWords(doors, def.framework, def.model)}${def.replication === 'local-only' ? ' (this machine only)' : ''}.` : 'New topics start on the agent default.',
    machines: machines ? machines.rows : [],
  };
}

// ── writes ─────────────────────────────────────────────────────────────────────

const fail = (status: number, error: string, message: string, extra: Rec = {}): ActionResult => ({ status, body: { ok: false, error, message, ...extra } });
const couldNotReach = (status: number): string => (status ? `the agent answered ${status}` : "the agent couldn't be reached");

/**
 * Words for a move that did not go. The route's own `error` names reasons for an engineer, so each
 * known refusal is said plainly here.
 */
export function moveAnswer(r: RouteAnswer, machineLabel: string): ActionResult {
  const b = rec(r.body);
  if (r.status === 200 && b.ok === true) {
    const name = str(b.targetNickname) ?? machineLabel;
    if (b.action === 'noop') return { status: 200, body: { ok: true, moved: true, message: `It is already on ${name}.` } };
    if (b.seatMoved !== true) return { status: 200, body: { ok: true, moved: false, message: `It is set to move to ${name}, but the move hasn't finished. Your next message there finishes it, or try again.` } };
    const paused = b.autonomousRunSuspended === true ? ' Its autonomous run was paused for the move and carries on there.' : '';
    return { status: 200, body: { ok: true, moved: true, message: `Moved to ${name}. The conversation carries on there with your next message.${paused}` } };
  }
  if (r.status === 409 && b.needsConfirmation === true) {
    return { status: 409, body: { ok: false, error: 'needs-confirmation', message: str(b.prompt) ?? `Move to ${machineLabel} anyway?`, confirmationChallenge: b.confirmationChallenge } };
  }
  if (r.status === 409 && b.rejectReason === 'rate-limited') return fail(409, 'rate-limited', 'This conversation moved a moment ago. Wait a minute and try again.');
  if (r.status === 409 && b.retryRequired === true) return fail(409, 'retry', 'Something else moved this conversation while checking. Try again.');
  if (r.status === 409 && b.failedNeedsRetry === true) return fail(409, 'retry', 'It stayed where it is: the machine it runs on could not close it for the move. Try again in a moment.');
  if (r.status === 404) return fail(404, 'unknown-machine', "This agent doesn't know that machine. Pull to refresh and pick again.");
  if (r.status === 503) return fail(503, 'pool-off', 'Moving between machines is off on this agent, so it stays where it is.');
  return fail(r.status || 502, 'not-moved', `It stayed where it is: ${couldNotReach(r.status)}. Try again in a moment.`);
}

/** The console's closeResultWords. */
export function closeAnswer(remote: boolean, r: RouteAnswer): ActionResult {
  const d = rec(r.body);
  if (remote) {
    if (r.status === 200 && d.alreadyClosed === true) return { status: 200, body: { ok: true, gone: true, message: 'It was already closed.' } };
    if (r.status === 200) return { status: 200, body: { ok: true, message: 'Closed.' } };
    if (d.outcomeUnknown === true) return { status: 200, body: { ok: false, unknown: true, message: "The other machine didn't answer in time, so this may or may not have closed. Go back to the sessions list to check." } };
    if (r.status === 404) return fail(404, 'unknown-machine', "This agent doesn't know that machine any more. Go back to the sessions list.");
    return fail(r.status || 502, 'not-closed', `Not closed: ${couldNotReach(r.status)}. Try again in a moment.`);
  }
  if (r.status === 200) return { status: 200, body: { ok: true, message: 'Closed.' } };
  if (r.status === 404) return { status: 200, body: { ok: true, gone: true, message: 'It was already closed.' } };
  if (r.status === 409) return fail(409, 'kept-running', 'Not closed: the agent kept it running, because it is protected or busy. Try again in a moment.');
  return fail(r.status || 502, 'not-closed', `Not closed: ${couldNotReach(r.status)}. Try again in a moment.`);
}

/** The console's createResultWords. */
export function newSessionAnswer(r: RouteAnswer, name: string, machineLabel: string | null): ActionResult {
  const d = rec(r.body);
  const machine = rec(d.machine);
  const where = verifiedEntityName(String(machine.machineId ?? ''), typeof machine.nickname === 'string' ? machine.nickname : undefined) ?? machineLabel ?? 'the chosen machine';
  if (!(r.status >= 200 && r.status < 300)) {
    return fail(r.status || 502, 'not-created', str(d.error) ?? str(d.message) ?? `Not started: ${couldNotReach(r.status)}. Try again in a moment.`);
  }
  if (d.ownership === 'superseded' || d.ownership === 'not-confirmed') return { status: 200, body: { ok: true, warn: true, message: `"${name}" was created, but which machine owns it isn't settled yet. Send it a message and it starts.` } };
  if (d.started === 'unknown') return { status: 200, body: { ok: true, warn: true, message: `"${name}" may still be starting on ${where}. Pull to refresh the list in a moment.` } };
  if (d.started === 'requested' && d.machine) return { status: 200, body: { ok: true, message: `Starting "${name}" on ${where}.` } };
  return { status: 200, body: { ok: true, message: `Started "${name}"${d.machine ? ` on ${where}` : ''}.` } };
}

/** Door and model apply to Telegram topics only; so does the machine choice. */
const platformAllowsDoor = (p: string): boolean => p !== 'headless' && p !== 'slack';

/** The exact POST /sessions/create body (the console's createBody). An unchanged pick sends nothing, so the server seeds its own default. */
export function createBody(a: Extract<SessionAction, { kind: 'session-new' }>, newTopicDefault: unknown): Rec {
  const body: Rec = { name: a.name, headless: a.platform === 'headless' };
  if (a.platform !== 'auto') body.platform = a.platform;
  if (platformAllowsDoor(a.platform) && a.framework) {
    const def = rec(newTopicDefault);
    const differs = !def.framework || def.framework !== a.framework || (def.model ?? null) !== a.model;
    if (differs) { body.framework = a.framework; body.model = a.model; }
  }
  if (platformAllowsDoor(a.platform) && a.machine) body.machine = a.machine;
  return body;
}

/**
 * One Face ID-confirmed session control. A door the dashboard wouldn't offer is refused here, because
 * /topic-profile/:id itself accepts pins the dashboard's menus don't (a chat pin may name a door this
 * machine lacks), and a phone runs what the menu offers.
 */
export async function runSessionAction(a: SessionAction, deps: Pick<MobileSessionControlsDeps, 'call' | 'selfMachineId'>): Promise<ActionResult> {
  const self = deps.selfMachineId();
  const elsewhere = (m: string | null): boolean => !!m && m !== self;
  // A line that names a machine runs there or not at all. With no mesh id here, that machine can't be reached.
  if ((a.kind === 'session-door' || a.kind === 'session-close') && a.machine && !self) return fail(409, 'machine-unknown', "This agent can't reach that machine. Go back to the sessions list.");
  switch (a.kind) {
    case 'session-door': {
      const machine = elsewhere(a.machine) ? a.machine : null;
      const options = await deps.call('GET', '/topic-profile/options', undefined, machine);
      if (options.status !== 200) return fail(options.status === 503 ? 503 : 502, 'doors-unavailable', `Not switched: can't read the ${DOOR.words} and models right now. Try again in a moment.`);
      const door = doorRows(options.body).find((d) => d.framework === a.framework);
      if (!door || !door.selectable) return fail(409, 'door-not-offered', `Not switched: ${door ? `${door.label} can't be used here (${door.reason ?? 'unavailable'})` : `that ${DOOR.word} isn't offered here`}.`);
      if (a.model !== null && !door.models.some((m) => m.id === a.model)) return fail(409, 'model-not-offered', `Not switched: that model isn't offered on ${door.label}.`);
      const r = await deps.call('POST', `/topic-profile/${encodeURIComponent(a.target)}`, { framework: a.framework, model: a.model }, machine);
      const b = rec(r.body);
      if (r.status >= 200 && r.status < 300 && b.ok === true) {
        return { status: 200, body: { ok: true, noop: b.noop === true, message: str(b.message) ?? (b.noop === true ? 'It is already on that.' : `Switching. The session restarts on the new ${DOOR.word}.`) } };
      }
      // The route's own refusal, in its own words (only a bound operator may, cooling down, and so on).
      return fail(r.status || 502, 'door-refused', str(b.message) ?? str(b.error) ?? `Not switched: ${couldNotReach(r.status)}. Try again in a moment.`);
    }
    case 'session-move': {
      const pool = await deps.call('GET', '/pool');
      if (pool.status !== 200) return fail(503, 'machines-unavailable', "It stayed where it is: can't read the machines right now. Try again in a moment.");
      const row = machineRows(pool.body)?.rows.find((m) => m.machineId === a.to);
      if (!row) return fail(404, 'unknown-machine', "This agent doesn't know that machine. Pull to refresh and pick again.");
      if (!row.selectable) return fail(409, 'machine-not-available', `It stayed where it is: that machine can't take it (${row.reason}).`);
      const r = await deps.call('POST', '/pool/transfer', { topic: a.target, to: a.to, ...(a.confirmation ? { confirm: true, confirmationChallenge: a.confirmation } : {}) });
      return moveAnswer(r, row.label.replace(/ \(.*\)$/, ''));
    }
    case 'session-close': {
      const remote = elsewhere(a.machine);
      const r = remote
        ? await deps.call('POST', `/sessions/${encodeURIComponent(a.tmux)}/remote-close`, { machineId: a.machine, sessionUuid: a.target })
        : await deps.call('DELETE', `/sessions/${encodeURIComponent(a.target)}`);
      return closeAnswer(remote, r);
    }
    case 'session-new': {
      const machine = a.machine && platformAllowsDoor(a.platform) ? a.machine : null;
      const options = await deps.call('GET', '/topic-profile/options');
      const body = createBody(a, rec(options.body).newTopicDefault);
      const r = await deps.call('POST', '/sessions/create', body);
      return newSessionAnswer(r, a.name, machine);
    }
    case 'session-default': {
      const r = await deps.call('POST', '/topic-profile/new-topic-default', a.framework ? { framework: a.framework, model: a.model } : { clear: true });
      const b = rec(r.body);
      if (r.status >= 200 && r.status < 300) {
        if (!a.framework) return { status: 200, body: { ok: true, message: 'Cleared. Topics created here start on the agent defaults.' } };
        return { status: 200, body: { ok: true, message: `Saved. New topics created here start on ${a.model ? modelOptionWords(a.model) : 'the account default'}.` } };
      }
      return fail(r.status || 502, 'default-refused', str(b.error) ?? `Not saved: ${couldNotReach(r.status)}. Try again in a moment.`);
    }
  }
}

// ── routes ─────────────────────────────────────────────────────────────────────

export function mountMobileSessionControlsRoutes(router: Router, deps: MobileSessionControlsDeps): void {
  const now = () => (deps.now ? deps.now() : Date.now());
  const guard = (req: Request, res: Response): boolean => {
    res.set('Cache-Control', 'no-store');
    if (ownerOrBearer(req, deps.bearerOk)) return true;
    res.status(403).json({ error: 'owner-phone-required', reason: "Only the owner's phone can open sessions." });
    return false;
  };

  router.get('/mobile/sessions/controls', async (req: Request, res: Response) => {
    if (!guard(req, res)) return;
    const name = typeof req.query.name === 'string' ? req.query.name : '';
    if (!DEVICE_SESSION_NAME_RE.test(name)) { res.status(400).json({ error: 'bad-session-name' }); return; }
    const want = typeof req.query.machine === 'string' && req.query.machine ? req.query.machine : null;
    const self = deps.selfMachineId();
    const list = await deps.call('GET', '/sessions?scope=pool');
    if (list.status !== 200) { res.status(503).json({ error: 'sessions-unavailable', reason: "Can't read the sessions right now." }); return; }
    const rows = (Array.isArray(rec(list.body).sessions) ? rec(list.body).sessions as unknown[] : Array.isArray(list.body) ? list.body as unknown[] : []).map(rec);
    const named = rows.filter((r) => r.tmuxSession === name);
    // The phone's machine when it knows one; otherwise this machine's session first, since a tmux name repeats across machines.
    const row = want ? named.find((r) => r.machineId === want || (!r.machineId && want === self)) : named.find((r) => r.remote !== true) ?? named[0];
    if (!row) { res.status(404).json({ error: 'session-not-running', reason: NOT_RUNNING_REASON }); return; }
    const remote = row.remote === true;
    const machine = remote ? str(row.machineId) : null;
    const topic = topicOf(row);
    const [options, profile, pool, relayState] = await Promise.all([
      topic === null ? Promise.resolve(null) : deps.call('GET', '/topic-profile/options', undefined, machine),
      topic === null ? Promise.resolve(null) : deps.call('GET', `/topic-profile/${topic}`, undefined, machine),
      deps.call('GET', '/pool'),
      remote ? deps.call('GET', `/mobile/sessions/relay/${encodeURIComponent(name)}/state`, undefined, machine) : Promise.resolve(null),
    ]);
    const peerInput = relayState && relayState.status === 200 ? rec(relayState.body).inputAllowed === true : null;
    res.json(summarizeControls({ row, remote, options, profile, pool, peerInput }, deps.actions(req), now()));
  });

  router.get('/mobile/sessions/new-options', async (req: Request, res: Response) => {
    if (!guard(req, res)) return;
    const machine = typeof req.query.machine === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(req.query.machine) ? req.query.machine : '';
    const [options, pool] = await Promise.all([
      deps.call('GET', machine ? `/topic-profile/options?machine=${encodeURIComponent(machine)}` : '/topic-profile/options'),
      deps.call('GET', '/pool'),
    ]);
    res.json(summarizeNewOptions(options, pool, deps.actions(req), now()));
  });

  /** One page of THIS machine's record for a session, with this machine's secrets removed. */
  const localHistory = async (name: string, q: URLSearchParams): Promise<{ status: number; body: Rec }> => {
    const r = await deps.call('GET', `/sessions/${encodeURIComponent(name)}/transcript?${q}&redact=device`);
    const b = rec(r.body);
    if (r.status !== 200 || !Array.isArray(b.entries)) {
      const reason = b.reason === 'no-transcript' ? 'This session has no conversation record yet.'
        : r.status === 404 ? 'This session has no conversation record here.'
          : `Can't read it: ${couldNotReach(r.status)}.`;
      return { status: r.status === 404 ? 404 : 503, body: { error: 'history-unavailable', reason } };
    }
    let secrets: Array<string | null | undefined> = [];
    try { secrets = deps.secrets(); } catch { secrets = []; } // @silent-fallback-ok — the sig= rewrite still applies
    const entries = (b.entries as unknown[]).slice(-HISTORY_MAX_ENTRIES).map(rec).map((e) => ({
      // Removed before the cut, so a cut can't leave the start of a secret behind.
      role: e.role === 'user' || e.role === 'assistant' || e.role === 'tool' ? e.role : 'assistant',
      text: typeof e.text === 'string' ? redactForDevice(e.text, secrets).slice(0, HISTORY_ENTRY_MAX_CHARS) : '',
      at: str(e.at),
    })).filter((e) => e.text);
    return { status: 200, body: { schemaVersion: MOBILE_SESSION_CONTROLS_SCHEMA_VERSION, entries, nextBefore: typeof b.nextBefore === 'number' ? b.nextBefore : null } };
  };
  const historyQuery = (req: Request): URLSearchParams => {
    const q = new URLSearchParams();
    const limit = Number(req.query.limit);
    q.set('limit', String(Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, HISTORY_MAX_ENTRIES) : 50));
    if (typeof req.query.before === 'string' && /^\d{1,16}$/.test(req.query.before)) q.set('before', req.query.before);
    return q;
  };

  // The conversation record, a page at a time. Secrets are removed from each entry: a conversation
  // can quote one, and what a phone receives must not outlive its revocation. Another machine's record
  // is read through that machine's relay route, because only it knows its own secrets.
  router.get('/mobile/sessions/history', async (req: Request, res: Response) => {
    if (!guard(req, res)) return;
    const name = typeof req.query.name === 'string' ? req.query.name : '';
    if (!DEVICE_SESSION_NAME_RE.test(name)) { res.status(400).json({ error: 'bad-session-name' }); return; }
    const q = historyQuery(req);
    const machine = typeof req.query.machine === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(req.query.machine) ? req.query.machine : null;
    if (machine && machine !== deps.selfMachineId()) {
      const r = await deps.call('GET', `/mobile/sessions/relay/${encodeURIComponent(name)}/history?${q}`, undefined, machine);
      const b = rec(r.body);
      const nick = verifiedEntityName(machine, deps.nicknameOf?.(machine)) ?? null;
      if (r.status === 404 && b.error !== 'history-unavailable') { res.status(404).json({ error: 'history-unavailable', reason: peerTooOldReason(nick) }); return; }
      if (r.status !== 200 && r.status !== 404) { res.status(503).json({ error: 'history-unavailable', reason: "Can't read it: the session's machine didn't answer." }); return; }
      let secrets: Array<string | null | undefined> = [];
      try { secrets = deps.secrets(); } catch { secrets = []; } // @silent-fallback-ok — the sig= rewrite still applies
      res.status(r.status).json(redactDeep(b, secrets));
      return;
    }
    const a = await localHistory(name, q);
    res.status(a.status).json(a.body);
  });

  // The other side of that hop: the pool token only. No phone rule lists this path.
  router.get('/mobile/sessions/relay/:name/history', async (req: Request, res: Response) => {
    res.set('Cache-Control', 'no-store');
    if (!deps.bearerOk(req)) { res.status(403).json({ error: 'pool-token-required' }); return; }
    const name = String(req.params.name);
    if (!DEVICE_SESSION_NAME_RE.test(name)) { res.status(400).json({ error: 'bad-session-name' }); return; }
    const a = await localHistory(name, historyQuery(req));
    res.status(a.status).json(a.body);
  });
}
