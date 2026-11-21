/**
 * Recovery when every approving device is lost, through the owner's private chat (identity-security piece 3d).
 *
 *   /approver_reset <match code>   in the private chat (the Telegram adapter hands it here)  → Start / Never mind
 *   POST /mobile/approver/recovery/stop          { recoveryId, presenceSig }   a counted owner key's signed Stop
 *   POST /mobile/approver/recovery/seen          { recoveryId }                a device paired before the start saw it
 *   POST /mobile/approver/recovery/finish                                       the candidate asks for the finish code
 *   POST /mobile/approver/recovery/finish/confirm { code }                     → the entry to sign (proof included)
 *   POST /mobile/approver/recovery/finish/sign   { entry, sig }                → second read, then the record
 *
 * The state and decisions are in src/core/approverRecovery.ts. Spec: docs/specs/identity-security-piece3d-approver-recovery.md
 */
import crypto from 'node:crypto';
import type { Request, Response, Router } from 'express';
import { ConfirmationCodes, displayCode, keyHashOf } from '../core/MobileDeviceKeys.js';
import { ownerKeyIdFor, recordEntryPresenceMessage, recoveryProofMessage } from '../core/ownerApprover.js';
import { ownerRecordEntryId, verifyEntrySignature, type OwnerRecordEntry } from '../core/ownerRecord.js';
import { approverClaimEnv, ownerRecordPeersMissingGuard } from '../core/ownerRecordWiring.js';
import {
  allFactsAfter, approvalSinceStart, arrivalDecision, endReason, endStops, finishRead, ingestPeerFacts, isReady, isSettled, noteOwnerKeys, noticeDue, onFirstSight, readRecovery, recordArrival, recordStop, recoveryForStopNonceHash,
  recoveryFacts, writeRecovery, RECOVERY_WAIT_MS, type ApproverRecoveryFacts, STOP_KEY_MIN_AGE_MS, type HomeRecovery,
} from '../core/approverRecovery.js';
import { activeOwnerPhone } from './mobileConsoleTicket.js';
import { heldPresenceKeys, proveCandidatePresenceKey, readApproverState, retireApprovalKey, retiredKeyHashes, setRecoveredKeyCheck, verifyApproverPresence } from './mobileApprover.js';
import { consumeWaitingRequest, findWaitingRequest, waitingRequestById, waitingRequestKeysFor } from './mobileApproverGrant.js';
import type { MobilePairingService } from './mobilePairingRoutes.js';

const GUARD = 'approver-recovery';
const START_CARD_MS = 30 * 60_000;
const FINISH_CODE_MS = 30 * 60_000;
const FINISH_TRIES = 3;

/** Taps on the private-chat cards: Start / Never mind, and Stop on a notice. Single use. */
const taps = new Map<string, { kind: 'start'; requestId: string; deviceId: string; keyHash: string; at: number } | { kind: 'stop'; recoveryId: string; at: number }>();
const finishCodes = new ConfirmationCodes();
let finishTries = 0;
let finishDraft: { recoveryId: string; entry: Omit<OwnerRecordEntry, 'sig'>; id: string; finishedAt: string } | null = null;
const told = new Set<string>();

/** The owner's private chat, with our own button labels (null: no message id, i.e. not accepted). Set by the server. */
type ChatSend = (text: string, buttons: Array<{ text: string; data: string }>) => Promise<number | null>;
let chatSend: ChatSend | null = null;
export function setRecoveryChat(fn: ChatSend | null): void { chatSend = fn; }
async function chat(svc: MobilePairingService, text: string, buttons: Array<{ text: string; data: string }> = []): Promise<number | null> {
  if (chatSend) return chatSend(text, buttons);
  return (await svc.deps.ownerDM?.(text, buttons[0]?.data ?? `md:d:${crypto.randomBytes(12).toString('hex')}`)) ?? null;
}

export function resetApproverRecoveryForTests(): void { taps.clear(); finishCodes.clearAll(); finishTries = 0; finishDraft = null; told.clear(); ticking = null; }

function selfId(): string | null { return approverClaimEnv()?.store.selfSigner()?.machineId ?? null; }
/** The machines registered now (this one included): removed machines no longer have to accept (review M3). */
function registeredNow(): Set<string> { const env = approverClaimEnv(); const me = selfId(); return new Set([...(me ? [me] : []), ...(env?.peers() ?? [])]); }
const sha = (x: string): string => crypto.createHash('sha256').update(x).digest('hex');
function now(): number { return Date.now(); }
function devName(svc: MobilePairingService, id: string): string { const d = svc.devices.get(id); return d?.label ?? d?.deviceName ?? 'A device'; }
function fp(key: string): string { return ownerKeyIdFor(key).slice(2, 18).toUpperCase().replace(/(....)(?=.)/g, '$1-'); }

