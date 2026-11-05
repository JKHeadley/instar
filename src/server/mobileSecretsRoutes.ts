/**
 * Native "Passwords & keys" read for the Instar iPhone app (docs/specs/mobile-native-secrets.md).
 *
 *   GET /mobile/secrets — which requests are waiting for a password or key on each machine that answers;
 *                         on this machine, the key NAMES the agent holds, whether its vault opens and
 *                         whether keys sync. `?scope=local` is this machine only (how a peer is read).
 *
 * This route is read-only (the phone's ask and cancel are in mobilePermissionsRoutes.ts, behind Face ID,
 * and run `askForSecret` / `cancelSecretByKey` below). A paired OWNER phone (device-signed; DEVICE_ALLOWLIST lists exactly this path, `ownerOnly`)
 * or the agent's bearer token may read it; anything else gets 403 `owner-phone-required`.
 *
 * Built from an explicit field allowlist. Never in the answer: a value, a value's length, a Secret Drop
 * token or link (the token IS the link's capability, so a request is shown by its label and time only;
 * filling one in stays the web page the person was sent), or a key path that carries a token.
 *
 * The summarizer is pure (unit-tested on both sides of every rule).
 */
import type { Request, Response, Router } from 'express';
import { ownerOrBearer, rowKey } from './mobileCapacityRoutes.js';
import { cleanText } from './mobilePlansPeopleRoutes.js';
import { verifiedEntityName } from '../messaging/shared/channelIdentity.js';
import { DegradationReporter } from '../monitoring/DegradationReporter.js';

export const MOBILE_SECRETS_SCHEMA_VERSION = 1;
export const MAX_WAITING_ROWS = 30;
export const MAX_KEY_NAMES = 200;
export const SOON_MS = 5 * 60_000;
export const MAX_PEER_ROWS = 10;

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {});
/** A time a Date can hold: past this range toISOString throws. */
const MAX_DATE_MS = 8.64e15;
const dated = (t: number): boolean => Number.isFinite(t) && t > 0 && t <= MAX_DATE_MS;
const iso = (t: number): string | null => (dated(t) ? new Date(t).toISOString() : null);
const plural = (n: number, one: string, many?: string): string => `${n} ${n === 1 ? one : (many ?? `${one}s`)}`;

/** Anything shaped like a token (a hex run, a UUID, a long opaque run) is withheld and only counted. */
export const TOKEN_RUN = /[0-9a-fA-F]{16,}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-|[A-Za-z0-9+/_-]{32,}/;
/** Free text for the phone: cleaned, and with anything token-shaped replaced by words. */
function plain(v: unknown, max: number): string | null {
  const s = cleanText(v, max * 2);
  if (!s) return null;
  return cleanText(s.replace(new RegExp(TOKEN_RUN.source, 'g'), '[hidden]'), max);
}
/** A saved Secret Drop is stored under its token. */
const SAVED_DROP = /^secretDrops\.[0-9a-f]{16,}\b/;

export interface WaitingRequest { key: string; label: string; conversation: string | null; createdAt: string | null; expiresAt: string; soon: boolean }

export type RequestsRead = { state: 'ok'; pending: unknown } | { state: 'unavailable' };
export type KeysRead = { state: 'ok'; names: unknown } | { state: 'decrypt-failed' } | { state: 'off' } | { state: 'unavailable' };
export type SyncRead = { state: 'on'; pushEnabled: boolean; peers: unknown } | { state: 'off' } | { state: 'unavailable' };

export interface SecretsSources {
  requests: RequestsRead;
  keys: KeysRead;
  sync: SyncRead;
  topicName: (id: number) => string | null | undefined;
  now: number;
}

