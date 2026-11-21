/**
 * The first approving device (identity-security piece 3a §3; mobile-approver-mark §3.3 with the owner record as
 * the store). Three device-signed steps:
 *
 *   POST /mobile/approver/first          { presenceKey, presenceProof }  → a word code to the owner's private chat
 *   POST /mobile/approver/first/confirm  { code }                         → the full unsigned owner-key entry
 *   POST /mobile/approver/first/sign     { entry, sig }                   → the entry joins the record
 *
 * Every condition is checked fresh at the claim and again at confirm and sign. The entry carries a proof, signed by
 * this machine's record key, that this machine checked the code; every machine verifies it against the record.
 * Spec: docs/specs/identity-security-piece3a-approver-in-owner-record.md
 */
import crypto from 'node:crypto';
import type { Request, Response, Router } from 'express';
import { ConfirmationCodes, displayCode, keyHashOf, parseDevicePublicKey } from '../core/MobileDeviceKeys.js';
import { AGENT_ID_PATTERN, firstOwnerKeyDraft, makeFirstOwnerProof, ownerKeyIdFor, recordEntryPresenceMessage } from '../core/ownerApprover.js';
import { ownerRecordEntryId, verifyEntrySignature, type OwnerRecordEntry } from '../core/ownerRecord.js';
import { approverClaimEnv, ownerRecordGate } from '../core/ownerRecordWiring.js';
import { ensureLocalRecordKey } from '../core/ownerRecordLocalKey.js';
import { activeOwnerPhone, presenceEnrollMessage, samePublicKey, signedHost } from './mobileConsoleTicket.js';
import { claimStartsToday, heldPresenceKeys, isLegacyDevice, mayApprove, recordClaimStart, retiredKeyHashes, proveCandidatePresenceKey, readApproverState } from './mobileApprover.js';
import type { MobilePairingService } from './mobilePairingRoutes.js';

export const APPROVER_FIRST_PATH = '/mobile/approver/first';
const CODE_TTL_MS = 30 * 60 * 1000; // §3b: the pairing code's own rule
const MAX_TRIES = 3;
const MAX_CLAIMS_PER_DAY = 3;
const CLAIM_LIVE_MS = 24 * 60 * 60 * 1000; // mobile-approver-mark §3.3: a claim stays live 24 h without a correct code
const PEER_DEADLINE_MS = 10_000;

interface Claim { deviceId: string; presenceKey: string; startedAt: number; tries: number; draft?: { entry: Omit<OwnerRecordEntry, 'sig'>; id: string } }

/** One live claim per machine, in memory (a restart voids it, as pairing codes are voided). */
let live: Claim | null = null;
/** One claim start at a time on this machine, so parallel starts can't pass the daily limit together. */
let starting = false;
const codes = new ConfirmationCodes();

export function approverClaimLive(now = Date.now()): boolean {
  if (live && now - live.startedAt >= CLAIM_LIVE_MS) live = null;
  return live !== null;
}
export function approverClaimDeviceId(): string | null { return approverClaimLive() ? live!.deviceId : null; }
/** A revoked device's claim is dropped (§3.3). */
export function dropApproverClaimFor(deviceId: string): void { if (live?.deviceId === deviceId) { codes.drop(deviceId); live = null; } }
/** Lease loss voids the code (§3.3). */
export function voidApproverClaimCode(): void { if (live) codes.drop(live.deviceId); }
export function resetApproverClaimForTests(): void { live = null; starting = false; codes.clearAll(); }

/** This machine's active owner devices that are neither approvers nor kept (§3 condition 4), by id. */
export function unvouchedOwnerDevices(svc: MobilePairingService, except?: string): string[] {
  if (!svc.enabled()) return [];
  return svc.devices.list()
    .filter((d) => d.id !== except && d.client !== 'browser' && activeOwnerPhone(svc, d.id))
    .filter((d) => !mayApprove(svc, d.id) && !isLegacyDevice(svc, d.id))
    .map((d) => d.id);
}

type Refusal = { reason: string; detail: string; machines?: string[]; devices?: string[] };