/** The hooks the store and the sync reach (set once by the server). */
export function recoveryHooksFor(svc: MobilePairingService) {
  const stateDir = svc.deps.stateDir;
  stateDirForKeys = stateDir;
  const lastPresence = () => readApproverState(stateDir).lastPresence ?? null;
  // The one approver reader asks this before honouring a recovered key: unsettled keys approve nothing.
  setRecoveredKeyCheck((keyId) => {
    const env = approverClaimEnv(); const me = selfId();
    const rec = env?.store.recoveryOfKey(keyId);
    return !rec || (me !== null && isSettled(stateDir, rec.recoveryId, me, rec.entryId, registeredNow()));
  });
  // Review L6: every machine pushes to the owner's devices on its own first sight of a recovery.
  onFirstSight((recoveryId) => { svc.push?.notifyHere({ kind: 'notice', subject: 'approver-recovery', dedupeKey: `approver-recovery:${recoveryId}:seen` }); });
  return {
    arrival: (e: OwnerRecordEntry): 'accept' | 'hold' | 'retire' | 'refuse' => {
      const b = e.body as Record<string, unknown>;
      const r = b.recovery as Record<string, unknown> | undefined;
      const me = selfId();
      if (!r || typeof r.recoveryId !== 'string' || !me) return 'hold';
      let entryId = ''; try { entryId = ownerRecordEntryId(e); } catch { return 'hold'; /* @silent-fallback-ok: malformed; held */ }
      const proofBy = String((r.proof as { by?: unknown } | undefined)?.by ?? '');
      // Decision only: the arrival is recorded after 2a judged the entry and the store kept it (review H2).
      return arrivalDecision(stateDir, { recoveryId: r.recoveryId, entryId, candidateDeviceId: String(b.deviceId), candidateKeyHash: keyHashOf(String(b.publicKey)), proofBy, now: now(), selfMachineId: me, lastPresence: lastPresence(), registeredNow: [...registeredNow()] });
    },
    accepted: (e: OwnerRecordEntry): void => {
      const r = (e.body as Record<string, unknown>).recovery as Record<string, unknown>;
      recordArrival(stateDir, String(r.recoveryId), 'accepted', ownerRecordEntryId(e));
    },
    retire: (e: OwnerRecordEntry): void => {
      const b = e.body as Record<string, unknown>;
      const r = b.recovery as Record<string, unknown>;
      retireApprovalKey(stateDir, String(b.publicKey));
      recordArrival(stateDir, String(r.recoveryId), 'retired', ownerRecordEntryId(e));
      recordStop(stateDir, { recoveryId: String(r.recoveryId), at: now(), by: selfId() ?? 'this-machine', kind: 'approval', lock: false });
      ownerOnce(svc, `retire:${String(r.recoveryId)}`, `${selfId() ?? 'A computer'} saw a device approve something during the recovery, so the recovered device can't approve. If that was you, set it up again from a device that can approve.`);
    },
    unsettled: (keyId: string): boolean => {
      const env = approverClaimEnv(); const me = selfId();
      const rec = env?.store.recoveryOfKey(keyId);
      return !!rec && !(me !== null && isSettled(stateDir, rec.recoveryId, me, rec.entryId, registeredNow()));
    },
    signedFacts: () => ({ ...recoveryFacts(stateDir, { now: now(), lastPresence: lastPresence() }), retired: retiredKeyHashes(stateDir) }),
    peerFacts: (peer: string, facts: unknown, at: number) => ingestPeerFacts(stateDir, peer, facts, at, [...registeredNow()]),
  };
}

function ownerOnce(svc: MobilePairingService, key: string, text: string): void {
  if (told.has(key)) return;
  told.add(key);
  // Persisted (bounded) so a restart never repeats a milestone message.
  try {
    const f = readRecovery(svc.deps.stateDir);
    if ((f.told ?? []).includes(key)) return;
    writeRecovery(svc.deps.stateDir, { ...f, told: [...(f.told ?? []), key].slice(-200) });
  } catch { /* @silent-fallback-ok: the in-memory set still prevents repeats until a restart */ }
  void chat(svc, text).catch(() => null);
}

// ── Start, from the private chat ────────────────────────────────────────────

/**
 * `/approver_reset [code]` from the owner in their private chat (the adapter checks the sender, the chat, forwarding
 * and that the update came from Telegram itself). Returns the card's text and buttons, or just text.
 */
