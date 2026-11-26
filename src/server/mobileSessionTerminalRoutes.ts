/**
 * The native session screen for the Instar iPhone app (docs/specs/mobile-native-session-screen.md).
 *
 *   GET  /sessions/:name/output?lines=N   read a session's pane
 *   POST /sessions/:name/input {text}     type plain text into it
 *
 * The same paths serve the dashboard with the Bearer token; this router handles ONLY requests
 * signed by a paired phone and passes every other request on untouched (`next()`), so the Bearer
 * handlers in routes.ts keep their exact behaviour. It is mounted before the main routes.
 *
 * Device requests reach here only through the DEVICE_ALLOWLIST entries flagged `ownerOnly`: the
 * phone is active, its signature verified, and its person is the owner. On top of that the router
 * re-checks the owner, resolves the name to exactly one session record running on THIS machine
 * (tmux name, then id, then name; ambiguous → 409), refuses control characters in typed text,
 * reads the pane without blocking the event loop, and logs every typed message without its text.
 *
 * The session controls (docs/specs/mobile-native-session-controls.md) add a keys route and device
 * access to the dashboard's attachment route, and a hop to another machine: a request that names
 * another machine goes from here to that machine's `/mobile/sessions/relay/...` routes with the pool
 * token (the way the dashboard's stream and History already reach it). That machine resolves the
 * session, removes its own secrets and applies its own rule about typing from another machine. A peer
 * without those routes answers as before, so a mixed pool never types through a weaker path.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Router, type Request, type Response, type NextFunction } from 'express';
import type { MobilePairingService } from './mobilePairingRoutes.js';
import { devicePersonOf, deviceAdmittedHost } from './mobilePairingRoutes.js';
import { verifiedEntityName } from '../messaging/shared/channelIdentity.js';
import { REPLAY_TTL_MS, canonicalString } from '../core/MobileDeviceKeys.js';

/** The session name shape the Bearer routes accept (routes.ts SESSION_NAME_RE). */
export const DEVICE_SESSION_NAME_RE = /^[a-zA-Z0-9_-]{1,200}$/;
export const DEVICE_INPUT_MAX = 8000;
export const DEVICE_OUTPUT_DEFAULT_LINES = 200;
export const DEVICE_OUTPUT_MAX_LINES = 2000;
export const MISS_CACHE_FOUND_MS = 15_000;
export const MISS_CACHE_NEGATIVE_MS = 3_000;
export const MISS_NAMES_PER_DEVICE_PER_MINUTE = 8;
export const PEER_LOOKUP_TIMEOUT_MS = 3000;
export const PEER_LOOKUP_MAX = 16;
export const AUDIT_ROTATE_BYTES = 2 * 1024 * 1024;

export const NOT_RUNNING_REASON = 'This session is not running any more. It may have finished or been closed.';
export const LOCATION_UNKNOWN_REASON = 'I could not find which machine runs this session: the other machines did not answer.';
export const BAD_TEXT_REASON = 'Only plain text can be typed into a session from the phone.';
export const SEND_FAILED_REASON = 'The session could not take your text right now. It may be starting or restarting; try again in a moment.';
export const OWNER_ONLY_REASON = "Only the owner's phone can open sessions.";
export const SESSION_REPLACED_REASON = 'This session ended and a new one took its name. Reopen it from the sessions list.';
export const INPUT_BUSY_REASON = 'Too many messages were typed from phones in the last minute. Wait a moment and send again.';
/** Device inputs per minute across ALL phones on this machine (each holds the event loop briefly). */
export const DEVICE_INPUT_MACHINE_PER_MINUTE = 12;
/** The keys tray, exactly as the console's: nothing else reaches tmux from a phone. */
export const DEVICE_KEYS: ReadonlySet<string> = new Set(['Enter', 'y', 'n', 'Escape', 'Up', 'Down', 'Left', 'Right', 'C-c']);
/** Key presses per minute across all phones on this machine. A person works through a menu with several. */
export const DEVICE_KEY_MACHINE_PER_MINUTE = 60;
/** Attached file bytes per rolling hour on one machine, phones only: the console's route has no such limit, but a phone's key is not a console. */
export const DEVICE_ATTACH_BYTES_PER_HOUR = 200 * 1024 * 1024;
export const ATTACH_BUSY_REASON = 'A lot of files were attached from phones in the last hour. Wait a while and try again.';

