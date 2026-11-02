/**
 * Mobile push (docs/specs/mobile-push.md): notify paired phones through Apple's push service
 * when the Attention hub posts. Direct from this agent with the operator's APNs key; no relay.
 *
 * Bounds are durable and per device (`.instar/state/mobile-push-state.json`): a 2-minute fold,
 * hourly after 40 sends in any rolling 24 h, an URGENT bypass of the hourly wait (10 more per
 * 24 h), and a persisted APNs 429 backoff that wins over both. Nothing is dropped, only folded.
 * The payload never carries item text; the phone fetches the title itself.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http2 from 'node:http2';
import path from 'node:path';
import type { DeviceRecord, DeviceRegistry } from './MobileDeviceKeys.js';

export const FOLD_MS = 2 * 60_000;
export const HOURLY_MS = 60 * 60_000;
export const DAY_MS = 24 * 60 * 60_000;
export const THRESHOLD_24H = 40;
export const URGENT_EXTRA_24H = 10;
export const BACKOFF_MS = 10 * 60_000;
export const DEDUPE_MS = 10 * 60_000;
const JWT_TTL_MS = 50 * 60_000;
const PAUSE_RECHECK_MS = 30 * 60_000;
const BUNDLE_ID = 'io.sagemindai.instar';

export interface PushTrigger {
  kind: 'item' | 'notice';
  itemId?: string;
  dedupeKey: string;
  priority?: string;
  sourceMachine: string;
}

export interface ApnsCredentials { keyPem: string; keyId: string; teamId: string }
export interface ApnsAnswer { status: number; reason?: string }
export type ApnsTransport = (env: 'sandbox' | 'production', token: string, headers: Record<string, string>, body: string) => Promise<ApnsAnswer>;

interface DeviceState {
  sendLog: number[];
  urgentLog: number[];
  lastSendAt: number | null;
  pending: { count: number; hasUrgent: boolean } | null;
  dueAt: number | null;
  backoffUntil: number | null;
  lastSend: { at: string; outcome: string } | null;
}
interface PushState {
  devices: Record<string, DeviceState>;
  dedupe: Record<string, number>;
  paused: { reason: string; credHash: string; at: number; checkedAt: number } | null;
  fanout: { sent: number; received: number; deduped: number; refused: number };
}

export interface MobilePushDeps {
  stateDir: string;
  registry: DeviceRegistry;
  agentId: string;
  agentName: string;
  machineId: string;
  enabled: () => boolean;
  credentials: () => ApnsCredentials | null;
  transport?: ApnsTransport;
  fanOut?: (t: PushTrigger) => void;
  reportDegradation?: (what: string, err: unknown) => void;
  now?: () => number;
}

const emptyDevice = (): DeviceState => ({ sendLog: [], urgentLog: [], lastSendAt: null, pending: null, dueAt: null, backoffUntil: null, lastSend: null });

export class MobilePushService {
  private readonly file: string;
  private readonly now: () => number;
  private state: PushState | null = null;
  private stateError = false;
  private jwt: { credHash: string; token: string; at: number } | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly transport: ApnsTransport;

  constructor(private readonly deps: MobilePushDeps) {
    this.file = path.join(deps.stateDir, 'state', 'mobile-push-state.json');
    this.now = deps.now ?? Date.now;
    this.transport = deps.transport ?? createHttp2Transport();
  }

  start(intervalMs = 15_000): void {
    if (this.timer) return;
    // @silent-fallback-ok — a failed tick is reported through DegradationReporter
    this.timer = setInterval(() => { void this.tick().catch((err) => this.deps.reportDegradation?.('MobilePush.tick', err)); }, intervalMs);
    this.timer.unref?.();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

  // ── State ──────────────────────────────────────────────────────────────────────
  private load(): PushState | null {
    if (this.state) return this.state;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<PushState>;
      this.state = { devices: raw.devices ?? {}, dedupe: raw.dedupe ?? {}, paused: raw.paused ?? null, fanout: raw.fanout ?? { sent: 0, received: 0, deduped: 0, refused: 0 } };
    } catch (err) { // @silent-fallback-ok — absent = empty state; unreadable is reported and sends nothing
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.state = { devices: {}, dedupe: {}, paused: null, fanout: { sent: 0, received: 0, deduped: 0, refused: 0 } };
      } else {
        // Unknown allowance: send nothing and say so once (spec 3b).
        if (!this.stateError) this.deps.reportDegradation?.('MobilePush.state', err);
        this.stateError = true;
        return null;
      }
    }
    return this.state;
  }
  private save(): void {
    if (!this.state) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    const fd = fs.openSync(tmp, 'w', 0o600);
    try { fs.writeSync(fd, JSON.stringify(this.state)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, this.file);
  }
  private dev(st: PushState, id: string): DeviceState {
    return (st.devices[id] ??= emptyDevice());
  }

  // ── Triggers ───────────────────────────────────────────────────────────────────
  /** A hub post on this machine: notify own devices and fan out to peers. */
  onHubPost(t: Omit<PushTrigger, 'sourceMachine'>): void {
    const trig: PushTrigger = { ...t, sourceMachine: this.deps.machineId };
    if (!this.deps.enabled()) return;
    // Nothing here may throw into the hub post, and no rejection may reach the process handler.
    try {
      const st = this.load();
      if (st && this.deps.fanOut) { st.fanout.sent++; this.deps.fanOut(trig); }
    } catch (err) { this.deps.reportDegradation?.('MobilePush.fanOut', err); }
    void this.receive(trig, false).catch((err) => this.deps.reportDegradation?.('MobilePush.receive', err));
  }

  /** A trigger from this machine or a peer. Returns 'deduped' or 'accepted'. */
  async receive(t: PushTrigger, fromPeer: boolean): Promise<'deduped' | 'accepted' | 'off'> {
    if (!this.deps.enabled()) return 'off';
    const st = this.load();
    if (!st) return 'off';
    const t0 = this.now();
    for (const [k, at] of Object.entries(st.dedupe)) if (t0 - at > DEDUPE_MS) delete st.dedupe[k];
    if (fromPeer) st.fanout.received++;
    if (st.dedupe[t.dedupeKey] !== undefined) { st.fanout.deduped++; this.save(); return 'deduped'; }
    st.dedupe[t.dedupeKey] = t0;
    this.save();
    const urgent = (t.priority ?? '').toUpperCase() === 'URGENT';
    for (const d of this.pushDevices()) {
      const ds = this.dev(st, d.id);
      prune(ds, t0);
      if (!ds.pending && this.dueFor(ds, urgent) <= t0) {
        await this.send(d.id, { kind: t.kind, itemId: t.kind === 'item' ? t.itemId : undefined, machine: t.sourceMachine, count: 1 }, urgent && this.throttled(ds));
      } else {
        ds.pending = { count: (ds.pending?.count ?? 0) + 1, hasUrgent: (ds.pending?.hasUrgent ?? false) || urgent };
        ds.dueAt = this.dueFor(ds, ds.pending.hasUrgent);
        this.save();
      }
    }
    return 'accepted';
  }

  noteRefused(): void { const st = this.load(); if (st) { st.fanout.refused++; this.save(); } }

  /** Send due aggregates. */
  async tick(): Promise<void> {
    const st = this.load();
    if (!st) return;
    await this.maybeUnpause(st);
    const t0 = this.now();
    for (const [id, ds] of Object.entries(st.devices)) {
      if (!ds.pending || ds.dueAt === null || ds.dueAt > t0) continue;
      const held = ds.pending;
      const dueAt = ds.dueAt;
      const urgentBypass = held.hasUrgent && this.throttled(ds);
      ds.pending = null; ds.dueAt = null;
      this.save();
      const out = await this.send(id, { kind: 'aggregate', count: held.count }, urgentBypass);
      // Paused or no key: keep the fold so it goes out once sending works again.
      if (out === 'paused' || out === 'no-key') { ds.pending = held; ds.dueAt = dueAt; this.save(); }
    }
  }

  // ── Scheduling ─────────────────────────────────────────────────────────────────
  private throttled(ds: DeviceState): boolean { return ds.sendLog.length >= THRESHOLD_24H; }

  /** The earliest time this device may be sent to (spec 2.4). */
  private dueFor(ds: DeviceState, urgent: boolean): number {
    const last = ds.lastSendAt ?? -Infinity;
    let due = last + FOLD_MS;
    const urgentOk = urgent && ds.urgentLog.length < URGENT_EXTRA_24H;
    if (this.throttled(ds) && !urgentOk) due = Math.max(due, last + HOURLY_MS);
    if (ds.backoffUntil) due = Math.max(due, ds.backoffUntil);
    return due;
  }

  private pushDevices(): DeviceRecord[] {
    return this.deps.registry.list().filter((d) => d.status === 'active' && !!d.pushToken);
  }

  // ── Sending ────────────────────────────────────────────────────────────────────
  private async send(deviceId: string, p: { kind: 'item' | 'notice' | 'aggregate'; itemId?: string; machine?: string; count: number }, urgentBypass: boolean): Promise<string> {
    const st = this.load();
    if (!st) return 'state-unreadable';
    const ds = this.dev(st, deviceId);
    const d = this.deps.registry.get(deviceId);
    // Re-check at send time, including a fold firing later (spec 2.4).
    if (!this.deps.enabled() || !d || d.status !== 'active' || !d.pushToken || !d.pushEnvironment) return 'skipped';
    if (st.paused) return 'paused';
    const cred = this.deps.credentials();
    if (!cred) { ds.lastSend = { at: new Date(this.now()).toISOString(), outcome: 'no-key' }; this.save(); return 'no-key'; }
    const version = d.pushVersion ?? 0;
    // Reserve before the request goes out: failed and uncertain sends count.
    const t0 = this.now();
    ds.sendLog.push(t0); ds.lastSendAt = t0;
    if (urgentBypass) ds.urgentLog.push(t0);
    this.save();
    const body = JSON.stringify(buildPayload(this.deps.agentName, this.deps.agentId, deviceId, p));
    let outcome = await this.attempt(cred, d.pushEnvironment, d.pushToken, body, false);
    if (outcome.kind === 'jwt-retry') outcome = await this.attempt(cred, d.pushEnvironment, d.pushToken, body, true);
    switch (outcome.kind) {
      case 'sent': break;
      case 'clear-token': this.deps.registry.clearPushIfVersion(deviceId, version); break;
      case 'backoff': ds.backoffUntil = this.now() + BACKOFF_MS; break;
      case 'pause': case 'jwt-retry':
        st.paused = { reason: outcome.reason, credHash: credHash(cred), at: this.now(), checkedAt: this.now() };
        this.deps.reportDegradation?.('MobilePush.apnsCredentials', new Error(`APNs refused the key: ${outcome.reason}`));
        break;
      default: break;
    }
    const label = outcome.kind === 'sent' ? 'sent' : outcome.kind === 'jwt-retry' ? 'failed' : outcome.kind;
    ds.lastSend = { at: new Date(t0).toISOString(), outcome: label };
    this.save();
    return label;
  }

  private async attempt(cred: ApnsCredentials, env: 'sandbox' | 'production', token: string, body: string, fresh: boolean):
    Promise<{ kind: 'sent' } | { kind: 'clear-token' } | { kind: 'backoff' } | { kind: 'pause'; reason: string } | { kind: 'jwt-retry'; reason: string } | { kind: 'failed' }> {
    let ans: ApnsAnswer;
    try {
      ans = await this.transport(env, token, {
        authorization: `bearer ${this.jwtFor(cred, fresh)}`, 'apns-topic': BUNDLE_ID, 'apns-push-type': 'alert', 'apns-priority': '10',
      }, body);
    } catch { return { kind: 'failed' }; } // @silent-fallback-ok — recorded as the device's lastSend outcome; no retry by design
    if (ans.status === 200) return { kind: 'sent' };
    const reason = ans.reason ?? '';
    if (ans.status === 410 || (ans.status === 400 && (reason === 'BadDeviceToken' || reason === 'DeviceTokenNotForTopic'))) return { kind: 'clear-token' };
    if (ans.status === 429) return { kind: 'backoff' };
    if (ans.status === 403 && (reason === 'ExpiredProviderToken' || reason === 'InvalidProviderToken')) return fresh ? { kind: 'pause', reason } : { kind: 'jwt-retry', reason };
    if (ans.status === 403) return { kind: 'pause', reason: reason || 'Forbidden' };
    return { kind: 'failed' };
  }

  private jwtFor(cred: ApnsCredentials, fresh: boolean): string {
    const h = credHash(cred);
    const t = this.now();
    if (!fresh && this.jwt && this.jwt.credHash === h && t - this.jwt.at < JWT_TTL_MS) return this.jwt.token;
    const token = signApnsJwt(cred, Math.floor(t / 1000));
    this.jwt = { credHash: h, token, at: t };
    return token;
  }

  private async maybeUnpause(st: PushState): Promise<void> {
    if (!st.paused || this.now() - st.paused.checkedAt < PAUSE_RECHECK_MS) return;
    st.paused.checkedAt = this.now();
    const cred = this.deps.credentials();
    if (cred && credHash(cred) !== st.paused.credHash) st.paused = null;
    this.save();
  }

  status(): Record<string, unknown> {
    const st = this.load();
    const t0 = this.now();
    return {
      enabled: this.deps.enabled(),
      keyConfigured: !!this.deps.credentials(),
      pausedReason: st?.paused?.reason ?? null,
      stateReadable: !!st,
      devices: this.deps.registry.list().filter((d) => d.status === 'active' && d.pushToken).map((d) => {
        const ds = st?.devices[d.id] ?? emptyDevice();
        prune(ds, t0);
        return {
          id: d.id, deviceName: d.deviceName, environment: d.pushEnvironment, sent24h: ds.sendLog.length, throttled: this.throttled(ds),
          backoffUntil: ds.backoffUntil ? new Date(ds.backoffUntil).toISOString() : null, pending: ds.pending?.count ?? 0, lastSend: ds.lastSend,
        };
      }),
      fanout: st?.fanout ?? null,
    };
  }
}

