/**
 * Instar Documents — a member's computer joins from the owner's team invite, no app needed
 * (docs/specs/member-browser-any-computer.md).
 *
 *   GET  /docs/_join                  (public)  the join page
 *   POST /docs/_join/redeem           (public)  take a team invite code for this browser's key → a waiting computer
 *   POST /docs/_join/confirm          (public, signed by that key, instar-join-v1) the code from the owner's phone → joined
 *   POST /docs/_link/forget-self      (public, signed by the computer's key) Forget this computer
 *   GET  /docs/_join/addresses        (public)  the addresses where a computer is set up, display only (§3.6, SEC-169)
 *   GET  /team/computers              (bearer)  each person's computers, both kinds, and the limits in force
 *   POST /team/computer-limits        (bearer)  set the allowance and lifetimes, agent-wide or for one person (§3.5)
 *   POST /team/people/:personKey/computers/:deviceId/forget (bearer) remove one computer: taking access away only
 *
 * The anchor is the team invite's code, which is held for the owner's People screen (the owner's phone)
 * exactly as a team phone's is, and never shown to a PIN session (§3.3.7). A joined computer gets the
 * documents scope only (guests: read only), the same reach as a computer the member's phone linked.
 *
 * Every write that adds a `computer-*` row to the team log waits until every machine in the pool reads
 * those rows (`writesBlockedBy`), because an older machine would read an unknown row as a gap and hold
 * every team phone there (§5). Nothing here uses a model: every refusal is deterministic.
 */
import crypto from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { deviceKeyHashOf } from '../core/AppRecordSignatures.js';
import { normalizeRequestHost } from '../core/MobileOwnNames.js';
import { DEVICE_TIME_WINDOW_MS, isStrictLowSDer, parseDevicePublicKey, type DeviceRecord } from '../core/MobileDeviceKeys.js';
import { COMPUTER_LIMIT_DEFAULTS, computerHomeHosts, computerLimitsFor } from '../core/TeamComputers.js';
import { COMPUTER_MAX_DAYS, validateMachineEvent } from '../core/TeamAccessEvents.js';
import type { MobilePairingService } from './mobilePairingRoutes.js';
import { devicePersonOf, principalOf, redeemArrival, takePairingCode } from './mobilePairingRoutes.js';
import { isDocumentsEnabled } from './documentRoutes.js';
import { DOC_PAGE_CSP } from './documentPageRoutes.js';
import { callerAddress, computerAllowance, describeBrowser, forgetLinkedBrowser, joinedComputerStanding, linkFingerprint } from './documentLinkRoutes.js';

export const JOIN_DOMAIN = 'instar-join-v1';
const DAY_MS = 86_400_000;

/** The string a joining computer signs to confirm (§3.3.2). The code is signed, never logged. */
export function joinConfirmString(deviceId: string, host: string, timeMs: string, code: string): string {
  return `${JOIN_DOMAIN}\nconfirm\n${deviceId}\n${host.toLowerCase()}\n${timeMs}\n${code}`;
}
/** The string a computer signs to forget itself (§3.3.5). */
export function joinForgetString(deviceId: string, host: string, timeMs: string): string {
  return `${JOIN_DOMAIN}\nforget\n${deviceId}\n${host.toLowerCase()}\n${timeMs}`;
}

/** The first 8 characters of the key fingerprint, in two groups (`7F3A-91C0`): device identification, not a secret. */
export function checkLetters(publicKey: string): string {
  return linkFingerprint(publicKey).slice(0, 9);
}

/** The waiting entry's name on the owner's phone, built only from fixed words (§3.1 step 5, §3.2). */
export function waitingComputerName(publicKey: string, userAgent: unknown, address: string, atMs: number): string {
  const t = new Date(atMs);
  const hh = String(t.getHours()).padStart(2, '0');
  const mm = String(t.getMinutes()).padStart(2, '0');
  return `Computer ${checkLetters(publicKey)}, ${describeBrowser(userAgent)}, from ${address}, asked at ${hh}:${mm}`.slice(0, 200);
}