/** §3: every condition, fresh. Null when the claim may go ahead. */
async function conditions(svc: MobilePairingService, deviceId: string): Promise<Refusal | null> {
  const env = approverClaimEnv();
  if (!env) return { reason: 'owner-record-off', detail: 'The owner record is turned off on this agent.' };
  if (!AGENT_ID_PATTERN.test(env.agentId)) return { reason: 'agent-name-unsafe', detail: 'This agent\'s name has characters that can\'t be signed safely. Rename the project to letters, digits, dots, dashes or underscores (64 at most).' };
  const st = env.store.state();
  if (st?.everEnrolled) return { reason: 'approver-exists', detail: 'This agent already has a device that approves. Ask it to let this device in.' };
  if (readApproverState(env.stateDir).migration?.pending) return { reason: 'migration-pending', detail: 'The update is still finishing on this computer. Try again in a minute.' };
  const d = svc.devices.get(deviceId);
  if (!d || (d.approvedVia ?? 'telegram-dm') !== 'telegram-dm') return { reason: 'not-private-chat-paired', detail: 'Only a device you let in through your private chat can become the first device that approves.' };
  if (svc.approvalPath() !== 'telegram') return { reason: 'no-private-chat', detail: 'This agent has no private chat with you to send the code to.' };
  if (!env.leaseHere() || env.splitBrain()) return { reason: 'not-lease-holder', detail: 'Pair this device with the computer that is answering your chat right now, then try again.' };
  const others = unvouchedOwnerDevices(svc, deviceId);
  if (others.length > 0) return { reason: 'other-devices', detail: 'Remove the other devices that can\'t approve first, then add them back afterwards.', devices: others };
  if (!env.check) return { reason: 'machine-unreachable', detail: 'Another computer of this agent could not be asked.', machines: env.peers() };
  const peers = await env.check(PEER_DEADLINE_MS);
  const bad = [...new Set([...peers.silent, ...peers.olderBuild])];
  if (bad.length > 0) return { reason: 'machine-unreachable', detail: 'Every computer of this agent must answer and run the latest version. Bring the named computer back, update it, or remove it from the agent.', machines: bad };
  if (peers.enrolled.length > 0) return { reason: 'approver-exists', detail: 'Another computer already has a device that approves.', machines: peers.enrolled };
  if (peers.unvouched.length > 0) return { reason: 'other-devices', detail: 'Another computer has devices that can\'t approve. Remove them first, then add them back afterwards.', machines: peers.unvouched };
  // The record must be whole: not forked, with every registered machine's key on it (§2). A lone agent's record is
  // created at confirm, so there is nothing to check yet.
  if (env.store.hasRecord()) {
    const selfId = env.store.selfSigner()?.machineId;
    if (!selfId || !env.store.isWhole([selfId, ...env.peers()])) return { reason: 'record-not-ready', detail: 'The computers are still agreeing on the ownership record. Try again in a few minutes.' };
  }
  return null;
}

function refuse(res: Response, r: Refusal): void { res.json({ eligible: false, ...r }); }