/** The rolling hour of attached bytes. Counted as bytes once decoded. */
export class AttachmentWindow {
  private rows: Array<{ at: number; bytes: number }> = [];
  constructor(private readonly now: () => number = Date.now, private readonly limit = DEVICE_ATTACH_BYTES_PER_HOUR) {}
  admit(base64Chars: number): boolean {
    const t = this.now();
    const bytes = Math.floor(base64Chars * 3 / 4);
    this.rows = this.rows.filter((x) => t - x.at < 3_600_000);
    if (this.rows.reduce((sum, x) => sum + x.bytes, 0) + bytes > this.limit) return false;
    this.rows.push({ at: t, bytes });
    return true;
  }
}
export const BAD_KEY_REASON = 'That key cannot be sent from the phone.';
export const REMOTE_INPUT_OFF_REASON = 'Typing into sessions from another machine is switched off on that machine. To type to it, move this session to another machine from its menu.';

/** A session on a machine that has not updated yet: it can't be opened through this one. */
export function peerTooOldReason(nickname: string | null): string {
  return `${nickname ?? 'That machine'} needs the latest Instar update before this phone can open its sessions. It updates by itself soon. To open it now, move it to an updated machine from its menu.`;
}
export function peerUnreachableReason(nickname: string | null): string {
  return `${nickname ?? 'That machine'} isn't answering right now. It will keep trying.`;
}

/** The answer for a request bound to another machine: it repeats the phone's own claim. */
export function requestedMachineReason(nickname: string | null): string {
  return nickname ? `You opened a session on ${nickname}. Open it from ${nickname}.` : 'You opened a session on another of your machines. Open it from that machine.';
}

/**
 * Remove this agent's own credentials from pane text before a device sees it (mobile-device-keys
 * §2.3: nothing a device receives may outlive its revocation): the API token, the dashboard PIN,
 * and private-view `sig=` values. Values shorter than 4 characters are not replaced (they would
 * mangle ordinary text and are not credentials worth the name).
 */
export function redactForDevice(text: string, secrets: ReadonlyArray<string | null | undefined>): string {
  let out = text.replace(/([?&]sig=)[0-9a-fA-F]{16,}/g, '$1removed');
  const vals = [...new Set(secrets.filter((v): v is string => typeof v === 'string' && v.length >= 4))].sort((a, b) => b.length - a.length);
  for (const v of vals) out = out.split(v).join('[redacted]');
  return out;
}

/**
 * Fields that name something rather than say something: ids, times, a saved path, a route's binding. A short
 * numeric PIN can appear inside one by chance, and rewriting it would break what the phone does with it.
 */
const REDACT_EXEMPT_KEYS: ReadonlySet<string> = new Set(['path', 'confirmationChallenge', 'sessionId', 'session', 'tmuxSession', 'at', 'startedAt', 'generatedAt', 'error']);

/** The same removal over a whole answer: string values only, so an answer's shape and its numbers stay as they were. */
export function redactDeep<T>(value: T, secrets: ReadonlyArray<string | null | undefined>): T {
  if (typeof value === 'string') return redactForDevice(value, secrets) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, secrets)) as unknown as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, REDACT_EXEMPT_KEYS.has(k) ? v : redactDeep(v, secrets)])) as T;
  return value;
}
export const REPLAY_REASON = 'This exact request was already received, so it was not typed in again.';
export const REPLAY_RECORD_REASON = 'The agent could not record this request safely, so it was not typed in. Try again in a moment.';

/** The plain reason for a session another machine runs (the "Open session" sentence shape). */
export function otherMachineReason(nickname: string | null): string {
  return nickname
    ? `This session runs on ${nickname}. Open it from ${nickname}.`
    : 'This session runs on another of your machines, whose name I could not confirm.';
}

/** Any control character other than newline and tab: C0, DEL, C1. */
const CONTROL_RE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/;
export function isPlainDeviceText(text: string): boolean { return !CONTROL_RE.test(text); }

/** The fields of a session record the resolver reads. */
export interface SessionRecordLike { id: string; name: string; tmuxSession: string; status: string; startedAt?: string | null }

export type ResolveResult =
  | { kind: 'found'; session: SessionRecordLike }
  | { kind: 'ambiguous' }
  | { kind: 'missing' };

/**
 * Exactly one running/starting record, matched exactly: tmux name, then id, then name. The first
 * field that matches any record decides; two records matching on that field is ambiguous.
 */
export function resolveDeviceSession(records: readonly SessionRecordLike[], name: string): ResolveResult {
  const live = records.filter((r) => r.status === 'running' || r.status === 'starting');
  for (const field of ['tmuxSession', 'id', 'name'] as const) {
    const hits = live.filter((r) => r[field] === name);
    if (hits.length === 1) return { kind: 'found', session: hits[0] };
    if (hits.length > 1) return { kind: 'ambiguous' };
  }
  return { kind: 'missing' };
}

/** A peer's answer to "do you run this session?". */
export type PeerLookup = { machineId: string; found: boolean } | { machineId: string; failed: true };

export type MissAnswer =
  | { error: 'session-on-other-machine'; reason: string; ownerMachine: { machineId: string; nickname: string | null } }
  | { error: 'session-not-running'; reason: string }
  | { error: 'session-location-unknown'; reason: string };