function prune(ds: DeviceState, t0: number): void {
  ds.sendLog = ds.sendLog.filter((x) => t0 - x < DAY_MS);
  ds.urgentLog = ds.urgentLog.filter((x) => t0 - x < DAY_MS);
  if (ds.backoffUntil && ds.backoffUntil <= t0) ds.backoffUntil = null;
}

export function buildPayload(agentName: string, agentId: string, deviceId: string, p: { kind: 'item' | 'notice' | 'aggregate'; itemId?: string; machine?: string; count: number }): Record<string, unknown> {
  const body = p.kind === 'aggregate' ? `${p.count} more ${p.count === 1 ? 'thing needs' : 'things need'} you` : 'Something needs you';
  const instar: Record<string, unknown> = { kind: p.kind, agentId, deviceId, count: p.count };
  if (p.kind === 'item' && p.itemId) { instar.itemId = p.itemId; instar.machine = p.machine; }
  return {
    aps: { alert: { title: agentName, body }, sound: 'default', 'mutable-content': 1, 'thread-id': agentName },
    instar,
  };
}

export function credHash(c: ApnsCredentials): string {
  return crypto.createHash('sha256').update(`${c.keyId}\n${c.teamId}\n${c.keyPem}`).digest('hex');
}

export function signApnsJwt(c: ApnsCredentials, iatSec: number): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = enc({ alg: 'ES256', kid: c.keyId });
  const claims = enc({ iss: c.teamId, iat: iatSec });
  const sig = crypto.sign('sha256', Buffer.from(`${head}.${claims}`), { key: c.keyPem, dsaEncoding: 'ieee-p1363' });
  return `${head}.${claims}.${sig.toString('base64url')}`;
}