export function approverResetCommand(svc: MobilePairingService, args: string): { text: string; buttons?: Array<{ text: string; data: string }> } {
  const explain = 'If you lost every device that can approve changes: on your new phone open Approve changes and tap "Ask to approve on this device". It shows a six-digit code. Then send /approver_reset followed by that code here.';
  const code = args.replace(/\D/g, '');
  if (code.length !== 6) return { text: explain };
  const why = startRefusal(svc);
  if (why) return { text: why };
  const req = findWaitingRequest(code);
  if (!req) return { text: 'No device on this computer is asking with that code. Check the code on the new phone.' };
  const d = svc.devices.get(req.deviceId);
  if (!d || d.client === 'browser' || !activeOwnerPhone(svc, req.deviceId) || (d.approvedVia ?? 'telegram-dm') !== 'telegram-dm') return { text: 'That device can\'t be recovered to: it must be a phone or Mac you let in through this chat.' };
  if (retiredKeyHashes(svc.deps.stateDir).includes(keyHashOf(req.presenceKey))) return { text: 'That approval key belonged to a removed device. Set the app up again so it makes a new one.' };
  const env = approverClaimEnv()!;
  const holders = (env.store.state()?.keys ?? []).filter((k) => k.type === 'owner-key').map((k) => k.keyId);
  const nonceStart = crypto.randomBytes(12).toString('hex');
  taps.set(nonceStart, { kind: 'start', requestId: req.requestId, deviceId: req.deviceId, keyHash: keyHashOf(req.presenceKey), at: now() });
  const text = `This will let ${devName(svc, req.deviceId)} (key ${fp(req.presenceKey)}) approve changes to ${env.agentId}, without a yes from a device that already can. `
    + `Devices that can approve now: ${holders.length} in the ownership record. If you still have one of them, stop here and use it instead. `
    + 'Nothing changes for 72 hours, and I will message you three times. Any device that can approve stops this by approving anything. Never type a finish code into a Windows PC.';
  return { text, buttons: [{ text: 'Start', data: `md:a:${nonceStart}` }, { text: 'Never mind', data: `md:d:${nonceStart}` }] };
}

/** Why Start is refused right now, or null (spec §1 step 2). */
function startRefusal(svc: MobilePairingService): string | null {
  const env = approverClaimEnv();
  if (!env) return 'The ownership record is off on this agent.';
  if (!env.store.state()?.everEnrolled) return 'No device has ever approved changes for this agent, so there is nothing to recover. Set one up in the app with the code from this chat.';
  if (!env.leaseHere() || env.splitBrain()) return 'Send this to the computer that is answering this chat right now.';
  const f = readRecovery(svc.deps.stateDir);
  if (f.lockUntil && f.lockUntil > now()) return `A device that can approve stopped a recovery recently. You can start another after ${new Date(f.lockUntil).toUTCString()}.`;
  if (f.home && (f.home.state === 'waiting' || f.home.state === 'ready' || f.home.state === 'finished')) return 'A recovery is already running.';
  const peerRunning = Object.entries(f.peers).find(([, p]) => p.facts.recovery && (p.facts.recovery.state === 'waiting' || p.facts.recovery.state === 'ready'));
  if (peerRunning) return `A recovery is already running on ${peerRunning[0]}.`;
  const missing = ownerRecordPeersMissingGuard(GUARD);
  if (missing.length) return `Every computer of this agent must be up to date and answering first: ${missing.join(', ')}.`;
  return null;
}

/** What a Stop tap may honestly say: a finished recovery may already have settled on another computer (review R3-M1). */
function stopTapWords(svc: MobilePairingService, recoveryId: string): string {
  const f = readRecovery(svc.deps.stateDir);
  const finished = (f.home?.recoveryId === recoveryId && f.home.state === 'finished')
    || Object.values(f.peers).some((p) => p.facts.recovery?.recoveryId === recoveryId && p.facts.recovery.state === 'finished');
  return finished
    ? 'Stop recorded. This may already have finished on your other computers: if the recovered device can approve, remove it under Devices that can approve.'
    : 'Stopped. Nothing changed.';
}