export interface DocumentJoinDeps {
  config: () => unknown;
  pairing: () => MobilePairingService | null;
  machineId: () => string | null;
  /** The machine that holds the pool's rows back until every machine reads `computer-*` rows (§5); null = open. */
  writesBlockedBy: () => string | null;
  /** The owner's name, the only person who can invite (§3.3.1). */
  ownerName: () => string;
  /** One attention item for the owner, keyed; raised again with the same key updates it (§3.3.4). */
  notice: { raise: (key: string, title: string, text: string) => void; close: (key: string) => void };
  /** The agent's own document addresses (display only, §3.6). */
  addresses: () => string[];
  now?: () => number;
}

/** The attention key for one waiting computer. */
export const waitingKey = (deviceId: string): string => `team-computer-waiting:${deviceId}`;

/** Is the signed request inside the window (§3.3.2: 5 minutes, tolerant of clock skew; the code is single use)? */
function freshTime(timeMs: unknown, now: number): timeMs is string {
  const t = Number(timeMs);
  return typeof timeMs === 'string' && /^\d{13}$/.test(timeMs) && Number.isFinite(t) && Math.abs(now - t) <= Math.max(DEVICE_TIME_WINDOW_MS, 5 * 60_000);
}

function sigValid(publicKey: string, message: string, sigB64: unknown): boolean {
  const key = parseDevicePublicKey(publicKey);
  if (!key || typeof sigB64 !== 'string' || sigB64.length > 200) return false;
  let sig: Buffer;
  try { sig = Buffer.from(sigB64, 'base64url'); } catch { return false; } // @silent-fallback-ok — malformed is invalid
  if (!isStrictLowSDer(sig)) return false;
  try { return crypto.verify('sha256', Buffer.from(message), { key, dsaEncoding: 'der' }, sig); } catch { return false; } // @silent-fallback-ok — malformed is invalid
}

/** The ledger's activation for this record, if the commit point (§3.3.2 step 3) was written. */
function hasActivation(svc: MobilePairingService, d: DeviceRecord): boolean {
  const key = d.browserPublicKey;
  if (!key || !svc.keyLedger) return false;
  const kh = deviceKeyHashOf(key);
  return svc.keyLedger.rows().some((r) => r.type === 'activation' && r.deviceId === d.id && r.keyHash === kh);
}

/** The `computer-bind` a pending computer's record fixes at redeem (§3.3.2 commit point). */
export function intendedBind(d: DeviceRecord, linkedAt: string): Record<string, unknown> | null {
  if (!d.browserPublicKey || !d.userId || !d.scope || !d.host || !d.joinIdleDays || !d.joinEndsBy) return null;
  const linked = Date.parse(linkedAt);
  const ends = Date.parse(d.joinEndsBy);
  const expiresAt = new Date(Math.min(linked + d.joinIdleDays * DAY_MS, ends)).toISOString();
  return {
    type: 'computer-bind', keyHash: deviceKeyHashOf(d.browserPublicKey), deviceId: d.id, boundTo: d.userId, host: d.host,
    browserPublicKey: d.browserPublicKey, linkedAt, expiresAt, idleDays: d.joinIdleDays, endsBy: d.joinEndsBy, scope: d.scope,
  };
}

/**
 * Finish any admission whose commit point (the ledger activation) was written but whose registry
 * activation or `computer-bind` was not (a crash between steps, §3.3.2). Idempotent; held while the
 * pool write gate is closed, and retried on the next pass.
 */
export function reconcileJoinedComputers(svc: MobilePairingService, deps: Pick<DocumentJoinDeps, 'writesBlockedBy'>, now: number): number {
  const log = svc.teamLog();
  if (!log || log.healthState() !== 'ok' || deps.writesBlockedBy()) return 0;
  let n = 0;
  for (const d of svc.devices.list()) {
    if (d.joinedVia !== 'team-invite' || (d.status !== 'pending' && d.status !== 'active') || !d.browserPublicKey) continue;
    const kh = deviceKeyHashOf(d.browserPublicKey);
    if (log.state().computerLinks.has(kh) || !hasActivation(svc, d)) continue;
    const at = d.approvedAt ?? new Date(now).toISOString();
    const bind = intendedBind(d, at);
    if (!bind) continue;
    if (d.status === 'pending') svc.devices.activateJoinedComputer(d.id, bind.expiresAt as string, at);
    log.appendMachineEvents([bind as never]);
    n++;
  }
  return n;
}