/** Classify a local miss from the peers' answers (pure; never names a machine nobody reported). */
export function classifyMiss(answers: readonly PeerLookup[], nicknameOf: (id: string) => string | null): MissAnswer {
  const hits = answers.filter((a): a is { machineId: string; found: boolean } => 'found' in a && a.found);
  // Two machines listing the name: it does not identify one session, so no machine is named.
  if (hits.length > 1) return { error: 'session-location-unknown', reason: LOCATION_UNKNOWN_REASON };
  const hit = hits[0];
  if (hit) {
    const nick = verifiedEntityName(hit.machineId, nicknameOf(hit.machineId)) ?? null;
    return { error: 'session-on-other-machine', reason: otherMachineReason(nick), ownerMachine: { machineId: hit.machineId, nickname: nick } };
  }
  if (answers.some((a) => 'failed' in a)) return { error: 'session-location-unknown', reason: LOCATION_UNKNOWN_REASON };
  return { error: 'session-not-running', reason: NOT_RUNNING_REASON };
}

/** Does one peer's GET /sessions row list match `name` in the device order? */
export function peerRowsMatch(rows: unknown, name: string): boolean {
  if (!Array.isArray(rows)) return false;
  const live = rows.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object' && (r.status === 'running' || r.status === 'starting'));
  return (['tmuxSession', 'id', 'name'] as const).some((f) => live.some((r) => r[f] === name));
}

export interface MobileSessionTerminalDeps {
  pairing: MobilePairingService;
  /** This machine's session records (running ones are filtered here). */
  listSessions(): SessionRecordLike[];
  /** Non-blocking pane capture; null when the pane cannot be read. */
  captureOutputAsync(tmuxSession: string, lines: number): Promise<string | null>;
  /** The one injection funnel (SessionManager.sendInput). */
  sendInput(tmuxSession: string, text: string): boolean;
  /** Ask each peer (at most PEER_LOOKUP_MAX, in order) whether it runs `name`. Empty when single-machine. */
  lookupPeers(name: string): Promise<PeerLookup[]>;
  /** This machine's registry nickname for a machine id. */
  nicknameOf(machineId: string): string | null;
  /** This machine's verified name, for the answer header. */
  selfNickname(): string | null;
  /** This machine's mesh id (null on a single-machine install). */
  selfMachineId(): string | null;
  /** Values to redact from device output (the API token and dashboard PIN), read per request. */
  secrets(): Array<string | null | undefined>;
  /** One press of a named key (SessionManager.sendKey), the console's own path. */
  sendKey?(tmuxSession: string, key: string): boolean;
  /**
   * Call a route on another machine with the pool token. null when it can't be reached. Absent (or a
   * single-machine install): a session elsewhere is named, as before.
   */
  relayToPeer?(machineId: string, method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; body: unknown } | null>;
  /** This machine's rule about typing into its sessions from another machine (dashboard.poolStream.allowRemoteInput). */
  allowRemoteInput?(): boolean;
  /** The durable replay record for device input (defaults to <stateDir>/state/mobile-session-input-replay.json). */
  replayRecord?: DeviceInputReplayRecord;
  stateDir: string;
  now?: () => number;
}

type Principal = { kind: string; deviceId?: string };
/** A request the router will act on. `relayTo`: the machine it goes to instead of this one. */
interface DeviceGate { deviceId: string; name: string; local: boolean; sid: string; relayTo?: string }
const principalOf = (req: Request): Principal => ((req as unknown as { instarPrincipal?: Principal }).instarPrincipal) ?? { kind: 'token' };

/**
 * The durable replay record for device input (spec: Replay across a restart). The verifier's replay
 * set lives in memory; input is the first allowlisted device route that is neither idempotent nor
 * deduplicated, so each accepted input's signature digest is written here BEFORE it is typed and kept
 * for REPLAY_TTL_MS (longer than the verifier's +/- DEVICE_TIME_WINDOW_MS window). A captured request
 * can then never be typed twice, across restarts and whatever the phone's clock says.
 */
export class DeviceInputReplayRecord {
  private entries: Map<string, number> | null = null;
  constructor(private readonly file: string, private readonly now: () => number = Date.now) {}