/** The owner's Start / Never mind tap (verified by the adapter's callback path). */
export function approverRecoveryTap(svc: MobilePairingService, nonce: string, yes: boolean): { handled: boolean; text: string } {
  const t = taps.get(nonce);
  if (!t) {
    // A Stop tap whose card was sent before a restart or by another machine (review M1): its hash is in signed facts.
    const rid = yes ? recoveryForStopNonceHash(svc.deps.stateDir, sha(nonce)) : null;
    if (!rid) return { handled: false, text: '' };
    const me = selfId();
    if (me && readRecovery(svc.deps.stateDir).settledHere?.[rid] !== undefined) return { handled: true, text: 'This already finished. Remove the recovered device under Devices that can approve.' };
    void me;
    recordStop(svc.deps.stateDir, { recoveryId: rid, at: now(), by: 'owner-chat', kind: 'chat', lock: false });
    return { handled: true, text: stopTapWords(svc, rid) };
  }
  taps.delete(nonce);
  if (t.kind === 'stop') {
    if (!yes) return { handled: true, text: 'OK.' };
    if (readRecovery(svc.deps.stateDir).settledHere?.[t.recoveryId] !== undefined) return { handled: true, text: 'This already finished. Remove the recovered device under Devices that can approve.' };
    recordStop(svc.deps.stateDir, { recoveryId: t.recoveryId, at: now(), by: 'owner-chat', kind: 'chat', lock: false });
    const h = readRecovery(svc.deps.stateDir).home;
    void h;
    return { handled: true, text: stopTapWords(svc, t.recoveryId) };
  }
  if (!yes) return { handled: true, text: 'Nothing started.' };
  if (now() - t.at > START_CARD_MS) return { handled: true, text: 'That card has expired. Send /approver_reset with the code again.' };
  const why = startRefusal(svc);
  if (why) return { handled: true, text: why };
  const req = waitingRequestById(t.requestId);
  if (!req || req.deviceId !== t.deviceId || keyHashOf(req.presenceKey) !== t.keyHash) return { handled: true, text: 'That request has changed or ended. Nothing started.' };
  const env = approverClaimEnv()!;
  const me = selfId();
  if (!me) return { handled: true, text: 'This computer has no key in the ownership record yet. Nothing started.' };
  const retired = new Set(retiredKeyHashes(svc.deps.stateDir));
  const counted = (env.store.state()?.keys ?? []).filter((k) => k.type === 'owner-key' && !retired.has(keyHashOf(k.publicKey))).map((k) => ({ keyId: k.keyId, publicKey: k.publicKey, addedAt: addedAt(k.keyId) }));
  const home: HomeRecovery = {
    recoveryId: crypto.randomBytes(16).toString('hex'), startedAt: now(), targetDeviceId: t.deviceId, targetName: devName(svc, t.deviceId), requestId: t.requestId,
    presenceKey: req.presenceKey, keyHash: t.keyHash, countedKeys: counted, home: me, stopNonceHashes: [], lostKeys: (env.store.state()?.keys ?? []).filter((k) => k.type === 'owner-key').map((k) => ({ keyId: k.keyId, publicKey: k.publicKey })), machinesAtStart: [me, ...env.peers()].sort(), notices: [null, null, null], state: 'waiting',
  };
  const f = readRecovery(svc.deps.stateDir);
  writeRecovery(svc.deps.stateDir, { ...f, home });
  // The recovery froze the device and key; the request (which expires after a day, and lives in memory) is done.
  consumeWaitingRequest(t.requestId);
  recoveryTick(svc).catch(() => undefined); // the first notice goes now (review L5: never an unhandled rejection)
  return { handled: true, text: 'Started. Nothing changes for 72 hours. Any device that can approve stops it by approving anything.' };
}

/** When this machine first saw an owner key (for the 24-hour Stop rule); null when unknown, which never locks. */
let stateDirForKeys: string | null = null;
function addedAt(keyId: string): number | null {
  return stateDirForKeys ? (readRecovery(stateDirForKeys).keyFirstSeen?.[keyId] ?? null) : null;
}

// ── The tick: notices, ready, the ends, settling ────────────────────────────

/** One tick at a time: two overlapping ticks would both send the same notice. */
let ticking: Promise<void> | null = null;
export function recoveryTick(svc: MobilePairingService): Promise<void> {
  if (ticking) return ticking.then(() => recoveryTick(svc));
  ticking = recoveryTickOnce(svc).finally(() => { ticking = null; });
  return ticking;
}