export function createDocumentJoinRoutes(deps: DocumentJoinDeps): Router {
  const router = Router();
  const now = deps.now ?? Date.now;
  const off = (res: Response): boolean => {
    if (isDocumentsEnabled(deps.config())) return false;
    res.status(503).json({ error: 'documents-off' });
    return true;
  };
  const browserOff = (svc: MobilePairingService | null, res: Response): boolean => {
    if (svc?.browserOn()) return false;
    res.status(503).json({ error: 'browser-devices-off', detail: 'Computers can\'t open documents on this agent yet.' });
    return true;
  };
  const peersUpdating = (res: Response): boolean => {
    const who = deps.writesBlockedBy();
    if (!who) return false;
    res.status(409).json({ error: 'peers-updating', machine: who, detail: `Your agent is finishing an update on ${who}. Try this link again later.` });
    return true;
  };

  router.get('/docs/_join', (_req, res) => {
    if (off(res)) return;
    res.setHeader('Content-Security-Policy', DOC_PAGE_CSP);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.type('html').send(JOIN_SHELL);
  });

  // Display only (§3.6): the way back for a computer set up on another of the agent's addresses, the
  // same for any caller and any document. SEC-169: only the addresses where a computer is set up and
  // still counts, never every machine in the pool. A computer's key lives only on its own address, so
  // no other address is ever a way back, and a public list of every machine would let a stranger find
  // each one and spend each machine's own PIN guess budget. No readable team log: an empty list.
  router.get('/docs/_join/addresses', (_req, res) => {
    if (off(res)) return;
    res.setHeader('Cache-Control', 'no-store');
    let homes: Set<string> = new Set();
    try {
      const state = deps.pairing()?.teamLog()?.state();
      if (state) homes = computerHomeHosts(state, now());
    } catch { /* @silent-fallback-ok — display only: no readable log lists nothing */ }
    const addresses = deps.addresses().filter((a) => {
      try { return homes.has(new URL(a).host.toLowerCase()); } catch { return false; }
    });
    res.json({ addresses: addresses.slice(0, 16) });
  });

  router.post('/docs/_join/redeem', (req: Request, res: Response) => {
    if (off(res)) return;
    res.setHeader('Cache-Control', 'no-store');
    if (req.headers['x-instar-request'] !== '1') { res.status(403).json({ error: 'missing-request-header' }); return; }
    const svc = deps.pairing();
    if (browserOff(svc, res)) return;
    const token = (deps.config() as { authToken?: string }).authToken;
    const log = svc!.teamLog();
    if (!token || !log || log.healthState() !== 'ok') { res.status(503).json({ error: 'pairing-unavailable', detail: 'Try again in a minute.' }); return; }
    const arrival = redeemArrival(svc!, req);
    if (!arrival.ok) { res.status(arrival.status).json(arrival.body); return; }
    const body = (req.body ?? {}) as { code?: unknown; browserPublicKey?: unknown };
    const key = typeof body.browserPublicKey === 'string' ? body.browserPublicKey : '';
    if (!parseDevicePublicKey(key)) { res.status(400).json({ error: 'bad-key' }); return; }
    if (peersUpdating(res)) return;
    // The allowance is checked before the code is taken (§3.5). A peek that names no team person
    // falls through to the take, so a guess counts as a failure there.
    const peeked = svc!.codes.peekPerson(body.code);
    if (peeked?.role === 'team' && peeked.userId) {
      const a = computerAllowance(svc!, peeked.userId, now());
      if (!a.ok) {
        if (a.reason === 'browser-link-limit') { res.status(409).json({ error: 'browser-link-limit', detail: `This person is already using as many computers as ${deps.ownerName() || 'the owner'} allows. Ask them to remove one, or choose Forget this computer on one of them.` }); return; }
        res.status(429).json({ error: 'too-many-requests', detail: 'Too many computers were set up in the last hour. Try again later.' }); return;
      }
    }
    const taken = takePairingCode(svc!, body.code, key, token, arrival.reqHost, arrival.eligible);
    if (!taken.ok) { res.status(taken.status).json(taken.body); return; }
    const r = taken.r;
    // Only a team invite opens a computer; any other code this route took is spent (§3.3.1).
    if (r.person?.role !== 'team' || !r.person.userId) {
      svc!.outcomes?.markOutcome(r.watchId, 'ended');
      res.status(403).json({ error: 'That link has expired or was already used.' });
      return;
    }
    const personKey = r.person.userId;
    const standing = svc!.teamStanding(personKey);
    if (!standing) { svc!.outcomes?.markOutcome(r.watchId, 'ended'); res.status(403).json({ error: 'That link has expired or was already used.' }); return; }
    const limits = computerLimitsFor(log.state(), personKey);
    const t = now();
    const viaOwnName = true;
    const name = waitingComputerName(key, req.headers['user-agent'], callerAddress(req, viaOwnName), t);
    const created = svc!.devices.createPendingComputer({
      browserPublicKey: key, host: arrival.reqHost, userId: personKey, scope: standing.tier === 'guest' ? 'documents-read' : 'documents',
      deviceName: name, idleDays: limits.idleDays, endsBy: new Date(t + limits.maxDays * DAY_MS).toISOString(),
    });
    if (!created.ok) { svc!.outcomes?.markOutcome(r.watchId, 'ended'); res.status(created.reason === 'duplicate-key' ? 409 : 429).json({ error: created.reason }); return; }
    const device = created.device;
    svc!.noteLinkTaken(body.code as string, device);
    // Held the way a team phone's code is: the owner's People screen reads it; no PIN route lists it.
    const code = svc!.confirm.issue(device.id, Date.parse(device.expiresAt!), 'digits');
    svc!.holdDashboardCode(device.id, code, Date.parse(device.expiresAt!));
    const letters = checkLetters(key);
    try {
      deps.notice.raise(waitingKey(device.id), `${standing.name} is waiting for a code to use a computer`,
        `Open People in the app. ${standing.name}'s computer shows the check letters ${letters}. Only give the code to ${standing.name} if their page is on your agent's own address. Tell it by voice or another channel, not as a reply to the link.`);
    } catch { /* @silent-fallback-ok — the page also tells the member to ask; the item is best-effort */ }
    res.json({ deviceId: device.id, status: 'pending', ownerName: deps.ownerName(), checkLetters: letters, expiresAt: device.expiresAt, machineId: deps.machineId(), host: arrival.reqHost });
  });

  router.post('/docs/_join/confirm', (req: Request, res: Response) => {
    if (off(res)) return;
    res.setHeader('Cache-Control', 'no-store');
    if (req.headers['x-instar-request'] !== '1') { res.status(403).json({ error: 'missing-request-header' }); return; }
    const svc = deps.pairing();
    if (browserOff(svc, res)) return;
    const log = svc!.teamLog();
    if (!log || log.healthState() !== 'ok' || !svc!.keyLedger) { res.status(503).json({ error: 'pairing-unavailable', detail: 'Try again in a minute.' }); return; }
    const b = (req.body ?? {}) as { deviceId?: unknown; code?: unknown; timeMs?: unknown; sig?: unknown };
    const d = typeof b.deviceId === 'string' ? svc!.devices.get(b.deviceId) : null;
    const host = normalizeRequestHost(req.headers.host) ?? '';
    if (svc!.devices.pairingPaused()) { res.status(429).json({ error: 'pairing-paused', detail: 'Too many wrong codes were tried on this agent recently. Try again later.' }); return; }
    if (!d || d.joinedVia !== 'team-invite' || !d.browserPublicKey) { res.status(410).json({ error: 'code-not-waiting', detail: `This code is no longer waiting. Ask ${deps.ownerName() || 'the owner'} for a new link.` }); return; }
    // The signed host must be the host this computer joined on.
    if (host !== d.host) { res.status(409).json({ error: 'wrong-address' }); return; }
    const t = now();
    if (!freshTime(b.timeMs, t)) { res.status(400).json({ error: 'clock-skew', detail: 'Your computer\'s clock looks wrong. Set it to the right time, then try again.' }); return; }
    const code = typeof b.code === 'string' ? b.code.replace(/\s+/g, '') : '';
    if (!sigValid(d.browserPublicKey, joinConfirmString(d.id, host, b.timeMs as string, code), b.sig)) { res.status(401).json({ error: 'bad-signature' }); return; }
    // A retry after success answers active, not "wrong code".
    if (d.status === 'active' && log.state().computerLinks.has(deviceKeyHashOf(d.browserPublicKey))) { res.json({ status: 'active' }); return; }
    if (d.status !== 'pending' && d.status !== 'active') { res.status(410).json({ error: 'code-not-waiting', detail: `This code is no longer waiting. Ask ${deps.ownerName() || 'the owner'} for a new link.` }); return; }
    if (peersUpdating(res)) return;
    // Re-checked at confirm: the person still on the team at a tier that allows the scope, and the allowance.
    const standing = d.userId ? svc!.teamStanding(d.userId) : null;
    if (!standing || (standing.tier === 'guest' && d.scope !== 'documents-read')) {
      svc!.confirm.drop(d.id); svc!.dropDashboardCode(d.id);
      try { svc!.devices.decline(d.id); } catch { /* @silent-fallback-ok — the code is gone, so it can never confirm */ }
      deps.notice.close(waitingKey(d.id));
      res.status(403).json({ error: 'person-unknown', detail: `You're no longer on this team. Ask ${deps.ownerName() || 'the owner'} if that's a mistake.` });
      return;
    }
    if (d.status === 'pending') {
      const a = computerAllowance(svc!, d.userId!, t);
      if (!a.ok) { res.status(a.reason === 'browser-link-limit' ? 409 : 429).json({ error: a.reason }); return; }
      const check = svc!.confirm.check(d.id, code);
      if (check.result === 'none') { res.status(410).json({ error: 'code-not-waiting', detail: `This code is no longer waiting. Ask ${deps.ownerName() || 'the owner'} for a new link.` }); return; }
      if (check.result === 'wrong-format') { res.status(422).json({ error: 'wrong-format', detail: 'That is not the code. It is six digits, shown on the owner\'s phone in People.' }); return; }
      if (check.result === 'wrong') {
        const after = svc!.devices.applyConfirm(d.id, { ok: false, wrongHmac: check.hmac });
        if (after?.status === 'declined') {
          svc!.confirm.drop(d.id); svc!.dropDashboardCode(d.id);
          try { deps.notice.raise(waitingKey(d.id), `${standing.name}'s computer was turned away`, `${standing.name}'s computer was turned away after three wrong codes. If ${standing.name} still wants in, send a new invite.`); } catch { /* @silent-fallback-ok — best-effort */ }
          res.status(403).json({ error: 'declined', detail: `That code was wrong three times. Ask ${deps.ownerName() || 'the owner'} for a new link.` });
          return;
        }
        res.status(403).json({ error: 'wrong-code', attemptsLeft: Math.max(0, 3 - (after?.wrongCodes?.length ?? 0)) });
        return;
      }
    }
    // The commit point: the ledger activation (idempotent), then the registry, then the binding.
    const at = d.approvedAt ?? new Date(t).toISOString();
    const bind = intendedBind(d, at);
    if (!bind) { res.status(500).json({ error: 'link-not-recorded', detail: 'This computer could not be set up. Ask for a new link.' }); return; }
    try {
      if (!hasActivation(svc!, d) && !svc!.keyLedger.recordActivation(d, 'team-invite', at)) throw new Error('activation-not-written');
      svc!.devices.activateJoinedComputer(d.id, bind.expiresAt as string, at);
      log.appendMachineEvents([bind as never]);
    } catch (err) {
      // The reconcile pass finishes a written commit point; nothing works until the bind exists.
      svc!.reportTeamFault('Documents.joinRecord', err);
      res.status(503).json({ error: 'link-not-recorded', detail: 'Saving this computer didn\'t finish. Try the same code again in a minute.' });
      return;
    }
    svc!.confirm.drop(d.id); svc!.dropDashboardCode(d.id);
    try { deps.notice.close(waitingKey(d.id)); } catch { /* @silent-fallback-ok — best-effort */ }
    res.json({ status: 'active', deviceId: d.id, machineId: deps.machineId(), host: d.host, expiresAt: bind.expiresAt, scope: d.scope });
  });

  router.post('/docs/_link/forget-self', (req: Request, res: Response) => {
    if (off(res)) return;
    res.setHeader('Cache-Control', 'no-store');
    if (req.headers['x-instar-request'] !== '1') { res.status(403).json({ error: 'missing-request-header' }); return; }
    const svc = deps.pairing();
    if (!svc) { res.status(503).json({ error: 'pairing-unavailable' }); return; }
    const b = (req.body ?? {}) as { deviceId?: unknown; timeMs?: unknown; sig?: unknown };
    const d = typeof b.deviceId === 'string' ? svc.devices.get(b.deviceId) : null;
    const host = normalizeRequestHost(req.headers.host) ?? '';
    if (!d || !d.scope || !d.browserPublicKey || d.host !== host) { res.status(404).json({ error: 'unknown-computer' }); return; }
    if (!freshTime(b.timeMs, now())) { res.status(400).json({ error: 'clock-skew', detail: 'Your computer\'s clock looks wrong. Set it to the right time, then try again.' }); return; }
    if (!sigValid(d.browserPublicKey, joinForgetString(d.id, host, b.timeMs as string), b.sig)) { res.status(401).json({ error: 'bad-signature' }); return; }
    try { forgetLinkedBrowser(svc, { id: d.id, browserPublicKey: d.browserPublicKey }, new Date(now()).toISOString()); } catch (err) { // @silent-fallback-ok — not silent: reported, and the caller is answered 503
      svc.reportTeamFault('Documents.forgetSelf', err);
      res.status(503).json({ error: 'forget-not-recorded', detail: 'Try again in a minute.' });
      return;
    }
    res.json({ ok: true });
  });

  // ── The agent's own routes (bearer): taking access away, and resource limits (§3.3.6, §3.5) ──
  const agentOnly = (req: Request, res: Response): MobilePairingService | null => {
    res.setHeader('Cache-Control', 'no-store');
    if (off(res)) return null;
    if (principalOf(req).kind !== 'token') { res.status(403).json({ error: 'agent-token-required' }); return null; }
    const svc = deps.pairing();
    if (!svc || !svc.teamLog()) { res.status(503).json({ error: 'team-access-unavailable' }); return null; }
    return svc;
  };

  router.get('/team/computers', (req, res) => {
    const svc = agentOnly(req, res);
    if (!svc) return;
    const state = svc.teamLog()!.state();
    const t = now();
    const people = [...state.people.values()].map((p) => ({ personKey: p.personKey, name: p.name, computers: computersOfPerson(svc, p.personKey, t), limits: computerLimitsFor(state, p.personKey) }));
    res.json({ people, defaults: COMPUTER_LIMIT_DEFAULTS, limits: computerLimitsFor(state, null) });
  });

  router.post('/team/computer-limits', (req, res) => {
    const svc = agentOnly(req, res);
    if (!svc) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const ev: Record<string, unknown> = { type: 'computer-limits' };
    for (const k of ['personKey', 'maxPerPerson', 'maxNewPerHour', 'idleDays', 'maxDays']) if (b[k] !== undefined) ev[k] = b[k];
    const valid = validateMachineEvent(ev);
    if (!valid) { res.status(400).json({ error: 'bad-limits', detail: `Whole numbers: maxPerPerson and maxNewPerHour at least 1; idleDays and maxDays 1 to ${COMPUTER_MAX_DAYS}, maxDays not below idleDays.` }); return; }
    if (typeof ev.personKey === 'string' && !svc.teamLog()!.state().people.has(ev.personKey)) { res.status(404).json({ error: 'unknown-person' }); return; }
    if (peersUpdating(res)) return;
    svc.teamLog()!.appendMachineEvents([valid]);
    res.json({ ok: true, appliesTo: typeof ev.personKey === 'string' ? 'person' : 'everyone', limits: computerLimitsFor(svc.teamLog()!.state(), typeof ev.personKey === 'string' ? ev.personKey : null) });
  });

  router.post('/team/people/:personKey/computers/:deviceId/forget', (req, res) => {
    const svc = agentOnly(req, res);
    if (!svc) return;
    forgetPersonComputerRoute(svc, String(req.params.personKey), String(req.params.deviceId), 'Documents.forgetByAgent', now(), res);
  });

  // The owner's phone removes a member's computer from People (taking access away; owner phones only,
  // checked again here after the device allowlist's ownerOnly rule).
  router.post('/mobile/team/people/:personKey/computers/:deviceId/forget', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (off(res)) return;
    const svc = deps.pairing();
    if (!svc || !svc.teamLog()) { res.status(503).json({ error: 'team-access-unavailable' }); return; }
    if (principalOf(req).kind !== 'device' || devicePersonOf(req)?.role !== 'owner') { res.status(403).json({ error: 'owner-phone-required' }); return; }
    forgetPersonComputerRoute(svc, String(req.params.personKey), String(req.params.deviceId), 'Documents.forgetByOwnerPhone', now(), res);
  });

  return router;
}