/** Waiting requests, soonest first; a row with no usable token or expiry is not a request we can show. */
function summarizeRequests(read: RequestsRead, topicName: SecretsSources['topicName'], now: number): Rec {
  if (read.state !== 'ok' || !Array.isArray(read.pending)) return { state: 'unavailable', waitingCount: null, expiredCount: null, waiting: [], truncated: false };
  const all = read.pending.map(rec).filter((p) => typeof p.token === 'string' && p.token && dated(Number(p.expiresAt)));
  // One row we can't read means the list isn't complete: it could be the one that's waiting.
  if (all.length !== read.pending.length) return { state: 'unavailable', waitingCount: null, expiredCount: null, waiting: [], truncated: false };
  const live = all.filter((p) => p.expired !== true && Number(p.expiresAt) > now).sort((a, b) => Number(a.expiresAt) - Number(b.expiresAt));
  const waiting: WaitingRequest[] = live.slice(0, MAX_WAITING_ROWS).map((p) => {
    const topic = Number(p.topicId);
    let conversation: string | null = null;
    if (Number.isInteger(topic) && topic > 0) {
      try { conversation = plain(topicName(topic), 80); } catch { conversation = null; } // @silent-fallback-ok — a missing conversation name is shown as no name; the request itself still lists
    }
    const expires = Number(p.expiresAt);
    return {
      key: rowKey('secret-request', String(p.token)),
      label: plain(p.label, 120) ?? 'A password or key',
      conversation,
      createdAt: iso(Number(p.createdAt)),
      expiresAt: new Date(expires).toISOString(),
      soon: expires - now <= SOON_MS,
    };
  });
  return { state: 'ok', waitingCount: live.length, expiredCount: all.length - live.length, waiting, truncated: live.length > waiting.length };
}

/** Key names only: token-bearing paths become a count, everything else is cleaned, de-duplicated and capped. */
function summarizeKeys(read: KeysRead): Rec {
  const none = { count: null, names: [], savedDrops: null, hidden: null, truncated: false };
  if (read.state === 'decrypt-failed') return { state: 'decrypt-failed', ...none };
  if (read.state === 'off') return { state: 'off', ...none };
  if (read.state !== 'ok' || !Array.isArray(read.names)) return { state: 'unavailable', ...none };
  const raw = read.names.filter((n): n is string => typeof n === 'string' && n.trim().length > 0).map((n) => n.trim());
  if (raw.length !== read.names.length) return { state: 'unavailable', ...none };
  const unique = [...new Set(raw)];
  const savedDrops = unique.filter((n) => SAVED_DROP.test(n)).length;
  // `count` is the keys held, taken before cleaning: two long paths that shorten alike are still two keys.
  const keys = unique.filter((n) => !SAVED_DROP.test(n));
  // Checked before and after cleaning: cleaning can join a token back together.
  const shown = keys.filter((n) => !TOKEN_RUN.test(n) && !TOKEN_RUN.test(cleanText(n, 120) ?? ''));
  const names = [...new Set(shown.map((n) => cleanText(n, 120)).filter((n): n is string => !!n))].sort((a, b) => a.localeCompare(b));
  const listed = names.slice(0, MAX_KEY_NAMES);
  return { state: 'ok', count: keys.length, names: listed, savedDrops, hidden: keys.length - shown.length, truncated: names.length > listed.length };
}

function summarizeSync(read: SyncRead): Rec {
  if (read.state === 'off') return { state: 'off', peers: null };
  if (read.state !== 'on' || !Array.isArray(read.peers)) return { state: 'unavailable', peers: null };
  return { state: read.pushEnabled ? 'on' : 'receive-only', peers: read.peers.length };
}

/** Which source lists the key names: the boot inventory when it is on, else Secret Sync, else switched off. */
export async function resolveKeys(o: {
  inventoryOn: boolean;
  inventory: () => Promise<{ names: unknown; vaultState: unknown }>;
  sync: { enabled: boolean; localKeyPaths: () => unknown } | null | undefined;
}): Promise<KeysRead> {
  if (o.inventoryOn) {
    const r = await o.inventory();
    if (r.vaultState === 'decrypt-failed') return { state: 'decrypt-failed' };
    if (r.vaultState === 'ok' || r.vaultState === 'absent') return { state: 'ok', names: r.names };
    // Thrown so the route records it: a state this code doesn't know is a failed read, not a quiet one.
    throw new Error('unexpected vault state');
  }
  if (!o.sync?.enabled) return { state: 'off' };
  return { state: 'ok', names: o.sync.localKeyPaths() };
}

/** This machine's sections, and its own words (also the `?scope=local` answer a peer reads). */
export function summarizeSecrets(s: SecretsSources): Rec {
  const requests = summarizeRequests(s.requests, s.topicName, s.now);
  const keys = summarizeKeys(s.keys);
  const sync = summarizeSync(s.sync);
  return { state: requests.state === 'ok' || keys.state === 'ok' ? 'ok' : 'unavailable', ...headlineFor(requests, keys, [], { unread: 0, offline: 0, peersRead: true }), requests, keys, sync };
}