async function recoveryTickOnce(svc: MobilePairingService): Promise<void> {
  const stateDir = svc.deps.stateDir;
  const env = approverClaimEnv();
  const t = now();
  noteOwnerKeys(stateDir, (env?.store.state()?.keys ?? []).filter((k) => k.type === 'owner-key').map((k) => k.keyId), t);
  const f = readRecovery(stateDir);
  const h = f.home;
  // A lease holder tells the owner once when a peer's recovery is paused because its home lost the lease.
  if (env?.leaseHere()) {
    for (const [peer, p] of Object.entries(f.peers)) {
      const r = p.facts.recovery;
      if (r && (r.state === 'waiting' || r.state === 'ready')) ownerOnce(svc, `paused:${r.recoveryId}:${peer}`, `The recovery for ${r.targetName} is paused until ${peer} is answering your chat again.`);
    }
  }
  if (!h) return;
  // A stop, or an approval by a living approver anywhere during the wait, ends it now (review M6).
  const approvedBy = (h.state === 'waiting' || h.state === 'ready') ? approvalSinceStart(stateDir, h, readApproverState(stateDir).lastPresence ?? null) : null;
  if (approvedBy) recordStop(stateDir, { recoveryId: h.recoveryId, at: t, by: approvedBy, kind: 'approval', lock: false });
  if ((h.state === 'waiting' || h.state === 'ready') && readRecovery(stateDir).stops.some((x) => x.recoveryId === h.recoveryId)) {
    writeRecovery(stateDir, { ...readRecovery(stateDir), home: { ...h, state: 'stopped', endedReason: 'stopped' } });
    endStops(stateDir, h.recoveryId, t);
    ownerOnce(svc, `stopped:${h.recoveryId}`, `The recovery for ${h.targetName} was stopped${approvedBy ? ` because ${approvedBy} approved something` : ''}. Nothing changed.`);
    return;
  }
  const end = endReason(h, t);
  if (end) {
    writeRecovery(stateDir, { ...f, home: { ...h, state: 'ended', endedReason: end } });
    endStops(stateDir, h.recoveryId, t);
    ownerOnce(svc, `ended:${h.recoveryId}`, `The recovery for ${h.targetName} ended without finishing. Nothing changed. You can start again.`);
    return;
  }
  if (h.state === 'finished' && h.entryId) {
    const me = selfId();
    if (!me || !isSettled(stateDir, h.recoveryId, me, h.entryId, registeredNow())) return;
    // Umbrella §4.5a: the lost keys named at the start are revoked, after settling plus one clean round (§3).
    if (!h.settledAt) { writeRecovery(stateDir, { ...f, home: { ...h, settledAt: t } }); ownerOnce(svc, `settled:${h.recoveryId}`, `${h.targetName} can approve changes now.`); return; }
    // One clean round: every remaining machine's facts arrived after settling, with no stop (review M5).
    if (!h.lostRetired && t - h.settledAt >= 15 * 60_000 && allFactsAfter(stateDir, h.machinesAtStart.filter((m) => registeredNow().has(m)), me, h.settledAt)) {
      for (const k of h.lostKeys) retireApprovalKey(stateDir, k.publicKey);
      writeRecovery(stateDir, { ...readRecovery(stateDir), home: { ...h, lostRetired: true } });
      endStops(stateDir, h.recoveryId, t);
      ownerOnce(svc, `lost:${h.recoveryId}`, `The devices you lost can no longer approve. Open Approve changes on ${h.targetName} to remove them from the record.`);
    }
    return;
  }
  if (!env?.leaseHere()) return; // notices go only from the home while it holds the lease
  const due = noticeDue(h, t);
  if (due !== null) {
    const left = Math.max(0, Math.ceil((h.startedAt + RECOVERY_WAIT_MS - t) / 3600_000));
    const nonce = crypto.randomBytes(12).toString('hex');
    taps.set(nonce, { kind: 'stop', recoveryId: h.recoveryId, at: t });
    { const g0 = readRecovery(stateDir); if (g0.home?.recoveryId === h.recoveryId) writeRecovery(stateDir, { ...g0, home: { ...g0.home, stopNonceHashes: [...(g0.home.stopNonceHashes ?? []), sha(nonce)].slice(-10) } }); }
    const seen = h.seenBy?.length ? ` Seen on: ${h.seenBy.map((s) => devName(svc, s.deviceId)).join(', ')}.` : ' No other device has confirmed seeing this yet.';
    const held = heldPresenceKeys(svc);
    const lost = h.lostKeys.map((k) => held.find((x) => x.key === k.publicKey)).filter((x): x is { deviceId: string; key: string } => !!x).map((x) => devName(svc, x.deviceId));
    const text = `${due === 2 ? 'Final notice' : 'Notice'}: someone started recovering who can approve changes, for ${h.targetName}. About ${left} hours left. `
      + `When it finishes, these will no longer approve: ${lost.length ? lost.join(', ') : `${h.lostKeys.length} device(s)`}. `
      + `Any device that can approve stops it by approving anything, or tap Stop it.${seen}`;
    let id: number | null = null;
    try { id = await chat(svc, text, [{ text: 'Stop it', data: `md:a:${nonce}` }]); } catch { id = null; /* @silent-fallback-ok: an unaccepted notice doesn't count; the wait lengthens */ }
    svc.push?.notifyHere({ kind: 'notice', subject: 'approver-recovery', dedupeKey: `approver-recovery:${h.recoveryId}:${due}` });
    // Accepted only when Telegram gave a message id (never a held send).
    if (typeof id === 'number' && id > 0) {
      const g = readRecovery(stateDir);
      if (g.home?.recoveryId === h.recoveryId) {
        const notices = [...g.home.notices] as HomeRecovery['notices'];
        notices[due] = now();
        writeRecovery(stateDir, { ...g, home: { ...g.home, notices } });
      }
    }
  }
  const g = readRecovery(stateDir);
  if (g.home && g.home.state === 'waiting' && isReady(g.home, now())) {
    writeRecovery(stateDir, { ...g, home: { ...g.home, state: 'ready', readyAt: now() } });
    ownerOnce(svc, `ready:${h.recoveryId}`, `The wait is over. Open Instar on ${h.targetName} and tap Finish. Never type the code into a Windows PC.`);
  }
}

// ── Routes ──────────────────────────────────────────────────────────────────

function deviceOf(req: Request): string | null {
  const p = (req as unknown as { instarPrincipal?: { kind: string; deviceId?: string } }).instarPrincipal;
  return p && p.kind === 'device' && typeof p.deviceId === 'string' ? p.deviceId : null;
}

