/**
 * Giving the right to approve to another device (identity-security piece 3a §4; mobile-approver-mark §3.4).
 *
 *   POST   /mobile/approver/request                { presenceKey, presenceProof }  → { requestId, matchCode } to that device only
 *   DELETE /mobile/approver/request                                                 (the asking device withdraws)
 *   GET    /mobile/approver/requests                                                (an approver: how many wait; never the list)
 *   POST   /mobile/approver/lookup                 { matchCode }                   (an approver: the one request showing that code)
 *   POST   /mobile/approver/requests/:deviceId/decline                               (an approver: 24-hour wait for that device)
 *   POST   /mobile/approver/grant/draft            { requestId }                   (an approver, after the lookup: the unsigned entry)
 *   POST   /mobile/approver/grant/sign             { requestId, entry, sig }        (its signature joins the record)
 *   POST   /mobile/approver/revoke/draft|sign      { keyId } / { keyId, entry, sig } (an approver revokes an owner key, §6)
 *
 * The owner types the six-digit match code shown on the asking device into the approving device (§3.4): that ties
 * the grant to the device in the owner's hands. Requests are never listed, so a program can't wait in a list under
 * a borrowed name.
 *
 * The approver's own owner key signs an `add-owner-key` for the new device, over the entry it was shown. Refused
 * while the record is forked or held. Kept devices can't grant: they are not owner keys.
 */
import crypto from 'node:crypto';
import type { Request, Response, Router } from 'express';
import { keyHashOf, parseDevicePublicKey } from '../core/MobileDeviceKeys.js';
import { ownerKeyIdFor, recordEntryPresenceMessage } from '../core/ownerApprover.js';
import { ownerRecordEntryId, type OwnerRecordEntry } from '../core/ownerRecord.js';
import { approverClaimEnv, ownerRecordGate } from '../core/ownerRecordWiring.js';
import { activeOwnerPhone, presenceEnrollMessage, samePublicKey, signedHost } from './mobileConsoleTicket.js';
import { heldPresenceKeys, liveOwnerKeys, mayApprove, ownerKeyApproverKey, proveCandidatePresenceKey, retireApprovalKey, retiredKeyHashes, APPROVER_REQUIRED } from './mobileApprover.js';
import { dropApproverClaimFor } from './mobileApproverClaim.js';
import { recoveryStatusFor } from './mobileApproverRecovery.js';
import type { MobilePairingService } from './mobilePairingRoutes.js';