interface Coverage { unread: number; offline: number; peersRead: boolean }

/** Headline order: a vault that won't open, what's waiting, what can't be read, then the all-clear. */
function headlineFor(requests: Rec, keys: Rec, peers: MobileSecretsPeer[], c: Coverage): { headline: string; tone: 'ok' | 'attn' | 'bad' | 'unknown' } {
  const partial = c.unread > 0 || c.offline > 0 || !c.peersRead;
  const where = partial || requests.state !== 'ok' ? ' on the machines that answered' : '';
  const brokenPeer = peers.find((p) => p.vaultBroken);
  if (keys.state === 'decrypt-failed') return { headline: 'The saved keys on this machine can\'t be opened.', tone: 'bad' };
  if (brokenPeer) return { headline: `The saved keys on ${brokenPeer.machine} can't be opened.`, tone: 'bad' };
  const mine = requests.waitingCount as number | null;
  const waiting = (mine ?? 0) + peers.reduce((n, p) => n + (p.waitingCount ?? 0), 0);
  if (waiting > 0) return { headline: `Waiting for ${plural(waiting, 'password or key', 'passwords or keys')}${where}.`, tone: 'attn' };
  if (requests.state !== 'ok' || peers.some((p) => p.waitingCount === null)) return { headline: 'Can\'t tell what is waiting.', tone: 'unknown' };
  const unknownPeer = peers.find((p) => !p.keysKnown);
  if (unknownPeer) return { headline: `Nothing is waiting${where}, but I can't tell how the saved keys on ${unknownPeer.machine} are.`, tone: 'unknown' };
  if (keys.state === 'off') return { headline: `Nothing is waiting${where}. The list of key names is off on this agent.`, tone: partial ? 'unknown' : 'ok' };
  if (keys.state !== 'ok') return { headline: `Nothing is waiting${where}, but I can't tell which keys this machine holds.`, tone: 'unknown' };
  const drops = keys.savedDrops as number;
  return {
    headline: `Nothing is waiting${where}. This machine holds ${plural(keys.count as number, 'key')}${drops > 0 ? ` and ${plural(drops, 'saved submission')}` : ''}.`,
    tone: partial ? 'unknown' : 'ok',
  };
}

export interface MobileSecretsPeer { machine: string; waitingCount: number | null; waiting: WaitingRequest[]; truncated: boolean; keyCount: number | null; keysKnown: boolean; vaultBroken: boolean }
export type PeerAnswer = { machineId: string; state: 'ok'; data: unknown } | { machineId: string; state: 'unreached' };

const KEY_STATES = new Set(['ok', 'decrypt-failed', 'off', 'unavailable']);
const REQUEST_STATES = new Set(['ok', 'unavailable']);
const count = (v: unknown): boolean => Number.isInteger(v) && (v as number) >= 0;

/** A peer's answer counts only with its own count in place. Rebuilt field by field: peer text is untrusted. */
export function peerSection(data: unknown, machine: string): MobileSecretsPeer | null {
  const d = rec(data);
  const r = rec(d.requests);
  const k = rec(d.keys);
  if (d.schemaVersion !== MOBILE_SECRETS_SCHEMA_VERSION || !Array.isArray(r.waiting)) return null;
  if (!KEY_STATES.has(String(k.state)) || !REQUEST_STATES.has(String(r.state))) return null;
  const known = r.state === 'ok';
  if (known && !count(r.waitingCount)) return null;
  if (k.state === 'ok' && !count(k.count)) return null;
  const waiting: WaitingRequest[] = [];
  for (const row of (known ? r.waiting : []).slice(0, MAX_WAITING_ROWS).map(rec)) {
    const expires = Date.parse(String(row.expiresAt ?? ''));
    if (!dated(expires) || typeof row.key !== 'string') return null;
    waiting.push({
      key: rowKey('secret-peer-request', `${machine}:${row.key}`), label: plain(row.label, 120) ?? 'A password or key',
      conversation: plain(row.conversation, 80), createdAt: iso(Date.parse(String(row.createdAt ?? ''))),
      expiresAt: new Date(expires).toISOString(), soon: row.soon === true,
    });
  }
  return {
    machine, waitingCount: known ? (r.waitingCount as number) : null, waiting, truncated: r.truncated === true,
    keyCount: k.state === 'ok' ? (k.count as number) : null, keysKnown: k.state === 'ok' || k.state === 'off', vaultBroken: k.state === 'decrypt-failed',
  };
}