/**
 * A person's computers of both kinds that still count (member-browser-any-computer §3.3.6): phone-linked
 * ones by their link, joined ones by their replicated standing. Shared by the agent's and the owner's reads.
 */
export function computersOfPerson(svc: MobilePairingService, personKey: string, now: number): Array<{ deviceId: string; via: 'person-phone' | 'team-invite'; name: string; host: string | null; linkedAt: string; expiresAt: string }> {
  const state = svc.teamLog()?.state();
  if (!state) return [];
  const linked = [...state.browserLinks.values()].filter((l) => l.boundTo === personKey && !l.unbound && Date.parse(l.expiresAt) > now && !svc.keyLedger?.keyRevoked(l.keyHash))
    .map((l) => ({ deviceId: l.deviceId, via: 'person-phone' as const, name: 'A computer their phone linked', host: null, linkedAt: l.linkedAt, expiresAt: l.expiresAt }));
  const joined = [...(state.computerLinks?.values() ?? [])].filter((l) => l.boundTo === personKey)
    .flatMap((l) => { const st = joinedComputerStanding(svc, l.keyHash, now); return st ? [{ deviceId: l.deviceId, via: 'team-invite' as const, name: `Computer ${checkLetters(l.browserPublicKey)}`, host: l.host, linkedAt: l.linkedAt, expiresAt: new Date(st.expiresAt).toISOString() }] : []; });
  return [...linked, ...joined];
}