const REQUEST_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_REQUESTS = 10;
const REQUESTS_PER_DEVICE_PER_DAY = 5;
const DECLINE_WAIT_MS = 24 * 60 * 60 * 1000;
interface Ask { deviceId: string; presenceKey: string; matchCode: string; at: number; lookedUpBy: Set<string>; draft?: { by: string; entry: Omit<OwnerRecordEntry, 'sig'>; id: string } }
const asks = new Map<string, Ask>();
const askedAt = new Map<string, number[]>();
const declinedUntil = new Map<string, number>();
const revokeDrafts = new Map<string, { by: string; entry: Omit<OwnerRecordEntry, 'sig'>; id: string }>();
function prune(now: number): void { for (const [id, a] of asks) if (now - a.at >= REQUEST_TTL_MS) asks.delete(id); }
/** Piece 3d: the waiting request showing this match code (for the private-chat recovery start). */
export function findWaitingRequest(matchCode: string): { requestId: string; deviceId: string; presenceKey: string } | null {
  prune(Date.now());
  for (const [requestId, a] of asks) if (a.matchCode === matchCode) return { requestId, deviceId: a.deviceId, presenceKey: a.presenceKey };
  return null;
}
/** Piece 3d: a recovery started for this request consumes it (the recovery froze the device and key). */
export function consumeWaitingRequest(requestId: string): void { asks.delete(requestId); }
export function waitingRequestById(requestId: string): { deviceId: string; presenceKey: string } | null {
  const a = asks.get(requestId);
  return a ? { deviceId: a.deviceId, presenceKey: a.presenceKey } : null;
}
export function resetApproverGrantForTests(): void { asks.clear(); askedAt.clear(); declinedUntil.clear(); revokeDrafts.clear(); }
function newMatchCode(): string {
  for (;;) { const c = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0'); if (![...asks.values()].some((a) => a.matchCode === c)) return c; }
}

function deviceOf(req: Request): string | null {
  const p = (req as unknown as { instarPrincipal?: { kind: string; deviceId?: string } }).instarPrincipal;
  return p && p.kind === 'device' && typeof p.deviceId === 'string' ? p.deviceId : null;
}

/** Whole and not held: a grant lands on one chain every machine agrees on (§4). */
function recordReady(): { ok: true; head: string } | { ok: false; error: string; detail: string } {
  const env = approverClaimEnv();
  if (!env) return { ok: false, error: 'owner-record-off', detail: 'The owner record is turned off on this agent.' };
  const g = ownerRecordGate();
  if (g && g.act === 'hold') return { ok: false, error: 'owner-record-held', detail: 'The ownership record is on hold; nothing can be added until that clears.' };
  const st = env.store.state();
  if (!st || st.status !== 'ok' || !st.everEnrolled) return { ok: false, error: 'no-approver-yet', detail: 'This agent has no device that approves yet. Set one up with the code from your private chat.' };
  if (st.forked || st.head.length !== 1) return { ok: false, error: 'record-forked', detail: 'The ownership record has two branches. Approve joining them first.' };
  return { ok: true, head: st.head[0]! };
}

export function mountApproverGrantRoutes(router: Router, svc: MobilePairingService): void {
  router.post('/mobile/approver/request', (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const deviceId = deviceOf(req);
    if (!svc.enabled()) { res.status(503).json({ error: 'pairing-off' }); return; }
    if (!deviceId) { res.status(403).json({ error: 'device-signature-required' }); return; }
    if (!activeOwnerPhone(svc, deviceId)) { res.status(403).json({ error: 'owner-phone-required' }); return; }
    if (mayApprove(svc, deviceId)) { res.status(409).json({ error: 'already-approver' }); return; }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const key = body.presenceKey;
    if (typeof key !== 'string' || key.length > 128 || !parseDevicePublicKey(key)) { res.status(400).json({ error: 'bad-public-key' }); return; }
    const d = svc.devices.get(deviceId)!;
    if (d.publicKey && samePublicKey(key, d.publicKey)) { res.status(400).json({ error: 'bad-public-key', detail: 'The approval key must differ from the device key.' }); return; }
    if (heldPresenceKeys(svc).some((h) => h.deviceId !== deviceId && samePublicKey(h.key, key))) { res.status(400).json({ error: 'bad-public-key', detail: 'Another device already holds that key.' }); return; }
    const own = heldPresenceKeys(svc).find((h) => h.deviceId === deviceId);
    if (own && !samePublicKey(own.key, key)) { res.status(409).json({ error: 'presence-key-set', detail: 'This device already has a different approval key. Remove and pair it again to replace it.' }); return; }
    if (!proveCandidatePresenceKey(key, presenceEnrollMessage(deviceId, signedHost(req, svc, deviceId), key), body.presenceProof)) { res.status(400).json({ error: 'presence-proof-invalid' }); return; }
    const now = Date.now();
    prune(now);
    if ((declinedUntil.get(deviceId) ?? 0) > now) { res.status(429).json({ error: 'declined-wait', detail: 'This request was declined. Try again tomorrow.' }); return; }
    const recent = (askedAt.get(deviceId) ?? []).filter((t) => now - t < 24 * 60 * 60 * 1000);
    if (recent.length >= REQUESTS_PER_DEVICE_PER_DAY) { res.status(429).json({ error: 'too-many-requests', detail: 'Too many requests from this device today. Try again tomorrow.' }); return; }
    for (const [id, a] of asks) if (a.deviceId === deviceId) asks.delete(id); // one live request per device
    if (asks.size >= MAX_REQUESTS) { res.status(429).json({ error: 'too-many-requests', detail: 'Too many devices are waiting. Try again later.' }); return; }
    askedAt.set(deviceId, [...recent, now]);
    const requestId = crypto.randomBytes(16).toString('hex');
    const matchCode = newMatchCode();
    asks.set(requestId, { deviceId, presenceKey: key, matchCode, at: now, lookedUpBy: new Set() });
    res.json({ requestId, matchCode, detail: 'Type this code on a device that can already approve.' });
  });

  router.delete('/mobile/approver/request', (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const deviceId = deviceOf(req);
    if (!deviceId) { res.status(403).json({ error: 'device-signature-required' }); return; }
    let n = 0;
    for (const [id, a] of asks) if (a.deviceId === deviceId) { asks.delete(id); n++; }
    res.json({ withdrawn: n });
  });

  const approverGate = (req: Request, res: Response): { deviceId: string; key: string } | null => {
    res.setHeader('Cache-Control', 'no-store');
    if (!svc.enabled()) { res.status(503).json({ error: 'pairing-off' }); return null; }
    const deviceId = deviceOf(req);
    if (!deviceId) { res.status(403).json({ error: 'device-signature-required' }); return null; }
    const key = ownerKeyApproverKey(svc, deviceId);
    if (!key) { res.status(403).json(APPROVER_REQUIRED); return null; }
    return { deviceId, key };
  };

  // How many wait, never which: the owner picks a request only by the code on the device in their hands.
  router.get('/mobile/approver/requests', (req: Request, res: Response) => {
    if (!approverGate(req, res)) return;
    prune(Date.now());
    res.json({ waiting: [...asks.values()].filter((a) => activeOwnerPhone(svc, a.deviceId)).length });
  });

  router.post('/mobile/approver/lookup', (req: Request, res: Response) => {
    const g = approverGate(req, res);
    if (!g) return;
    prune(Date.now());
    const code = String(((req.body ?? {}) as Record<string, unknown>).matchCode ?? '').replace(/\D/g, '');
    const hits = [...asks].filter(([, a]) => a.matchCode === code && activeOwnerPhone(svc, a.deviceId));
    if (hits.length === 0) { res.status(404).json({ error: 'no-request', detail: 'No device here shows that code. Check the code, or ask on the computer that device is paired with.' }); return; }
    const [requestId, a] = hits[0]!;
    a.lookedUpBy.add(g.deviceId);
    const d = svc.devices.get(a.deviceId);
    const name = d?.label ?? d?.deviceName ?? 'Device';
    res.json({
      requestId, deviceId: a.deviceId, name, fingerprint: d?.fingerprint ?? null, pairedAt: d?.approvedAt ?? null, approvedVia: d?.approvedVia ?? null,
      sentence: `${name} will be able to approve changes to ${approverClaimEnv()?.agentId ?? 'this agent'}: permissions, passwords, trust, team access, new devices. Only do this for a phone, or a Mac with Touch ID, that is in your hands. Never for a Windows PC.`,
    });
  });

  router.post('/mobile/approver/requests/:deviceId/decline', (req: Request, res: Response) => {
    if (!approverGate(req, res)) return;
    const target = String(req.params.deviceId);
    for (const [id, a] of asks) if (a.deviceId === target) asks.delete(id);
    declinedUntil.set(target, Date.now() + DECLINE_WAIT_MS);
    res.json({ declined: true });
  });

  router.post('/mobile/approver/grant/draft', (req: Request, res: Response) => {
    const g = approverGate(req, res);
    if (!g) return;
    const a = asks.get(String(((req.body ?? {}) as Record<string, unknown>).requestId ?? ''));
    // Only a request this approver found by its match code (§3.4).
    if (!a || !a.lookedUpBy.has(g.deviceId) || !activeOwnerPhone(svc, a.deviceId)) { res.status(404).json({ error: 'no-request' }); return; }
    const ready = recordReady();
    if (!ready.ok) { res.status(409).json({ error: ready.error, detail: ready.detail }); return; }
    const env = approverClaimEnv()!;
    const d = svc.devices.get(a.deviceId);
    const entry: Omit<OwnerRecordEntry, 'sig'> = {
      v: 1, kind: 'add-owner-key', agentId: env.agentId, parents: [ready.head],
      body: { keyId: ownerKeyIdFor(a.presenceKey), publicKey: a.presenceKey, keyType: 'p256', deviceId: a.deviceId, label: (d?.label ?? d?.deviceName ?? 'Device').slice(0, 80), via: 'grant' },
      signer: { type: 'owner-key', keyId: ownerKeyIdFor(g.key) },
    };
    const id = ownerRecordEntryId(entry as OwnerRecordEntry);
    a.draft = { by: g.deviceId, entry, id };
    res.json({ entry, entryId: id, sign: recordEntryPresenceMessage(env.agentId, id) });
  });

  router.post('/mobile/approver/grant/sign', (req: Request, res: Response) => {
    const g = approverGate(req, res);
    if (!g) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const requestId = String(body.requestId ?? '');
    const a = asks.get(requestId);
    if (!a || !a.draft || a.draft.by !== g.deviceId || !activeOwnerPhone(svc, a.deviceId)) { res.status(404).json({ error: 'no-request' }); return; }
    const shown = body.entry as OwnerRecordEntry | undefined;
    if (!shown || typeof shown !== 'object' || ownerRecordEntryId({ ...shown, sig: '' } as OwnerRecordEntry) !== a.draft.id) { res.status(400).json({ error: 'entry-changed', detail: 'The entry signed is not the one shown.' }); return; }
    if (typeof body.sig !== 'string') { res.status(400).json({ error: 'presence-invalid' }); return; }
    const ready = recordReady();
    if (!ready.ok) { res.status(409).json({ error: ready.error, detail: ready.detail }); return; }
    const env = approverClaimEnv()!;
    if (env.store.state()?.keys.some((k) => k.publicKey === a.presenceKey)) { res.status(409).json({ error: 'already-owner-key', detail: 'That key can already approve. Register it on this device from the app.' }); return; }
    if (retiredKeyHashes(svc.deps.stateDir).includes(keyHashOf(a.presenceKey))) { asks.delete(requestId); res.status(409).json({ error: 'key-retired', detail: 'That device was removed. Set it up again with a new approval key.' }); return; }
    const r = env.store.ingest([{ ...a.draft.entry, sig: body.sig } as OwnerRecordEntry]);
    if (!r.added.includes(a.draft.id)) { res.status(409).json({ error: 'record-refused', detail: 'The ownership record did not accept that entry: the signature, or a key it already revoked.' }); return; }
    const set = svc.devices.setPresenceKey(a.deviceId, a.presenceKey);
    if (set !== 'set' && set !== 'same') svc.deps.reportDegradation?.('MobileApproverGrant.sign', new Error(`device record not updated (${set}); the record holds the key`));
    env.push([a.draft.id]);
    asks.delete(requestId);
    res.json({ ok: true, ownerKeyId: ownerKeyIdFor(a.presenceKey) });
  });

  // §6: an approver's signature revokes an owner key (the confirmation where there is no private chat, and the
  // record's half of a removal the owner confirmed by tap). The last live owner key can't be revoked (3d).
  router.post('/mobile/approver/revoke/draft', (req: Request, res: Response) => {
    const g = approverGate(req, res);
    if (!g) return;
    const keyId = String(((req.body ?? {}) as Record<string, unknown>).keyId ?? '');
    const ready = recordReady();
    if (!ready.ok) { res.status(409).json({ error: ready.error, detail: ready.detail }); return; }
    const env = approverClaimEnv()!;
    const target = env.store.state()!.keys.find((k) => k.type === 'owner-key' && k.keyId === keyId);
    if (!target) { res.status(404).json({ error: 'no-such-key' }); return; }
    const live = liveOwnerKeys(svc);
    if (live.length <= 1 && live.some((k) => k.keyId === keyId)) { res.status(409).json({ error: 'last-approver', detail: 'This is the only device that can approve changes. Add another one first.' }); return; }
    const entry: Omit<OwnerRecordEntry, 'sig'> = { v: 1, kind: 'revoke-key', agentId: env.agentId, parents: [ready.head], body: { keyId }, signer: { type: 'owner-key', keyId: ownerKeyIdFor(g.key) } };
    const id = ownerRecordEntryId(entry as OwnerRecordEntry);
    revokeDrafts.set(keyId, { by: g.deviceId, entry, id });
    res.json({ entry, entryId: id, sign: recordEntryPresenceMessage(env.agentId, id) });
  });

  router.post('/mobile/approver/revoke/sign', (req: Request, res: Response) => {
    const g = approverGate(req, res);
    if (!g) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const keyId = String(body.keyId ?? '');
    const draft = revokeDrafts.get(keyId);
    if (!draft || draft.by !== g.deviceId) { res.status(404).json({ error: 'no-draft' }); return; }
    const shown = body.entry as OwnerRecordEntry | undefined;
    if (!shown || typeof shown !== 'object' || ownerRecordEntryId({ ...shown, sig: '' } as OwnerRecordEntry) !== draft.id) { res.status(400).json({ error: 'entry-changed' }); return; }
    if (typeof body.sig !== 'string') { res.status(400).json({ error: 'presence-invalid' }); return; }
    const env = approverClaimEnv()!;
    const target = env.store.state()?.keys.find((k) => k.keyId === keyId);
    // Checked again now, when it takes effect: two approvers revoking each other must not leave no owner key.
    const live = liveOwnerKeys(svc);
    if (live.length <= 1 && live.some((k) => k.keyId === keyId)) { revokeDrafts.delete(keyId); res.status(409).json({ error: 'last-approver', detail: 'This is the only device that can approve changes. Add another one first.' }); return; }
    const r = env.store.ingest([{ ...draft.entry, sig: body.sig } as OwnerRecordEntry]);
    if (!r.added.includes(draft.id)) { res.status(401).json({ error: 'presence-invalid', detail: 'The ownership record did not accept that signature.' }); return; }
    if (target) retireApprovalKey(svc.deps.stateDir, target.publicKey); // every machine also stops honouring it at its next check-in
    revokeDrafts.delete(keyId);
    // The device holding that key on this machine is removed too; other machines drop it through the record.
    const holder = target ? heldPresenceKeys(svc).find((h) => h.key === target.publicKey) : undefined;
    if (holder && svc.devices.get(holder.deviceId)?.status !== 'revoked') {
      const at = new Date().toISOString();
      const d = svc.devices.get(holder.deviceId)!;
      try { svc.keyLedger?.recordRevocation(d, at); } catch (err) { svc.deps.reportDegradation?.('MobilePairing.keyLedger', err); }
      svc.devices.revoke(holder.deviceId, at);
      dropApproverClaimFor(holder.deviceId);
    }
    env.push([draft.id]);
    res.json({ ok: true, revoked: keyId });
  });

  // §3.10 (mobile-approver-mark): the list every owner device reads: who can approve, whether this device may, and
  // whether the first-approver claim is open. The claim checks every machine again when it starts.
  router.get('/mobile/approvers', (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!svc.enabled()) { res.status(503).json({ error: 'pairing-off' }); return; }
    const deviceId = deviceOf(req);
    if (!deviceId) { res.status(403).json({ error: 'device-signature-required' }); return; }
    if (!activeOwnerPhone(svc, deviceId) && !(svc.devices.get(deviceId)?.status === 'active')) { res.status(403).json({ error: 'owner-device-required' }); return; }
    const env = approverClaimEnv();
    const st = env?.store.state() ?? null;
    const live = new Set(liveOwnerKeys(svc).map((k) => k.publicKey));
    const holders: Array<Record<string, unknown>> = [];
    const devices = svc.devices.list().filter((d) => d.status === 'active');
    for (const d of devices) {
      if (!mayApprove(svc, d.id)) continue;
      const k = heldPresenceKeys(svc).find((h) => h.deviceId === d.id)?.key;
      holders.push({ deviceId: d.id, name: d.label ?? d.deviceName ?? 'Device', fingerprint: d.fingerprint ?? null, via: k && live.has(k) ? 'record' : 'kept', self: d.id === deviceId });
    }
    // Owner keys held by no device here belong to another machine's devices.
    const here = new Set(heldPresenceKeys(svc).map((h) => h.key));
    const elsewhere = (st?.keys ?? []).filter((k) => k.type === 'owner-key' && live.has(k.publicKey) && !here.has(k.publicKey)).length;
    const mine = [...asks.values()].find((a) => a.deviceId === deviceId);
    let opening: Record<string, unknown>;
    if (st?.everEnrolled) opening = { state: 'closed', reason: 'approver-exists' };
    else if (svc.approvalPath() !== 'telegram') opening = { state: 'closed', reason: 'no-private-chat' };
    else if ((svc.devices.get(deviceId)?.approvedVia ?? 'telegram-dm') !== 'telegram-dm') opening = { state: 'closed', reason: 'not-private-chat-paired' };
    else opening = { state: 'open', route: 'private-chat' };
    res.json({
      feature: 1,
      self: { mayApprove: mayApprove(svc, deviceId), ...(mine ? { request: { requestId: [...asks].find(([, a]) => a === mine)![0], matchCode: mine.matchCode } } : {}) },
      holders, holdersElsewhere: elsewhere,
      waiting: [...asks.values()].filter((a) => activeOwnerPhone(svc, a.deviceId)).length,
      opening,
      recovery: recoveryStatusFor(svc, deviceId),
    });
  });
}