export interface MergeOpts { nicknameOf: (id: string) => string | null; offlineMachineIds: string[]; peersRead: boolean }

/** This machine plus each peer that answered, each named; who didn't answer is said, never dropped. */
export function mergeSecrets(self: Rec, peers: PeerAnswer[], o: MergeOpts): Rec {
  const name = (id: string): string | null => cleanText(verifiedEntityName(id, o.nicknameOf(id)), 60);
  const rows: MobileSecretsPeer[] = [];
  const unreadNames: string[] = [];
  let unread = 0;
  for (const p of peers.slice(0, MAX_PEER_ROWS)) {
    const machine = name(p.machineId);
    const row = p.state === 'ok' ? peerSection(p.data, machine ?? 'another machine') : null;
    if (row) { rows.push(row); continue; }
    if (p.state === 'ok') reportReadFailure('a peer\'s summary', Object.assign(new Error('wrong shape'), { name: 'WrongShape' }));
    unread++;
    if (machine) unreadNames.push(machine);
  }
  unread += Math.max(0, peers.length - MAX_PEER_ROWS);
  const offlineNames = o.offlineMachineIds.map(name).filter((n): n is string => !!n);
  const words = headlineFor(rec(self.requests), rec(self.keys), rows, { unread, offline: o.offlineMachineIds.length, peersRead: o.peersRead });
  return {
    ...self, ...words, peers: rows,
    unread: { count: unread, names: unreadNames }, offline: { count: o.offlineMachineIds.length, names: offlineNames }, peersUnknown: !o.peersRead,
  };
}

export interface MobileSecretsDeps {
  /** Pending Secret Drop requests on this server (token stays inside the summarizer). */
  pending: () => unknown;
  keys: () => KeysRead | Promise<KeysRead>;
  /** Secret Sync's own word on the vault: either source saying it won't open is enough (the console's rule). */
  vaultBroken: () => boolean;
  sync: () => SyncRead;
  peers: () => Promise<PeerAnswer[]>;
  offlineMachineIds: () => string[];
  nicknameOf: (id: string) => string | null;
  topicName: (id: number) => string | null | undefined;
  bearerOk: (req: Request) => boolean;
  /** What this caller could do here, shown before any button (the permission reads' `actionsState`). */
  actions?: (req: Request) => unknown;
  now?: () => number;
}

// ── the phone's writes (docs/specs/mobile-native-secrets-writes.md) ─────────

/** How long a request made from the phone stays open: the longest the console offers, as the link is collected separately. */
export const PHONE_REQUEST_TTL_MS = 3_600_000;

/** The part of SecretDrop the writes use. */
export interface SecretDropWrites {
  create: (o: { label: string; description?: string; topicId?: number; ttlMs: number }) => { token: string };
  cancel: (token: string) => boolean;
  listPending: () => Array<{ token: string; label: string; expiresAt: number; expired: boolean }>;
}

export interface SecretWriteResult { status: number; body: unknown }

/** Make one request. The token stays here: the answer names it only by its one-way key. */
export function askForSecret(drop: SecretDropWrites, label: string, note: string, topicId: number | null, now: number): SecretWriteResult {
  const same = label.trim().toLowerCase();
  if (drop.listPending().some((p) => p.expired !== true && p.expiresAt > now && p.label.trim().toLowerCase() === same)) {
    return { status: 409, body: { error: 'already-waiting', detail: 'A request with this name is already waiting. Its link is in the console. To start again, cancel it first.' } };
  }
  let token: string;
  try {
    ({ token } = drop.create({ label, ...(note ? { description: note } : {}), ...(topicId !== null ? { topicId } : {}), ttlMs: PHONE_REQUEST_TTL_MS }));
  } catch (err) {
    // Anything but the pending cap goes up to the route's reported failure.
    if (!(err instanceof Error) || !err.message.startsWith('Too many pending')) throw err;
    return { status: 429, body: { error: 'too-many-requests', detail: 'Too many requests are waiting. Cancel one first.' } };
  }
  return { status: 201, body: { ok: true, key: rowKey('secret-request', token), expiresAt: new Date(now + PHONE_REQUEST_TTL_MS).toISOString() } };
}