export function mountApproverClaimRoutes(router: Router, svc: MobilePairingService): void {
  const gate = (req: Request, res: Response): string | null => {
    res.setHeader('Cache-Control', 'no-store');
    if (!svc.enabled()) { res.status(503).json({ error: 'pairing-off' }); return null; }
    const p = (req as unknown as { instarPrincipal?: { kind: string; deviceId?: string } }).instarPrincipal;
    if (!p || p.kind !== 'device' || typeof p.deviceId !== 'string') { res.status(403).json({ error: 'device-signature-required' }); return null; }
    if (!activeOwnerPhone(svc, p.deviceId)) { res.status(403).json({ error: 'owner-phone-required' }); return null; }
    const g = ownerRecordGate();
    if (g && g.act === 'hold') { res.status(409).json({ error: 'owner-record-held', detail: 'The ownership record is on hold; nothing can be added to it until that clears.' }); return null; }
    return p.deviceId;
  };

  router.post(APPROVER_FIRST_PATH, async (req: Request, res: Response) => {
    const deviceId = gate(req, res);
    if (!deviceId) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const key = body.presenceKey;
    if (typeof key !== 'string' || key.length > 128 || !parseDevicePublicKey(key)) { res.status(400).json({ error: 'bad-public-key' }); return; }
    const d = svc.devices.get(deviceId)!;
    if (d.publicKey && samePublicKey(key, d.publicKey)) { res.status(400).json({ error: 'bad-public-key', detail: 'The approval key must differ from the device key.' }); return; }
    if (heldPresenceKeys(svc).some((h) => h.deviceId !== deviceId && samePublicKey(h.key, key))) { res.status(400).json({ error: 'bad-public-key', detail: 'Another device already holds that key.' }); return; }
    const own = heldPresenceKeys(svc).find((h) => h.deviceId === deviceId);
    if (own && !samePublicKey(own.key, key)) { res.status(409).json({ error: 'presence-key-set', detail: 'This device already has a different approval key. Remove and pair it again to replace it.' }); return; }
    if (!proveCandidatePresenceKey(key, presenceEnrollMessage(deviceId, signedHost(req, svc, deviceId), key), body.presenceProof)) { res.status(400).json({ error: 'presence-proof-invalid' }); return; }
    if (retiredKeyHashes(svc.deps.stateDir).includes(keyHashOf(key))) { res.status(409).json({ error: 'key-retired', detail: 'That approval key belonged to a removed device. Set the app up again so it makes a new one.' }); return; }
    const now = Date.now();
    if (approverClaimLive(now) && live!.deviceId !== deviceId) { refuse(res, { reason: 'claim-in-progress', detail: 'Another device is setting up approval right now.' }); return; }
    if (claimStartsToday(svc.deps.stateDir, now).length >= MAX_CLAIMS_PER_DAY) { refuse(res, { reason: 'too-many-tries', detail: 'Too many tries today. Try again tomorrow.' }); return; }
    if (starting) { refuse(res, { reason: 'claim-in-progress', detail: 'A device is already starting this. Try again in a moment.' }); return; }
    starting = true;
    try { await startClaim(req, res, deviceId, key, d, now); } finally { starting = false; }
  });

  const startClaim = async (req: Request, res: Response, deviceId: string, key: string, d: NonNullable<ReturnType<typeof svc.devices.get>>, now: number): Promise<void> => {
    void req;
    const why = await conditions(svc, deviceId);
    if (why) { refuse(res, why); return; }
    const code = codes.issue(deviceId, now + CODE_TTL_MS, 'word');
    const env = approverClaimEnv()!;
    const name = d.label ?? d.deviceName ?? 'A device';
    const fp = crypto.createHash('sha256').update(key).digest('hex').slice(0, 12).replace(/(....)(?=.)/g, '$1 ');
    const text = `${name} asked to become the device that approves changes to ${env.agentId}: permissions, passwords, trust, team access, new devices. If you are setting up your own phone or Mac right now, type this code on it: ${displayCode(code)}. Never type it into a Windows PC. If this was not you, ignore this message. Fingerprint ${fp}.`;
    let sent: number | null = null;
    try { sent = (await svc.deps.ownerDM?.(text, `approver-first-ignore:${deviceId}`)) ?? null; } catch { sent = null; /* @silent-fallback-ok: an unsent code is answered 503 below, and the claim is removed */ }
    if (sent === null) { codes.drop(deviceId); res.status(503).json({ error: 'owner-notice-unavailable', detail: 'The code could not be sent to your private chat. Try again.' }); return; }
    try { recordClaimStart(svc.deps.stateDir, now); } catch { /* @silent-fallback-ok: the code is already sent; the limit undercounts by one and is reported */ svc.deps.reportDegradation?.('MobileApproverClaim.limit', new Error('claim start not recorded')); }
    live = { deviceId, presenceKey: key, startedAt: now, tries: 0 };
    res.json({ eligible: true, expiresAt: new Date(now + CODE_TTL_MS).toISOString() });
  };

  router.post(`${APPROVER_FIRST_PATH}/confirm`, async (req: Request, res: Response) => {
    const deviceId = gate(req, res);
    if (!deviceId) return;
    if (!approverClaimLive() || live!.deviceId !== deviceId) { res.status(409).json({ error: 'no-claim', detail: 'Start again from the app.' }); return; }
    const claim = live!;
    const c = codes.check(deviceId, ((req.body ?? {}) as Record<string, unknown>).code);
    if (c.result === 'none') { res.status(410).json({ error: 'code-expired', detail: 'That code has expired. Start again from the app.' }); return; }
    if (c.result !== 'ok') {
      claim.tries++;
      if (claim.tries >= MAX_TRIES) { codes.drop(deviceId); res.status(429).json({ error: 'too-many-tries', detail: 'Too many wrong codes. Start again from the app.' }); return; }
      res.status(422).json({ error: c.result === 'wrong-format' ? 'wrong-format' : 'wrong-code', triesLeft: MAX_TRIES - claim.tries });
      return;
    }
    const why = await conditions(svc, deviceId);
    if (why) { codes.drop(deviceId); live = null; refuse(res, why); return; }
    const env = approverClaimEnv()!;
    // A lone agent gets its record-only key and the genesis now, only after a correct code (§2).
    try {
      if (!env.store.hasRecord()) {
        if (env.peers().length === 0) ensureLocalRecordKey(env.stateDir);
        env.store.bootstrap();
      }
      const st = env.store.state();
      if (!st || st.status !== 'ok' || st.head.length !== 1) { res.status(409).json({ error: 'record-not-ready', detail: 'The ownership record isn\'t ready. Try again in a few minutes.' }); return; }
      const selfFull = env.store.selfSigner();
      const me = selfFull ? st.keys.find((k) => k.type === 'machine' && k.keyId === selfFull.machineId) : undefined;
      if (!me || !selfFull) { res.status(409).json({ error: 'record-not-ready', detail: 'This computer\'s key isn\'t in the ownership record yet. Try again in a few minutes.' }); return; }
      const self = selfFull;
      const parentId = st.head[0]!;
      const proof = makeFirstOwnerProof({ agentId: env.agentId, parentId, deviceId, ownerKeyId: ownerKeyIdFor(claim.presenceKey), presenceKey: claim.presenceKey, machineId: self.machineId, sign: self.sign });
      const d = svc.devices.get(deviceId);
      const entry = firstOwnerKeyDraft({ agentId: env.agentId, parentId, deviceId, label: d?.label ?? d?.deviceName ?? 'Device', presenceKey: claim.presenceKey, proof });
      const id = ownerRecordEntryId(entry as OwnerRecordEntry);
      claim.draft = { entry, id };
      codes.drop(deviceId);
      res.json({ entry, entryId: id, sign: recordEntryPresenceMessage(env.agentId, id) });
    } catch (err) {
      svc.deps.reportDegradation?.('MobileApproverClaim.confirm', err);
      res.status(500).json({ error: 'record-write-failed', detail: 'The ownership record could not be written. Try again.' });
    }
  });

  router.post(`${APPROVER_FIRST_PATH}/sign`, async (req: Request, res: Response) => {
    const deviceId = gate(req, res);
    if (!deviceId) return;
    if (!approverClaimLive() || live!.deviceId !== deviceId || !live!.draft) { res.status(409).json({ error: 'no-claim', detail: 'Start again from the app.' }); return; }
    const claim = live!;
    const draft = claim.draft!;
    const body = (req.body ?? {}) as Record<string, unknown>;
    // The device signs the entry it was shown, after computing its id itself (§1): any change is a different id.
    const shown = body.entry as OwnerRecordEntry | undefined;
    if (!shown || typeof shown !== 'object' || ownerRecordEntryId({ ...shown, sig: '' } as OwnerRecordEntry) !== draft.id) { res.status(400).json({ error: 'entry-changed', detail: 'The entry signed is not the one shown. Start again from the app.' }); return; }
    const env = approverClaimEnv()!;
    const sig = body.sig;
    if (typeof sig !== 'string' || !verifyEntrySignature({ ...draft.entry, sig } as OwnerRecordEntry, env.agentId, claim.presenceKey, 'p256')) { res.status(409).json({ error: 'presence-invalid', detail: 'That approval signature did not match this device\'s approval key. Nothing was changed.' }); return; } // 409, not 401: 401 means the device's own request signature was refused
    // E2E-PAIRING: EXEMPT — a status-code change on an existing route, pinned by the 3a unit test; the end-to-end flow needs an owner chat and is driven on a throwaway with the stand-in owner chat (identity card wc_491e135547ea8388).
    const why = await conditions(svc, deviceId);
    if (why) { live = null; refuse(res, why); return; }
    // The record must not have moved since the entry was built: it lands on the single head it names.
    const head = env.store.state()?.head ?? [];
    if (head.length !== 1 || head[0] !== draft.entry.parents[0]) { live = null; res.status(409).json({ error: 'record-moved', detail: 'The ownership record changed meanwhile. Start again from the app.' }); return; }
    const full = { ...draft.entry, sig } as OwnerRecordEntry;
    const r = env.store.ingest([full]);
    if (!r.added.includes(draft.id) || !r.state.everEnrolled) { res.status(409).json({ error: 'record-refused', detail: 'The ownership record did not accept the entry. Start again from the app.' }); return; }
    // The device record holds the same key, so the one reader finds it (§7).
    const set = svc.devices.setPresenceKey(deviceId, claim.presenceKey);
    if (set !== 'set' && set !== 'same') svc.deps.reportDegradation?.('MobileApproverClaim.sign', new Error(`device record not updated (${set}); the record holds the key`));
    env.push([draft.id]);
    live = null;
    res.json({ ok: true, ownerKeyId: ownerKeyIdFor(claim.presenceKey) });
  });
}
