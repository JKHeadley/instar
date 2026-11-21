/**
 * Who may approve (identity-security piece 3a §5, §7): the one reader every presence-gated route calls.
 *
 * A device may approve when the signed owner record holds its presence key as a valid owner key, or when it is a
 * kept approver (mobile-approver-mark §3.6: it held a presence key before this release, under the cutoff rules).
 * The record's gate must not be holding. Nothing else reads `presenceKey` to decide anything (the ratchet test).
 *
 * Spec: docs/specs/identity-security-piece3a-approver-in-owner-record.md
 */
import fs from 'node:fs';
import path from 'node:path';
import { keyHashOf } from '../core/MobileDeviceKeys.js';
import { ownerKeyIdFor } from '../core/ownerApprover.js';
import { approverClaimEnv, ownerRecordGate, ownerRecordRouteDeps } from '../core/ownerRecordWiring.js';
import { activeOwnerPhone, verifyPresenceSignature } from './mobileConsoleTicket.js';
import type { MobilePairingService } from './mobilePairingRoutes.js';

interface KeptRow { deviceId: string; presenceKeyHash: string }
export interface ApproverState {
  migration?: { at: string; pending?: true; cutoff: string; cutoffConfirmed: boolean; kept: KeptRow[]; legacy?: string[] };
  lastPresence?: { at: number; deviceId: string };
  /** §3.3: first-approver claim starts on this machine (the last 24 hours), so a restart doesn't reset the limit. */
  claimStarts?: number[];
  /** §6: hashes of approval keys whose device the owner removed. A retired key never approves again, here or (once
   *  heard) on any other machine, even though the record still lists it until an approver signs its revoke-key. */
  retired?: string[];
}

const STATE_FILE = 'mobile-approver-state.json';
const RETIRED_PER_REPLY = 20;
const RETIRED_TOTAL_CAP = 10_000;
function retiredIn(stateDir: string, presenceKey: string): boolean {
  return (readApproverState(stateDir).retired ?? []).includes(keyHashOf(presenceKey));
}
const stateCache = new Map<string, ApproverState>();

function statePath(stateDir: string): string { return path.join(stateDir, 'state', STATE_FILE); }

export function readApproverState(stateDir: string): ApproverState {
  const hit = stateCache.get(stateDir);
  if (hit) return hit;
  let s: ApproverState = {};
  try { s = JSON.parse(fs.readFileSync(statePath(stateDir), 'utf8')) as ApproverState; } catch { s = {}; /* @silent-fallback-ok: no state yet; the migration has not run, so no device is kept */ }
  stateCache.set(stateDir, s);
  return s;
}