/** One lazy HTTP/2 session per environment, closed after 5 idle minutes, at most 20 in flight. */
export function createHttp2Transport(): ApnsTransport {
  const sessions = new Map<string, { s: http2.ClientHttp2Session; idle: ReturnType<typeof setTimeout> | null }>();
  let inFlight = 0;
  const host = (env: string) => (env === 'production' ? 'https://api.push.apple.com' : 'https://api.sandbox.push.apple.com');
  const get = (env: string) => {
    const cur = sessions.get(env);
    if (cur && !cur.s.closed && !cur.s.destroyed) return cur;
    const s = http2.connect(host(env));
    const entry = { s, idle: null as ReturnType<typeof setTimeout> | null };
    const drop = () => { if (sessions.get(env) === entry) sessions.delete(env); };
    s.on('goaway', drop); s.on('close', drop); s.on('error', drop);
    s.unref?.();
    sessions.set(env, entry);
    return entry;
  };
  return (env, token, headers, body) => new Promise<ApnsAnswer>((resolve, reject) => {
    if (inFlight >= 20) { reject(new Error('apns-in-flight-cap')); return; }
    const entry = get(env);
    if (entry.idle) { clearTimeout(entry.idle); entry.idle = null; }
    inFlight++;
    const req = entry.s.request({ ':method': 'POST', ':path': `/3/device/${token}`, 'content-type': 'application/json', ...headers });
    let status = 0; let data = ''; let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      inFlight--;
      entry.idle = setTimeout(() => entry.s.close(), 5 * 60_000);
      entry.idle.unref?.();
      fn();
    };
    req.setTimeout(10_000, () => { req.close(http2.constants.NGHTTP2_CANCEL); done(() => reject(new Error('apns-timeout'))); });
    req.on('response', (h) => { status = Number(h[':status']); });
    req.on('data', (c) => { data += c; });
    req.on('end', () => done(() => {
      let reason: string | undefined;
      try { reason = (JSON.parse(data) as { reason?: string }).reason; } catch { /* @silent-fallback-ok — a 200 has no body */ }
      resolve({ status, reason });
    }));
    req.on('error', (e) => done(() => reject(e)));
    req.end(body);
  });
}
