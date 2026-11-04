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
 * A session that is not here is named from this machine's registry when a peer lists it; it is
 * never proxied.
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
export const LOCATION_UNKNOWN_REASON = 'This session is not running on this machine, and I could not reach your other machines to check where it is.';
export const BAD_TEXT_REASON = 'Only plain text can be typed into a session from the phone.';
export const SEND_FAILED_REASON = 'The session could not take your text right now. It may be starting or restarting; try again in a moment.';
export const OWNER_ONLY_REASON = "Only the owner's phone can open sessions.";
export const SESSION_REPLACED_REASON = 'This session ended and a new one took its name. Reopen it from the sessions list.';
export const INPUT_BUSY_REASON = 'Too many messages were typed from phones in the last minute. Wait a moment and send again.';
/** Device inputs per minute across ALL phones on this machine (each holds the event loop briefly). */
export const DEVICE_INPUT_MACHINE_PER_MINUTE = 12;

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
export const REPLAY_REASON = 'This exact request was already received, so it was not typed in again.';
export const REPLAY_RECORD_REASON = 'The agent could not record this request safely, so it was not typed in. Try again in a moment.';

/** The plain reason for a session another machine runs (the "Open session" sentence shape). */
export function otherMachineReason(nickname: string | null): string {
  return nickname
    ? `This session runs on ${nickname}, not on this machine. Open it from ${nickname}.`
    : 'This session runs on another of your machines, whose name I could not confirm, not on this machine.';
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
  /** The durable replay record for device input (defaults to <stateDir>/state/mobile-session-input-replay.json). */
  replayRecord?: DeviceInputReplayRecord;
  stateDir: string;
  now?: () => number;
}

type Principal = { kind: string; deviceId?: string };
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
  const replayRecord = deps.replayRecord ?? new DeviceInputReplayRecord(path.join(deps.stateDir, 'state', 'mobile-session-input-replay.json'), now);

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
  function deviceGate(req: Request, res: Response, next: NextFunction): { deviceId: string; name: string; local: boolean; sid: string } | null {
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
    if (machine && self && machine !== self) {
      const nick = verifiedEntityName(machine, deps.nicknameOf(machine)) ?? null;
      res.status(404).json({ error: 'session-on-other-machine', reason: requestedMachineReason(nick), ownerMachine: { machineId: machine, nickname: nick } });
      return null;
    }
    const sid = typeof req.query.sid === 'string' ? req.query.sid : '';
    return { deviceId: p.deviceId ?? '', name, local: !!machine && machine === self, sid };
  }

  async function resolveOrAnswer(res: Response, g: { deviceId: string; name: string; local: boolean; sid: string }): Promise<SessionRecordLike | null> {
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

  router.post('/sessions/:name/input', async (req: Request, res: Response, next: NextFunction) => {
    const g = deviceGate(req, res, next);
    if (!g) return;
    const text = (req.body ?? {}).text;
    if (typeof text !== 'string' || text.length === 0) { res.status(400).json({ error: 'bad-text', reason: 'Type something to send.' }); return; }
    if (text.length > DEVICE_INPUT_MAX) { res.status(400).json({ error: 'bad-text', reason: `Up to ${DEVICE_INPUT_MAX} characters can be sent at once.` }); return; }
    if (!isPlainDeviceText(text)) { res.status(400).json({ error: 'bad-text', reason: BAD_TEXT_REASON }); return; }
    const s = await resolveOrAnswer(res, g);
    if (!s) return;
    // One machine-wide window across all phones. sendInput is synchronous, so sends never overlap.
    const tNow = now();
    machineInputs = machineInputs.filter((x) => tNow - x < 60_000);
    if (machineInputs.length >= DEVICE_INPUT_MACHINE_PER_MINUTE) { res.status(429).json({ error: 'too-many-requests', reason: INPUT_BUSY_REASON }); return; }
    // Durable replay record, written before anything is typed (the verifier's set is in memory).
    const raw = (req as unknown as { rawBody?: Buffer }).rawBody;
    const digest = DeviceInputReplayRecord.digest(canonicalString(g.deviceId, deviceAdmittedHost(req) ?? '', req.method, req.originalUrl, String(req.headers['x-instar-device-time'] ?? ''), raw));
    const admitted = replayRecord.admit(digest);
    if (admitted === 'replay') { res.status(409).json({ error: 'replay', reason: REPLAY_REASON }); return; }
    if (admitted === 'unavailable') { res.status(503).json({ error: 'replay-record-unavailable', reason: REPLAY_RECORD_REASON }); return; }
    machineInputs.push(tNow);
    let ok = false;
    try { ok = deps.sendInput(s.tmuxSession, text); } catch { ok = false; } // @silent-fallback-ok — answered as send-failed
    if (!ok) { res.status(409).json({ error: 'send-failed', reason: SEND_FAILED_REASON }); return; }
    const person = devicePersonOf(req);
    appendInputAudit(deps.stateDir, {
      at: new Date(now()).toISOString(), deviceId: g.deviceId, role: person?.role ?? null, userId: person?.userId ?? null,
      sessionId: s.id, tmuxSession: s.tmuxSession, textLength: text.length,
    });
    res.json({ ok: true });
  });

  return router;
}