function writeApproverState(stateDir: string, s: ApproverState): void {
  const file = statePath(stateDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  stateCache.set(stateDir, s);
}

/** Tests: forget cached state. */
export function resetApproverStateCacheForTests(): void { stateCache.clear(); }

/** Is this device's presence key a valid owner key in the signed record? Matched by public key (§1). */
let recoveredKeyOk: ((keyId: string) => boolean) | null = null;
/** Piece 3d: the recovery module tells the one reader whether a recovered owner key has settled. */
export function setRecoveredKeyCheck(fn: ((keyId: string) => boolean) | null): void { recoveredKeyOk = fn; }

function inRecord(stateDir: string, presenceKey: string): boolean {
  if (retiredIn(stateDir, presenceKey)) return false;
  // Piece 3d §2: a recovered key approves nothing until every machine has accepted it.
  if (recoveredKeyOk && !recoveredKeyOk(ownerKeyIdFor(presenceKey))) return false;
  const st = ownerRecordRouteDeps()?.store.state();
  if (!st || st.status !== 'ok') return false;
  const id = ownerKeyIdFor(presenceKey);
  return st.keys.some((k) => k.type === 'owner-key' && k.keyId === id && k.publicKey === presenceKey);
}

/** A kept approver under mobile-approver-mark §3.6, on this machine. */
export function isKeptApprover(svc: MobilePairingService, deviceId: string, presenceKey: string): boolean {
  const m = readApproverState(svc.deps.stateDir).migration;
  if (!m || m.pending || retiredIn(svc.deps.stateDir, presenceKey)) return false;
  return m.kept.some((k) => k.deviceId === deviceId && k.presenceKeyHash === keyHashOf(presenceKey));
}

/**
 * §7: the device's presence key when it may approve now, else null. The record's gate must not hold; the device is
 * an active owner phone; and its key is in the record, or it is a kept approver.
 */
export function approverPresenceKey(svc: MobilePairingService, deviceId: string): string | null {
  if (!activeOwnerPhone(svc, deviceId)) return null;
  if (!readApproverState(svc.deps.stateDir).migration) ensureApproverMigration(svc); // pairing was off at the upgrade boot
  const key = svc.devices.get(deviceId)?.presenceKey;
  if (!key) return null;
  const gate = ownerRecordGate();
  if (gate && gate.act === 'hold') return null;
  if (inRecord(svc.deps.stateDir, key)) return key;
  return isKeptApprover(svc, deviceId, key) ? key : null;
}

export function mayApprove(svc: MobilePairingService, deviceId: string): boolean {
  return approverPresenceKey(svc, deviceId) !== null;
}

/**
 * §7: check a presence signature from an approving device, and record it before the action answers. A failure to
 * record refuses the action (the caller answers 503): an approval that left no record could not stop a recovery.
 */
export function verifyApproverPresence(svc: MobilePairingService, deviceId: string, message: string, sig: unknown): 'ok' | 'not-approver' | 'bad-signature' | 'unrecorded' {
  const key = approverPresenceKey(svc, deviceId);
  if (!key) return 'not-approver';
  if (!verifyPresenceSignature(key, message, sig)) return 'bad-signature';
  try {
    const s = { ...readApproverState(svc.deps.stateDir), lastPresence: { at: Date.now(), deviceId } };
    writeApproverState(svc.deps.stateDir, s);
  } catch {
    return 'unrecorded'; // @silent-fallback-ok: the caller refuses the action with 503; nothing it would do happens
  }
  return 'ok';
}

/** The refusal every presence-gated route gives a device that can't approve. */
export const APPROVER_REQUIRED = { error: 'approver-required', detail: 'This device cannot approve changes. Approve on a device that can.' } as const;

/**
 * mobile-approver-mark §3.6 on this machine: keep the right for every active owner phone that already held a presence
 * key before this release, unless the console-ticket audit shows its key was set at or after the cutoff. Runs once;
 * a rollback and second upgrade never run it again (the marker lives in this file, which older builds never touch).
 */
export function migrateApprovers(svc: MobilePairingService, input: { now: number; earliestPeerMigration: string | null; allPeersAnswered: boolean; singleMachine: boolean }): { kept: string[]; ran: boolean } {
  const stateDir = svc.deps.stateDir;
  const s = readApproverState(stateDir);
  if (s.migration && !s.migration.pending) return { kept: s.migration.kept.map((k) => k.deviceId), ran: false };
  // While mobile pairing is off no device is an active owner phone, so the pass would keep nothing: wait for it.
  if (!svc.enabled()) return { kept: [], ran: false };
  const nowIso = new Date(input.now).toISOString();
  const cutoff = s.migration?.cutoff ?? (input.earliestPeerMigration && input.earliestPeerMigration < nowIso ? input.earliestPeerMigration : nowIso);
  const cutoffConfirmed = s.migration?.cutoffConfirmed ?? (input.singleMachine || input.allPeersAnswered);
  writeApproverState(stateDir, { ...s, migration: { at: s.migration?.at ?? nowIso, pending: true, cutoff, cutoffConfirmed, kept: [] } });
  const setAfterCutoff = new Set<string>();
  try {
    const audit = fs.readFileSync(path.join(stateDir, 'state', 'mobile-console-tickets.jsonl'), 'utf8');
    for (const line of audit.split('\n')) {
      if (!line.trim()) continue;
      try { const r = JSON.parse(line) as { event?: string; deviceId?: string; at?: string }; if (r.event === 'presence-key-set' && r.deviceId && r.at && r.at >= cutoff) setAfterCutoff.add(r.deviceId); } catch { /* @silent-fallback-ok: a damaged audit line is skipped; it can only keep fewer devices */ }
    }
  } catch { /* @silent-fallback-ok: no audit file means no presence key was set through the route on this machine */ }
  const kept: KeptRow[] = [];
  const legacy: string[] = [];
  for (const d of svc.devices.list()) {
    if (!activeOwnerPhone(svc, d.id) || !d.approvedAt || d.approvedAt >= cutoff) continue;
    // §3.6: every active owner device approved before the cutoff is vouched for (legacyPersonActs), so a computer
    // with no Touch ID never blocks the first claim.
    legacy.push(d.id);
    if (!d.presenceKey || setAfterCutoff.has(d.id)) continue;
    kept.push({ deviceId: d.id, presenceKeyHash: keyHashOf(d.presenceKey) });
  }
  writeApproverState(stateDir, { ...readApproverState(stateDir), migration: { at: s.migration?.at ?? nowIso, cutoff, cutoffConfirmed, kept, legacy } });
  return { kept: kept.map((k) => k.deviceId), ran: true };
}

/** §3.6: kept approvers can approve, but while the cutoff is unconfirmed they can't give the right or remove one. */
export function keptCutoffConfirmed(stateDir: string): boolean {
  return readApproverState(stateDir).migration?.cutoffConfirmed ?? false;
}

/**
 * Tests only (mobile-approver-mark §3.2: `markApproverForTest`): give a device a presence key and keep it as an
 * approver on this machine, standing in for a device that held the right before this release.
 */
export function markApproverForTest(svc: MobilePairingService, deviceId: string, presenceKey: string): 'set' | 'same' | 'conflict' | 'not-active' {
  const r = svc.devices.setPresenceKey(deviceId, presenceKey);
  if (r !== 'set' && r !== 'same') return r;
  const s = readApproverState(svc.deps.stateDir);
  const m = s.migration && !s.migration.pending ? s.migration : { at: new Date().toISOString(), cutoff: new Date().toISOString(), cutoffConfirmed: true, kept: [] as KeptRow[] };
  const kept = m.kept.filter((k) => k.deviceId !== deviceId).concat({ deviceId, presenceKeyHash: keyHashOf(presenceKey) });
  writeApproverState(svc.deps.stateDir, { ...s, migration: { ...m, kept, cutoffConfirmed: true } });
  return r;
}

export type ApproverSigOutcome = 'ok' | 'not-approver' | 'bad-signature' | 'unrecorded';

/** How a route answers a failed approver signature: the route's own bad-signature code, else a fixed refusal. */
export function approverSigRefusal(v: Exclude<ApproverSigOutcome, 'ok'>, badSignatureError: string): { status: number; body: { error: string; detail?: string } } {
  if (v === 'bad-signature') return { status: 401, body: { error: badSignatureError } };
  if (v === 'unrecorded') return { status: 503, body: { error: 'approval-unrecorded', detail: 'This approval could not be recorded, so nothing was done. Try again.' } };
  return { status: 403, body: { ...APPROVER_REQUIRED } };
}

/**
 * §3.2: proof that a device holds a CANDIDATE presence key (enrolment, or the local override installing a new key).
 * This proves possession only; it grants nothing and says nothing about who may approve.
 */
export function proveCandidatePresenceKey(candidateKey: string, message: string, proof: unknown): boolean {
  return verifyPresenceSignature(candidateKey, message, proof);
}

/** §7 (mobile-approver-mark §3.2): every presence key a device record on this machine still holds, for the "distinct key" rule. */
export function heldPresenceKeys(svc: MobilePairingService): Array<{ deviceId: string; key: string }> {
  // A revoked record holds nothing: its device can't use the key again.
  return svc.devices.list().filter((d) => typeof d.presenceKey === 'string' && d.status !== 'revoked').map((d) => ({ deviceId: d.id, key: d.presenceKey as string }));
}

/** §4: a device whose key is an owner key in the record (not merely kept): only these sign record entries. */
export function ownerKeyApproverKey(svc: MobilePairingService, deviceId: string): string | null {
  const key = approverPresenceKey(svc, deviceId);
  return key && inRecord(svc.deps.stateDir, key) ? key : null;
}

/**
 * mobile-approver-mark §3.6 across machines: when another machine ran the migration earlier, the cutoff moves back
 * to that time and devices whose key was set at or after it are dropped from the kept list. It only ever shrinks
 * the list. When every machine has answered, the cutoff is confirmed.
 */
export function tightenApproverCutoff(svc: MobilePairingService, earliestPeer: string | null, allAnswered: boolean): { dropped: string[] } {
  const stateDir = svc.deps.stateDir;
  const s = readApproverState(stateDir);
  const m = s.migration;
  if (!m || m.pending || m.cutoffConfirmed) return { dropped: [] };
  const cutoff = earliestPeer && earliestPeer < m.cutoff ? earliestPeer : m.cutoff;
  const setAfter = new Set<string>();
  try {
    for (const line of fs.readFileSync(path.join(stateDir, 'state', 'mobile-console-tickets.jsonl'), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { const r = JSON.parse(line) as { event?: string; deviceId?: string; at?: string }; if (r.event === 'presence-key-set' && r.deviceId && r.at && r.at >= cutoff) setAfter.add(r.deviceId); } catch { /* @silent-fallback-ok: a damaged audit line is skipped */ }
    }
  } catch { /* @silent-fallback-ok: no audit file means no key was set through the route here */ }
  const kept = m.kept.filter((k) => { const d = svc.devices.get(k.deviceId); return !!d && !!d.approvedAt && d.approvedAt < cutoff && !setAfter.has(k.deviceId); });
  const legacy = (m.legacy ?? []).filter((id) => { const d = svc.devices.get(id); return !!d && !!d.approvedAt && d.approvedAt < cutoff; });
  const dropped = m.kept.filter((k) => !kept.includes(k)).map((k) => k.deviceId);
  if (dropped.length === 0 && cutoff === m.cutoff && !allAnswered && legacy.length === (m.legacy ?? []).length) return { dropped };
  writeApproverState(stateDir, { ...s, migration: { ...m, cutoff, kept, legacy, cutoffConfirmed: allAnswered } });
  return { dropped };
}

/** §3.6: a device vouched for by the migration (approved before the cutoff), with or without an approval key. */
export function isLegacyDevice(svc: MobilePairingService, deviceId: string): boolean {
  const m = readApproverState(svc.deps.stateDir).migration;
  return !!m && !m.pending && (m.legacy ?? []).includes(deviceId);
}

/**
 * §7 on another machine: a key that is already a valid owner key in the record may be registered by the device that
 * holds it (proven by the caller), as long as no other device on this machine holds it. This is how an approver's
 * phone, paired with a second machine under another device id, approves there too.
 */
export function isRecordOwnerKeyFree(svc: MobilePairingService, deviceId: string, key: string): boolean {
  return inRecord(svc.deps.stateDir, key) && !heldPresenceKeys(svc).some((h) => h.deviceId !== deviceId && h.key === key);
}

/**
 * §6: how many owner keys in the record are still live. A key held by a device on this machine counts only while
 * that device is active; a key held by no device here belongs to another machine and counts (we can't see it die).
 */
export function liveOwnerKeys(svc: MobilePairingService): Array<{ keyId: string; publicKey: string }> {
  const st = ownerRecordRouteDeps()?.store.state();
  if (!st || st.status !== 'ok') return [];
  const devices = svc.devices.list();
  return st.keys.filter((k) => k.type === 'owner-key' && !retiredIn(svc.deps.stateDir, k.publicKey)).filter((k) => {
    const holders = devices.filter((d) => d.presenceKey === k.publicKey);
    return holders.length === 0 || holders.some((d) => activeOwnerPhone(svc, d.id));
  }).map((k) => ({ keyId: k.keyId, publicKey: k.publicKey }));
}

/** §3.3: claim starts in the last 24 hours on this machine. */
export function claimStartsToday(stateDir: string, now = Date.now()): number[] {
  return (readApproverState(stateDir).claimStarts ?? []).filter((t) => now - t < 24 * 60 * 60 * 1000);
}
/** Record a claim start (before the code is sent). */
export function recordClaimStart(stateDir: string, now = Date.now()): void {
  writeApproverState(stateDir, { ...readApproverState(stateDir), claimStarts: [...claimStartsToday(stateDir, now), now] });
}

/** Run the §3.6 migration if it hasn't run here (at boot, or the first time pairing is on afterwards). */
let keptNotice: ((svc: MobilePairingService, kept: string[]) => void) | null = null;
/** The server's owner notice listing kept devices (§3.6), sent whenever the migration runs: at boot or later. */
export function setKeptDevicesNotice(fn: ((svc: MobilePairingService, kept: string[]) => void) | null): void { keptNotice = fn; }

export function ensureApproverMigration(svc: MobilePairingService, now = Date.now()): { kept: string[]; ran: boolean } {
  let peers = 0;
  try { peers = approverClaimEnv()?.peers().length ?? 0; } catch { peers = 1; /* @silent-fallback-ok: unknown peers count as present, so the cutoff stays unconfirmed (it can only shrink later) */ }
  const r = migrateApprovers(svc, { now, earliestPeerMigration: null, allPeersAnswered: false, singleMachine: peers === 0 });
  if (r.ran && r.kept.length > 0) { try { keptNotice?.(svc, r.kept); } catch { /* @silent-fallback-ok: the devices page lists who can approve */ } }
  return r;
}

/** §6: the owner removed the device holding this key: it never approves again. */
export function retireApprovalKey(stateDir: string, presenceKey: string): void {
  const s = readApproverState(stateDir);
  const h = keyHashOf(presenceKey);
  if ((s.retired ?? []).includes(h)) return;
  writeApproverState(stateDir, { ...s, retired: [...(s.retired ?? []), h] }); // never evicted: this list denies
}
/** Retired key hashes another machine reported: merged in, never removed. */
export function mergeRetiredKeys(stateDir: string, hashes: string[]): number {
  const s = readApproverState(stateDir);
  const have = new Set(s.retired ?? []);
  // Taken in a few at a time per reply and never evicted (a flood could otherwise push a real retirement out); past
  // the total cap more are refused, which can only leave a device approving that another machine retired (reported).
  const fresh = hashes.filter((h) => typeof h === 'string' && /^[0-9a-f]{64}$/.test(h) && !have.has(h)).slice(0, RETIRED_PER_REPLY);
  if (fresh.length === 0) return 0;
  const room = Math.max(0, RETIRED_TOTAL_CAP - (s.retired ?? []).length);
  if (room === 0) throw new Error('retired-key list full');
  writeApproverState(stateDir, { ...s, retired: [...(s.retired ?? []), ...fresh.slice(0, room)] });
  return fresh.length;
}
export function retiredKeyHashes(stateDir: string): string[] { return readApproverState(stateDir).retired ?? []; }