/** Cancel the request behind a one-way key, on this machine only. */
export function cancelSecretByKey(drop: SecretDropWrites, key: string): SecretWriteResult {
  const row = drop.listPending().find((p) => rowKey('secret-request', p.token) === key);
  if (!row || !drop.cancel(row.token)) return { status: 404, body: { error: 'request-gone', detail: 'That request is already gone.' } };
  return { status: 200, body: { ok: true } };
}

function reportReadFailure(route: string, err: unknown): void {
  try {
    DegradationReporter.getInstance().report({
      feature: 'MobileSecrets.read',
      primary: `${route} answers the phone's native Passwords & keys screen`,
      fallback: 'the phone shows "can\'t tell" for that part and the owner can retry or open the console',
      reason: err instanceof Error ? err.name : 'unknown error',
      impact: 'The owner\'s phone cannot show this part until the read succeeds.',
    });
  } catch { /* @silent-fallback-ok — reporting must never turn a read into a crash */ }
}

export function mountMobileSecretsRoutes(router: Router, deps: MobileSecretsDeps): void {
  const now = () => (deps.now ? deps.now() : Date.now());
  router.get('/mobile/secrets', async (req: Request, res: Response) => {
    res.set('Cache-Control', 'no-store');
    if (!ownerOrBearer(req, deps.bearerOk)) {
      res.status(403).json({ error: 'owner-phone-required', detail: 'Only the owner\'s phone can see passwords and keys.' });
      return;
    }
    let requests: RequestsRead = { state: 'unavailable' };
    try { requests = { state: 'ok', pending: deps.pending() }; } catch (err) { reportReadFailure('pending requests', err); }
    let keys: KeysRead = { state: 'unavailable' };
    try {
      const got = await deps.keys();
      if (typeof rec(got).state === 'string') keys = got; else reportReadFailure('key names', Object.assign(new Error('wrong shape'), { name: 'WrongShape' }));
    } catch (err) { reportReadFailure('key names', err); }
    try {
      if (deps.vaultBroken()) keys = { state: 'decrypt-failed' };
    } catch (err) {
      // An unchecked vault can't back an all-clear; one already known broken stays broken.
      reportReadFailure('vault status', err);
      if (keys.state !== 'decrypt-failed') keys = { state: 'unavailable' };
    }
    let sync: SyncRead = { state: 'unavailable' };
    try {
      const got = deps.sync();
      if (typeof rec(got).state === 'string') sync = got; else reportReadFailure('sync status', Object.assign(new Error('wrong shape'), { name: 'WrongShape' }));
    } catch (err) { reportReadFailure('sync status', err); }
    const t = now();
    try {
      const self = summarizeSecrets({ requests, keys, sync, topicName: deps.topicName, now: t });
      // A read that answered in the wrong shape is as much a failed read as a throw; `off` is expected.
      const wrong = (route: string, was: string, is: unknown): void => {
        if (was !== 'unavailable' && is === 'unavailable') reportReadFailure(route, Object.assign(new Error('wrong shape'), { name: 'WrongShape' }));
      };
      wrong('pending requests', requests.state, rec(self.requests).state);
      wrong('key names', keys.state, rec(self.keys).state);
      wrong('sync status', sync.state, rec(self.sync).state);
      const head = { schemaVersion: MOBILE_SECRETS_SCHEMA_VERSION, generatedAt: new Date(t).toISOString() };
      // `?scope=local`: this machine's summary only (how one machine reads another's; never fans out again).
      if (req.query.scope === 'local') { res.json({ ...head, ...self }); return; }
      let peers: PeerAnswer[] = [];
      let offline: string[] = [];
      let peersRead = true;
      try { peers = await deps.peers(); offline = deps.offlineMachineIds(); } catch (err) { peersRead = false; reportReadFailure('other machines', err); }
      res.json({ ...head, ...(deps.actions ? { actions: deps.actions(req) } : {}), ...mergeSecrets(self, peers, { nicknameOf: deps.nicknameOf, offlineMachineIds: offline, peersRead }) });
    } catch (err) {
      reportReadFailure('GET /mobile/secrets', err);
      res.status(500).json({ error: 'secrets-unavailable' });
    }
  });
}