/** Forget one of a person's computers (either kind) everywhere, answering the route. Taking access away only. */
function forgetPersonComputerRoute(svc: MobilePairingService, personKey: string, id: string, feature: string, now: number, res: Response): void {
  const state = svc.teamLog()!.state();
  const joined = [...(state.computerLinks?.values() ?? [])].find((l) => l.boundTo === personKey && l.deviceId === id && !l.unbound);
  const linked = joined ? null : [...state.browserLinks.values()].find((l) => l.boundTo === personKey && l.deviceId === id && !l.unbound);
  let key: string | null = joined?.browserPublicKey ?? null;
  if (!key && linked) {
    try { const body = JSON.parse(Buffer.from(linked.signed.bodyB64, 'base64url').toString('utf8')) as { browserPublicKey?: unknown }; key = typeof body.browserPublicKey === 'string' ? body.browserPublicKey : null; } catch { key = null; } // @silent-fallback-ok — unreadable names nothing
  }
  if (!key) { res.status(404).json({ error: 'unknown-computer' }); return; }
  try { forgetLinkedBrowser(svc, { id, browserPublicKey: key }, new Date(now).toISOString()); } catch (err) { // @silent-fallback-ok — not silent: reported, and the caller is answered 503
    svc.reportTeamFault(feature, err);
    res.status(503).json({ error: 'forget-not-recorded', detail: 'Try again in a minute.' });
    return;
  }
  res.json({ ok: true });
}

/** Is this joined computer still in force here (used by the page's end-date line and the renew hook)? */
export function joinedEndsAt(svc: MobilePairingService, d: DeviceRecord, now: number): string | null {
  if (d.joinedVia !== 'team-invite' || !d.browserPublicKey) return null;
  const st = joinedComputerStanding(svc, deviceKeyHashOf(d.browserPublicKey), now);
  return st ? new Date(st.expiresAt).toISOString() : null;
}

const JOIN_SHELL = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="referrer" content="no-referrer">
<title>Use this computer</title>
<link rel="stylesheet" href="/docs/_assets/doc-page.css">
<script type="module" src="/docs/_assets/join-page.js"></script>
</head>
<body>
<main id="doc" aria-live="polite"><p class="loading">Setting up this computer…</p></main>
</body>
</html>
`;