export function stopMessage(agentId: string, recoveryId: string): string { return `instar-approver-recovery-stop-v1\n${agentId}\n${recoveryId}`; }

export function mountApproverRecoveryRoutes(router: Router, svc: MobilePairingService): void {
  const stateDir = svc.deps.stateDir;

  router.post('/mobile/approver/recovery/stop', (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const deviceId = deviceOf(req);
    if (!svc.enabled() || !deviceId || !activeOwnerPhone(svc, deviceId)) { res.status(403).json({ error: 'owner-device-required' }); return; }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const recoveryId = String(body.recoveryId ?? '');
    const env = approverClaimEnv();
    if (!env) { res.status(503).json({ error: 'owner-record-off' }); return; }
    const f = readRecovery(stateDir);
    const h = f.home?.recoveryId === recoveryId ? f.home : null;
    const peerRec = Object.values(f.peers).map((p) => p.facts.recovery).find((r) => r?.recoveryId === recoveryId);
    if (!h && !peerRec) { res.status(404).json({ error: 'no-recovery' }); return; }
    const startedAt = h?.startedAt ?? peerRec!.startedAt;
    // A signed Stop: by a counted owner key (frozen at the start and carried in the facts, not retired). The lock needs
    // this machine to have first seen that key at least 24 h before the start (review M2).
    const counted = h?.countedKeys ?? peerRec?.countedKeys ?? [];
    const retired = new Set(retiredKeyHashes(stateDir));
    const sig = body.presenceSig;
    const message = stopMessage(env.agentId, recoveryId);
    const signer = counted.find((k) => !retired.has(keyHashOf(k.publicKey)) && proveCandidatePresenceKey(k.publicKey, message, sig));
    // Otherwise an approving device's presence signature over the same text is a sign of life (no lock).
    const lifeSign = !signer && verifyApproverPresence(svc, deviceId, message, sig) === 'ok';
    if (!signer && !lifeSign) { res.status(403).json({ error: 'not-allowed', detail: 'Only a device that can approve can stop a recovery.' }); return; }
    const seenAt = readRecovery(stateDir).keyFirstSeen?.[signer?.keyId ?? ''] ?? null;
    const oldEnough = !!signer && seenAt !== null && startedAt - seenAt >= STOP_KEY_MIN_AGE_MS;
    // Read settled BEFORE recording the stop, so the answer can say it already finished (review L1).
    const me = selfId();
    const settled = h?.state === 'finished' && h.entryId && me ? isSettled(stateDir, recoveryId, me, h.entryId, registeredNow()) : false;
    if (settled) { res.json({ stopped: false, detail: `This already finished. Remove ${h!.targetName} under Devices that can approve.` }); return; }
    // Not settled here, but every other machine may already have settled it: say so rather than promise a stop (review R3-M1).
    const mayHaveFinished = h?.state === 'finished';
    recordStop(stateDir, { recoveryId, at: now(), by: deviceId, kind: signer ? 'signed' : 'approval', lock: oldEnough });
    res.json({ stopped: true, locked: oldEnough, ...(mayHaveFinished ? { detail: `Stop recorded. This may already have finished on your other computers: if ${h!.targetName} can approve, remove it under Devices that can approve.` } : {}) });
  });

  router.post('/mobile/approver/recovery/seen', (req: Request, res: Response) => {
    const deviceId = deviceOf(req);
    const f = readRecovery(stateDir);
    const h = f.home;
    const d = deviceId ? svc.devices.get(deviceId) : null;
    if (!h || !deviceId || !d || deviceId === h.targetDeviceId || !activeOwnerPhone(svc, deviceId) || !d.approvedAt || Date.parse(d.approvedAt) >= h.startedAt) { res.status(403).json({ error: 'not-allowed' }); return; }
    // The device says which recovery it saw; a stale or other recovery records nothing.
    if (String(((req.body ?? {}) as Record<string, unknown>).recoveryId ?? '') !== h.recoveryId) { res.status(409).json({ error: 'recovery-changed', detail: 'That recovery has ended or another one started. Refresh.' }); return; }
    if (!(h.seenBy ?? []).some((s) => s.deviceId === deviceId)) writeRecovery(stateDir, { ...f, home: { ...h, seenBy: [...(h.seenBy ?? []), { deviceId, at: now() }] } });
    res.json({ ok: true });
  });

  const homeFor = (req: Request, res: Response): HomeRecovery | null => {
    res.setHeader('Cache-Control', 'no-store');
    const deviceId = deviceOf(req);
    if (!deviceId) { res.status(403).json({ error: 'device-signature-required' }); return null; }
    const h = readRecovery(stateDir).home;
    if (!h || deviceId !== h.targetDeviceId) { res.status(404).json({ error: 'no-recovery' }); return null; }
    if (!approverClaimEnv()?.leaseHere()) { res.status(409).json({ error: 'not-lease-holder', detail: 'Finish on the computer that is answering your chat.' }); return null; }
    return h;
  };

  router.post('/mobile/approver/recovery/finish', async (req: Request, res: Response) => {
    const h = homeFor(req, res);
    if (!h) return;
    if (h.state !== 'ready') { res.status(409).json({ error: 'not-ready', detail: 'The wait isn\'t over yet.' }); return; }
    const code = finishCodes.issue(h.recoveryId, now() + FINISH_CODE_MS, 'word');
    finishTries = 0;
    let id: number | null = null;
    try { id = await chat(svc, `Finish code for ${h.targetName}: ${displayCode(code)}. Type it only on ${h.targetName}. Never type it into a Windows PC.`); } catch { id = null; /* @silent-fallback-ok: answered 503 below */ }
    if (!(typeof id === 'number' && id > 0)) { finishCodes.drop(h.recoveryId); res.status(503).json({ error: 'owner-notice-unavailable', detail: 'The code could not be sent to your private chat. Try again.' }); return; }
    res.json({ ok: true });
  });

  router.post('/mobile/approver/recovery/finish/confirm', (req: Request, res: Response) => {
    const h = homeFor(req, res);
    if (!h) return;
    if (h.state !== 'ready') { res.status(409).json({ error: 'not-ready', detail: 'This recovery isn\'t ready to finish.' }); return; }
    const c = finishCodes.check(h.recoveryId, ((req.body ?? {}) as Record<string, unknown>).code);
    if (c.result !== 'ok') {
      finishTries++;
      if (finishTries >= FINISH_TRIES || c.result === 'none') { finishCodes.drop(h.recoveryId); res.status(410).json({ error: 'code-expired', detail: 'Ask for a new code.' }); return; }
      res.status(422).json({ error: 'wrong-code', triesLeft: FINISH_TRIES - finishTries });
      return;
    }
    const env = approverClaimEnv()!;
    const me = selfId();
    const signer = env.store.selfSigner();
    if (!me || !signer) { res.status(409).json({ error: 'record-not-ready' }); return; }
    const read = finishRead(stateDir, { recoveryId: h.recoveryId, startedAt: h.startedAt, candidateDeviceId: h.targetDeviceId, machines: h.machinesAtStart, selfMachineId: me, now: now(), selfLastPresence: readApproverState(stateDir).lastPresence ?? null, registered: registeredNow() });
    if (read.stopped) { recordStop(stateDir, { recoveryId: h.recoveryId, at: now(), by: me, kind: 'approval', lock: false }); res.json({ eligible: false, reason: 'stopped', detail: `Stopped: ${read.stopped}.` }); return; }
    if (read.stale.length) { res.status(409).json({ error: 'machine-unreachable', detail: `Waiting for ${read.stale.join(', ')} to check in. Try again in a few minutes.`, machines: read.stale }); return; }
    // The device and key were frozen at Start (the request itself was consumed then). The device must still be an
    // active owner device that isn't a browser, and its key not retired.
    const td = svc.devices.get(h.targetDeviceId);
    if (!td || td.client === 'browser' || !activeOwnerPhone(svc, h.targetDeviceId) || retiredKeyHashes(stateDir).includes(h.keyHash)) { res.json({ eligible: false, reason: 'device-gone', detail: 'The new device was removed or changed. Start again.' }); return; }
    const st = env.store.state();
    if (!st || st.head.length !== 1) { res.status(409).json({ error: 'record-not-ready', detail: 'The ownership record has two branches right now. Try again in a few minutes.' }); return; }
    finishCodes.drop(h.recoveryId);
    const parentId = st.head[0]!;
    const keyId = ownerKeyIdFor(h.presenceKey);
    const startedAt = new Date(h.startedAt).toISOString();
    const finishedAt = new Date(Math.max(now(), h.startedAt + RECOVERY_WAIT_MS)).toISOString();
    const proofSig = signer.sign(recoveryProofMessage({ agentId: env.agentId, parentId, recoveryId: h.recoveryId, deviceId: h.targetDeviceId, ownerKeyId: keyId, presenceKey: h.presenceKey, startedAt, finishedAt }));
    const entry: Omit<OwnerRecordEntry, 'sig'> = {
      v: 1, kind: 'add-owner-key', agentId: env.agentId, parents: [parentId],
      body: { keyId, publicKey: h.presenceKey, keyType: 'p256', deviceId: h.targetDeviceId, label: h.targetName.slice(0, 80), via: 'recovered',
        recovery: { recoveryId: h.recoveryId, startedAt, readyAt: new Date(h.readyAt ?? now()).toISOString(), finishedAt, stopCheck: 'clear', proof: { by: me, sig: proofSig } } },
      signer: { type: 'owner-key', keyId },
    };
    const id = ownerRecordEntryId(entry as OwnerRecordEntry);
    finishDraft = { recoveryId: h.recoveryId, entry, id, finishedAt };
    res.json({ entry, entryId: id, sign: recordEntryPresenceMessage(env.agentId, id) });
  });

  router.post('/mobile/approver/recovery/finish/sign', (req: Request, res: Response) => {
    const h = homeFor(req, res);
    if (!h) return;
    const d = finishDraft;
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!d || d.recoveryId !== h.recoveryId || h.state !== 'ready') { res.status(409).json({ error: 'no-draft' }); return; }
    const shown = body.entry as OwnerRecordEntry | undefined;
    if (!shown || typeof shown !== 'object' || ownerRecordEntryId({ ...shown, sig: '' } as OwnerRecordEntry) !== d.id) { res.status(400).json({ error: 'entry-changed' }); return; }
    const env = approverClaimEnv()!;
    const full = { ...d.entry, sig: String(body.sig ?? '') } as OwnerRecordEntry;
    if (!verifyEntrySignature(full, env.agentId, h.presenceKey, 'p256')) { res.status(409).json({ error: 'presence-invalid', detail: 'That approval signature did not match the new device\'s approval key. Nothing was changed.' }); return; } // 409, not 401: 401 means the device's own request signature was refused
    // E2E-PAIRING: EXEMPT — a status change and a body check on existing routes, pinned by the 3d recovery-flow unit tests; the end-to-end run needs an owner chat and is driven on a throwaway with the stand-in owner chat (identity card wc_491e135547ea8388).
    const me = selfId()!;
    // The second read. A stop found now leaves nothing in any record: the draft is discarded.
    const read = finishRead(stateDir, { recoveryId: h.recoveryId, startedAt: h.startedAt, candidateDeviceId: h.targetDeviceId, machines: h.machinesAtStart, selfMachineId: me, now: now(), selfLastPresence: readApproverState(stateDir).lastPresence ?? null, registered: registeredNow() });
    finishDraft = null;
    if (read.stopped) { recordStop(stateDir, { recoveryId: h.recoveryId, at: now(), by: me, kind: 'approval', lock: false }); res.json({ eligible: false, reason: 'stopped', detail: `Stopped: ${read.stopped}.` }); return; }
    if (read.stale.length) { res.status(409).json({ error: 'machine-unreachable', detail: `Waiting for ${read.stale.join(', ')} to check in. Ask for a new code after that.` }); return; }
    const r = env.store.ingest([full]);
    if (!r.added.includes(d.id)) { res.status(409).json({ error: 'record-refused', detail: 'The ownership record did not accept the entry.' }); return; }
    const f = readRecovery(stateDir);
    writeRecovery(stateDir, { ...f, home: { ...h, state: 'finished', finishedAt: Date.parse(d.finishedAt), entryId: d.id } });
    svc.devices.setPresenceKey(h.targetDeviceId, h.presenceKey);
    env.push([d.id]);
    res.json({ ok: true, detail: `${h.targetName} will be able to approve once every computer has accepted it, usually within 15 minutes.` });
  });
}