  private load(): Map<string, number> {
    if (this.entries) return this.entries;
    const m = new Map<string, number>();
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Record<string, unknown>;
      for (const [k, v] of Object.entries(raw)) if (typeof v === 'number') m.set(k, v);
    } catch { /* @silent-fallback-ok — no record yet (or unreadable: rewritten on the next admit) */ }
    this.entries = m;
    return m;
  }

  /** The digest of a request's canonical signed string (the string the verifier's replay set keys on). */
  static digest(canonical: string): string {
    return crypto.createHash('sha256').update(canonical).digest('hex');
  }

  /** 'ok' after durably recording the digest; 'replay' if already recorded; 'unavailable' if it could not be written. */
  admit(digest: string): 'ok' | 'replay' | 'unavailable' {
    const m = this.load();
    const t = this.now();
    for (const [k, at] of m) if (t - at > REPLAY_TTL_MS) m.delete(k);
    if (m.has(digest)) return 'replay';
    m.set(digest, t);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(m)), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
      return 'ok';
    } catch (err) {
      m.delete(digest);
      console.error(`[mobile-session-input] replay record write failed: ${err instanceof Error ? err.message : String(err)}`);
      return 'unavailable';
    }
  }
}

/** Append one audit line (no text), rotating to `.1` past AUDIT_ROTATE_BYTES. Best effort. */
export function appendInputAudit(stateDir: string, row: Record<string, unknown>): void {
  const dir = path.join(stateDir, 'logs');
  const file = path.join(dir, 'mobile-session-input.jsonl');
  try {
    fs.mkdirSync(dir, { recursive: true });
    try {
      if (fs.statSync(file).size > AUDIT_ROTATE_BYTES) fs.renameSync(file, `${file}.1`);
    } catch { /* @silent-fallback-ok — no file yet */ }
    fs.appendFileSync(file, JSON.stringify(row) + '\n', { mode: 0o600 });
  } catch (err) {
    // @silent-fallback-ok — the audit is a record, not a gate; the failure is logged loudly.
    console.error(`[mobile-session-input] audit write failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function createMobileSessionTerminalRouter(deps: MobileSessionTerminalDeps): Router {
  const router = Router();
  const now = deps.now ?? Date.now;
  const missCache = new Map<string, { at: number; answer: MissAnswer }>();
  const inFlight = new Map<string, Promise<MissAnswer>>();
  const missNames = new Map<string, Array<{ at: number; name: string }>>();
  let machineInputs: number[] = [];
  let machineKeys: number[] = [];
  const attachments = new AttachmentWindow(now);
  const replayRecord = deps.replayRecord ?? new DeviceInputReplayRecord(path.join(deps.stateDir, 'state', 'mobile-session-input-replay.json'), now);

  /** Durable replay record, written before anything happens (the verifier's set is in memory). False = answered. */
  function admitReplay(req: Request, res: Response, g: DeviceGate): boolean {
    const raw = (req as unknown as { rawBody?: Buffer }).rawBody;
    const digest = DeviceInputReplayRecord.digest(canonicalString(g.deviceId, deviceAdmittedHost(req) ?? '', req.method, req.originalUrl, String(req.headers['x-instar-device-time'] ?? ''), raw));
    const admitted = replayRecord.admit(digest);
    if (admitted === 'replay') { res.status(409).json({ error: 'replay', reason: REPLAY_REASON }); return false; }
    if (admitted === 'unavailable') { res.status(503).json({ error: 'replay-record-unavailable', reason: REPLAY_RECORD_REASON }); return false; }
    return true;
  }

  function audit(req: Request, g: DeviceGate, row: Record<string, unknown>): void {
    const person = devicePersonOf(req);
    appendInputAudit(deps.stateDir, { at: new Date(now()).toISOString(), deviceId: g.deviceId, role: person?.role ?? null, userId: person?.userId ?? null, ...row });
  }

  function keyWindowOk(): boolean {
    const t = now();
    machineKeys = machineKeys.filter((x) => t - x < 60_000);
    if (machineKeys.length >= DEVICE_KEY_MACHINE_PER_MINUTE) return false;
    machineKeys.push(t);
    return true;
  }

  /** One fan-out per name per cache window (15 s found elsewhere, 3 s otherwise), shared by concurrent callers; per-device name cap. */
  async function missAnswer(deviceId: string, name: string): Promise<MissAnswer> {
    const t = now();
    const ttl = (a: MissAnswer): number => (a.error === 'session-on-other-machine' ? MISS_CACHE_FOUND_MS : MISS_CACHE_NEGATIVE_MS);
    for (const [k, v] of missCache) if (t - v.at >= ttl(v.answer)) missCache.delete(k);
    const cached = missCache.get(name);
    if (cached) return cached.answer;
    const pending = inFlight.get(name);
    if (pending) return pending;
    for (const [k, v] of missNames) {
      const kept = v.filter((x) => t - x.at < 60_000);
      if (kept.length) missNames.set(k, kept); else missNames.delete(k);
    }
    const recent = missNames.get(deviceId) ?? [];
    if (!recent.some((x) => x.name === name)) {
      if (recent.length >= MISS_NAMES_PER_DEVICE_PER_MINUTE) return { error: 'session-location-unknown', reason: LOCATION_UNKNOWN_REASON };
      recent.push({ at: t, name });
      missNames.set(deviceId, recent);
    }
    const p = (async () => {
      let answers: PeerLookup[];
      try { answers = await deps.lookupPeers(name); } catch { answers = [{ machineId: 'unknown', failed: true }]; } // @silent-fallback-ok — reported as location unknown
      const answer = classifyMiss(answers, deps.nicknameOf);
      missCache.set(name, { at: now(), answer });
      return answer;
    })();
    inFlight.set(name, p);
    try { return await p; } finally { inFlight.delete(name); }
  }

  /** The common device checks; null when the request was answered (or passed on). */
  function deviceGate(req: Request, res: Response, next: NextFunction): DeviceGate | null {
    const p = principalOf(req);
    if (p.kind !== 'device') { next(); return null; }
    res.setHeader('Cache-Control', 'no-store');
    const person = devicePersonOf(req);
    if (!person || person.role !== 'owner') { res.status(403).json({ error: 'owner-phone-required', reason: OWNER_ONLY_REASON }); return null; }
    const name = req.params.name;
    if (typeof name !== 'string' || !DEVICE_SESSION_NAME_RE.test(name)) { res.status(400).json({ error: 'bad-session-name' }); return null; }
    // Machine binding: a row from another machine never resolves against this machine's records.
    const machine = typeof req.query.machine === 'string' ? req.query.machine : '';
    const self = deps.selfMachineId();
    // A write that names a machine runs there or not at all. With no mesh id here, that machine can't be reached,
    // and a same-named session on this machine is a different session.
    if (machine && !self && req.method !== 'GET') { res.status(404).json({ error: 'session-on-other-machine', reason: requestedMachineReason(null), ownerMachine: { machineId: machine, nickname: null } }); return null; }
    if (machine && self && machine !== self && deps.relayToPeer) {
      return { deviceId: p.deviceId ?? '', name, local: false, sid: typeof req.query.sid === 'string' ? req.query.sid : '', relayTo: machine };
    }
    if (machine && self && machine !== self) {
      const nick = verifiedEntityName(machine, deps.nicknameOf(machine)) ?? null;
      res.status(404).json({ error: 'session-on-other-machine', reason: requestedMachineReason(nick), ownerMachine: { machineId: machine, nickname: nick } });
      return null;
    }
    const sid = typeof req.query.sid === 'string' ? req.query.sid : '';
    return { deviceId: p.deviceId ?? '', name, local: !!machine && machine === self, sid };
  }

  /**
   * Send the phone's request on to the machine it named, and answer the phone with what came back. A
   * machine that doesn't know the relay routes is too old (nothing happened there); one that doesn't
   * answer is a moment's trouble, so the phone keeps trying.
   */
  async function relay(res: Response, g: DeviceGate, method: 'GET' | 'POST', path: string, body: unknown, transform: (b: Record<string, unknown>) => Record<string, unknown> = (b) => b): Promise<number | null> {
    const machine = g.relayTo as string;
    const nick = verifiedEntityName(machine, deps.nicknameOf(machine)) ?? null;
    let answer: { status: number; body: unknown } | null = null;
    try { answer = await deps.relayToPeer!(machine, method, path, body); } catch { answer = null; } // @silent-fallback-ok — answered as not answering, below
    if (!answer) { res.status(503).json({ error: 'peer-unreachable', reason: peerUnreachableReason(nick) }); return null; }
    const b = answer.body && typeof answer.body === 'object' && !Array.isArray(answer.body) ? answer.body as Record<string, unknown> : null;
    // The other machine refusing the pool token is its trouble, never this phone being signed out.
    if (answer.status === 401 || answer.status === 403) { res.status(503).json({ error: 'peer-unreachable', reason: peerUnreachableReason(nick) }); return null; }
    const unknownRoute = answer.status === 404 && (!b || typeof b.error !== 'string' || !/^session/i.test(b.error));
    if (!b || unknownRoute) {
      res.status(404).json({ error: 'session-on-other-machine', reason: peerTooOldReason(nick), ownerMachine: { machineId: machine, nickname: nick }, peerTooOld: true });
      return null;
    }
    let secrets: Array<string | null | undefined> = [];
    try { secrets = deps.secrets(); } catch { secrets = []; } // @silent-fallback-ok — the sig= rewrite still applies
    // This machine removes its own secrets too: the two machines' PINs need not match.
    res.status(answer.status).json(redactDeep(transform(b), secrets));
    return answer.status;
  }

  const relayQuery = (g: DeviceGate, more: string[] = []): string => {
    const q = [...more, ...(g.sid ? [`sid=${encodeURIComponent(g.sid)}`] : [])];
    return q.length ? `?${q.join('&')}` : '';
  };

  async function resolveOrAnswer(res: Response, g: DeviceGate): Promise<SessionRecordLike | null> {
    const { deviceId, name } = g;
    let records: SessionRecordLike[] = [];
    try { records = deps.listSessions(); } catch { records = []; } // @silent-fallback-ok — an unreadable registry is a miss
    const r = resolveDeviceSession(records, name);
    if (r.kind === 'found') {
      if (g.sid && r.session.id !== g.sid) { res.status(409).json({ error: 'session-replaced', reason: SESSION_REPLACED_REASON }); return null; }
      return r.session;
    }
    if (r.kind === 'ambiguous') { res.status(409).json({ error: 'ambiguous-session', reason: 'More than one session has this name. Open it from the sessions list.' }); return null; }
    // The phone asked about THIS machine's session: a same-named session elsewhere is another session.
    if (g.local || g.sid) { res.status(404).json({ error: 'session-not-running', reason: NOT_RUNNING_REASON }); return null; }
    res.status(404).json(await missAnswer(deviceId, name));
    return null;
  }

  router.get('/sessions/:name/output', async (req: Request, res: Response, next: NextFunction) => {
    const g = deviceGate(req, res, next);
    if (!g) return;
    const raw = parseInt(String(req.query.lines ?? ''), 10);
    const lines = Number.isFinite(raw) ? Math.min(Math.max(raw, 1), DEVICE_OUTPUT_MAX_LINES) : DEVICE_OUTPUT_DEFAULT_LINES;
    if (g.relayTo) {
      const nick = verifiedEntityName(g.relayTo, deps.nicknameOf(g.relayTo)) ?? null;
      await relay(res, g, 'GET', `/mobile/sessions/relay/${encodeURIComponent(g.name)}/output${relayQuery(g, [`lines=${lines}`])}`, undefined, (b) => ({ ...b, machineNickname: nick }));
      return;
    }
    const s = await resolveOrAnswer(res, g);
    if (!s) return;
    let output: string | null = null;
    try { output = await deps.captureOutputAsync(s.tmuxSession, lines); } catch { output = null; } // @silent-fallback-ok — an unreadable pane answers not running
    if (output === null) { res.status(404).json({ error: 'session-not-running', reason: NOT_RUNNING_REASON }); return; }
    let secrets: Array<string | null | undefined> = [];
    try { secrets = deps.secrets(); } catch { secrets = []; } // @silent-fallback-ok — the sig= rewrite still applies
    res.json({ session: s.name, sessionId: s.id, tmuxSession: s.tmuxSession, output: redactForDevice(output, secrets), startedAt: s.startedAt ?? null, machineNickname: deps.selfNickname() });
  });

  router.post('/sessions/:name/input', async (req: Request, res: Response, next: NextFunction) => {
    const g = deviceGate(req, res, next);
    if (!g) return;
    const text = (req.body ?? {}).text;
    if (typeof text !== 'string' || text.length === 0) { res.status(400).json({ error: 'bad-text', reason: 'Type something to send.' }); return; }
    if (text.length > DEVICE_INPUT_MAX) { res.status(400).json({ error: 'bad-text', reason: `Up to ${DEVICE_INPUT_MAX} characters can be sent at once.` }); return; }
    if (!isPlainDeviceText(text)) { res.status(400).json({ error: 'bad-text', reason: BAD_TEXT_REASON }); return; }
    if (g.relayTo) {
      if (!admitReplay(req, res, g)) return;
      const status = await relay(res, g, 'POST', `/mobile/sessions/relay/${encodeURIComponent(g.name)}/input${relayQuery(g)}`, { text });
      if (status !== null && status >= 200 && status < 300) audit(req, g, { machineId: g.relayTo, tmuxSession: g.name, textLength: text.length });
      return;
    }
    const s = await resolveOrAnswer(res, g);
    if (!s) return;
    // One machine-wide window across all phones. sendInput is synchronous, so sends never overlap.
    const tNow = now();
    machineInputs = machineInputs.filter((x) => tNow - x < 60_000);
    if (machineInputs.length >= DEVICE_INPUT_MACHINE_PER_MINUTE) { res.status(429).json({ error: 'too-many-requests', reason: INPUT_BUSY_REASON }); return; }
    if (!admitReplay(req, res, g)) return;
    machineInputs.push(tNow);
    let ok = false;
    try { ok = deps.sendInput(s.tmuxSession, text); } catch { ok = false; } // @silent-fallback-ok — answered as send-failed
    if (!ok) { res.status(409).json({ error: 'send-failed', reason: SEND_FAILED_REASON }); return; }
    audit(req, g, { sessionId: s.id, tmuxSession: s.tmuxSession, textLength: text.length });
    res.json({ ok: true });
  });

  // The keys tray. Conversation use, like typing: signed by an owner phone. Not a Bearer route: the
  // console sends keys over its WebSocket, so a Bearer request falls through to a plain 404.
  router.post('/sessions/:name/key', async (req: Request, res: Response, next: NextFunction) => {
    const g = deviceGate(req, res, next);
    if (!g) return;
    const key = (req.body ?? {}).key;
    if (typeof key !== 'string' || !DEVICE_KEYS.has(key)) { res.status(400).json({ error: 'bad-key', reason: BAD_KEY_REASON }); return; }
    if (g.relayTo) {
      if (!admitReplay(req, res, g)) return;
      const status = await relay(res, g, 'POST', `/mobile/sessions/relay/${encodeURIComponent(g.name)}/key${relayQuery(g)}`, { key });
      if (status !== null && status >= 200 && status < 300) audit(req, g, { machineId: g.relayTo, tmuxSession: g.name, key });
      return;
    }
    const s = await resolveOrAnswer(res, g);
    if (!s) return;
    if (!keyWindowOk()) { res.status(429).json({ error: 'too-many-requests', reason: INPUT_BUSY_REASON }); return; }
    if (!admitReplay(req, res, g)) return;
    let ok = false;
    try { ok = deps.sendKey ? deps.sendKey(s.tmuxSession, key) : false; } catch { ok = false; } // @silent-fallback-ok — answered as send-failed
    if (!ok) { res.status(409).json({ error: 'send-failed', reason: SEND_FAILED_REASON }); return; }
    audit(req, g, { sessionId: s.id, tmuxSession: s.tmuxSession, key });
    res.json({ ok: true });
  });

  // Attaching a file: the dashboard's own route saves it (next()), once this router has resolved the
  // session the phone meant. On another machine it goes to that machine's same route, so the file lands
  // on the disk the session can read. Conversation use, like typing: signed by an owner phone.
  router.post('/sessions/:name/attachments', async (req: Request, res: Response, next: NextFunction) => {
    const g = deviceGate(req, res, next);
    if (!g) return;
    const size = typeof (req.body ?? {}).dataBase64 === 'string' ? (req.body.dataBase64 as string).length : 0;
    if (g.relayTo) {
      if (!attachments.admit(size)) { res.status(429).json({ error: 'too-many-requests', reason: ATTACH_BUSY_REASON }); return; }
      const status = await relay(res, g, 'POST', `/mobile/sessions/relay/${encodeURIComponent(g.name)}/attachments${relayQuery(g)}`, { filename: req.body?.filename, dataBase64: req.body?.dataBase64 });
      if (status !== null && status >= 200 && status < 300) audit(req, g, { machineId: g.relayTo, tmuxSession: g.name, attachmentBase64Chars: size });
      return;
    }
    const s = await resolveOrAnswer(res, g);
    if (!s) return;
    if (s.tmuxSession !== g.name) { res.status(409).json({ error: 'ambiguous-session', reason: 'Open this session from the sessions list and attach it again.' }); return; }
    if (!attachments.admit(size)) { res.status(429).json({ error: 'too-many-requests', reason: ATTACH_BUSY_REASON }); return; }
    audit(req, g, { sessionId: s.id, tmuxSession: s.tmuxSession, attachmentBase64Chars: size });
    next();
  });

  // ── The other side of the hop: the machine that runs the session ─────────────────
  // Pool token only (no phone rule lists these, so a phone gets 403 device-not-allowed). The same
  // resolver and redaction as the phone's routes, on this machine's own records and secrets.
  const relayGate = (req: Request, res: Response): DeviceGate | null => {
    res.setHeader('Cache-Control', 'no-store');
    if (principalOf(req).kind !== 'token') { res.status(403).json({ error: 'pool-token-required' }); return null; }
    const name = req.params.name;
    if (typeof name !== 'string' || !DEVICE_SESSION_NAME_RE.test(name)) { res.status(400).json({ error: 'bad-session-name' }); return null; }
    // `local`: a same-named session elsewhere is another session, and the asking machine named this one.
    return { deviceId: 'pool', name, local: true, sid: typeof req.query.sid === 'string' ? req.query.sid : '' };
  };

  router.get('/mobile/sessions/relay/:name/state', (req: Request, res: Response) => {
    if (!relayGate(req, res)) return;
    res.json({ inputAllowed: deps.allowRemoteInput ? deps.allowRemoteInput() : false, keysSupported: !!deps.sendKey });
  });

  router.get('/mobile/sessions/relay/:name/output', async (req: Request, res: Response) => {
    const g = relayGate(req, res);
    if (!g) return;
    const s = await resolveOrAnswer(res, g);
    if (!s) return;
    const raw = parseInt(String(req.query.lines ?? ''), 10);
    const lines = Number.isFinite(raw) ? Math.min(Math.max(raw, 1), DEVICE_OUTPUT_MAX_LINES) : DEVICE_OUTPUT_DEFAULT_LINES;
    let output: string | null = null;
    try { output = await deps.captureOutputAsync(s.tmuxSession, lines); } catch { output = null; } // @silent-fallback-ok — an unreadable pane answers not running
    if (output === null) { res.status(404).json({ error: 'session-not-running', reason: NOT_RUNNING_REASON }); return; }
    let secrets: Array<string | null | undefined> = [];
    try { secrets = deps.secrets(); } catch { secrets = []; } // @silent-fallback-ok — the sig= rewrite still applies
    res.json({ session: s.name, sessionId: s.id, tmuxSession: s.tmuxSession, output: redactForDevice(output, secrets), startedAt: s.startedAt ?? null, machineNickname: deps.selfNickname() });
  });

  router.post('/mobile/sessions/relay/:name/input', async (req: Request, res: Response) => {
    const g = relayGate(req, res);
    if (!g) return;
    if (!deps.allowRemoteInput?.()) { res.status(409).json({ error: 'input-not-allowed', reason: REMOTE_INPUT_OFF_REASON }); return; }
    const text = (req.body ?? {}).text;
    if (typeof text !== 'string' || text.length === 0 || text.length > DEVICE_INPUT_MAX || !isPlainDeviceText(text)) { res.status(400).json({ error: 'bad-text', reason: BAD_TEXT_REASON }); return; }
    const s = await resolveOrAnswer(res, g);
    if (!s) return;
    const tNow = now();
    machineInputs = machineInputs.filter((x) => tNow - x < 60_000);
    if (machineInputs.length >= DEVICE_INPUT_MACHINE_PER_MINUTE) { res.status(429).json({ error: 'too-many-requests', reason: INPUT_BUSY_REASON }); return; }
    machineInputs.push(tNow);
    let ok = false;
    try { ok = deps.sendInput(s.tmuxSession, text); } catch { ok = false; } // @silent-fallback-ok — answered as send-failed
    if (!ok) { res.status(409).json({ error: 'send-failed', reason: SEND_FAILED_REASON }); return; }
    appendInputAudit(deps.stateDir, { at: new Date(now()).toISOString(), via: 'peer-relay', sessionId: s.id, tmuxSession: s.tmuxSession, textLength: text.length });
    res.json({ ok: true });
  });

  // The file reaches the same dashboard handler a phone here reaches, under this machine's own rule:
  // a file is only useful with the message that names it, which that rule would refuse.
  router.post('/mobile/sessions/relay/:name/attachments', async (req: Request, res: Response, next: NextFunction) => {
    const g = relayGate(req, res);
    if (!g) return;
    if (!deps.allowRemoteInput?.()) { res.status(409).json({ error: 'input-not-allowed', reason: REMOTE_INPUT_OFF_REASON }); return; }
    const s = await resolveOrAnswer(res, g);
    if (!s) return;
    const size = typeof (req.body ?? {}).dataBase64 === 'string' ? (req.body.dataBase64 as string).length : 0;
    if (!attachments.admit(size)) { res.status(429).json({ error: 'too-many-requests', reason: ATTACH_BUSY_REASON }); return; }
    appendInputAudit(deps.stateDir, { at: new Date(now()).toISOString(), via: 'peer-relay', sessionId: s.id, tmuxSession: s.tmuxSession, attachmentBase64Chars: size });
    req.url = `/sessions/${encodeURIComponent(s.tmuxSession)}/attachments`;
    next();
  });

  router.post('/mobile/sessions/relay/:name/key', async (req: Request, res: Response) => {
    const g = relayGate(req, res);
    if (!g) return;
    if (!deps.allowRemoteInput?.()) { res.status(409).json({ error: 'input-not-allowed', reason: REMOTE_INPUT_OFF_REASON }); return; }
    const key = (req.body ?? {}).key;
    if (typeof key !== 'string' || !DEVICE_KEYS.has(key)) { res.status(400).json({ error: 'bad-key', reason: BAD_KEY_REASON }); return; }
    const s = await resolveOrAnswer(res, g);
    if (!s) return;
    if (!keyWindowOk()) { res.status(429).json({ error: 'too-many-requests', reason: INPUT_BUSY_REASON }); return; }
    let ok = false;
    try { ok = deps.sendKey ? deps.sendKey(s.tmuxSession, key) : false; } catch { ok = false; } // @silent-fallback-ok — answered as send-failed
    if (!ok) { res.status(409).json({ error: 'send-failed', reason: SEND_FAILED_REASON }); return; }
    appendInputAudit(deps.stateDir, { at: new Date(now()).toISOString(), via: 'peer-relay', sessionId: s.id, tmuxSession: s.tmuxSession, key });
    res.json({ ok: true });
  });

  return router;
}