/**
 * A recovery started on another computer, in the same app-facing shape as one started here. The device id differs
 * per machine, so "is this me" is answered by the frozen key hash against the keys this device holds or has asked
 * with here. Internal fields (counted keys, Stop nonce hashes, machines) are not passed to phones.
 */
function peerRecoveryFor(svc: MobilePairingService, deviceId: string, x: NonNullable<ApproverRecoveryFacts['recovery']> | null): Record<string, unknown> | null {
  if (!x) return null;
  const mine = [...heldPresenceKeys(svc).filter((k) => k.deviceId === deviceId).map((k) => k.key), ...waitingRequestKeysFor(deviceId)].map((k) => keyHashOf(k));
  return { recoveryId: x.recoveryId, startedAt: x.startedAt, state: x.state, targetName: x.targetName, targetIsYou: mine.includes(x.keyHash), endsBy: x.startedAt + RECOVERY_WAIT_MS, elsewhere: true };
}

/** What the apps show (merged into GET /mobile/approvers). */
export function recoveryStatusFor(svc: MobilePairingService, deviceId: string): Record<string, unknown> | null {
  const f = readRecovery(svc.deps.stateDir);
  const h = f.home;
  const r = h && (h.state === 'waiting' || h.state === 'ready' || h.state === 'finished') ? { recoveryId: h.recoveryId, startedAt: h.startedAt, state: h.state, targetName: h.targetName, targetIsYou: h.targetDeviceId === deviceId, seen: (h.seenBy ?? []).length > 0, endsBy: h.startedAt + RECOVERY_WAIT_MS }
    : peerRecoveryFor(svc, deviceId, Object.values(f.peers).map((p) => p.facts.recovery).find((x) => x && (x.state === 'waiting' || x.state === 'ready')) ?? null);
  return r ? (r as Record<string, unknown>) : null;
}
