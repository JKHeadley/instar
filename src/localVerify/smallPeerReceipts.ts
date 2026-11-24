/** Attempt-bound diagnostic receipts. A receipt can never stand in for a verifier verdict. */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';
import { canonicalJson } from '../core/appMediaTypes.js';
import { verifyMachineSignature, type MachineKeyLookup, type MachineSignature, type MachineSigner } from '../core/AppRecordSignatures.js';
import { requestDigest } from './peerResultSignature.js';
import type { PeerRunRequest } from './peer.js';
import type { TrialReceipt } from './smallPeerWatchdog.js';

export interface TrialBinding {
  attemptId: string; requestDigest: string; coordinator: string; peer: string; pr: number; head: string; base: string;
}
export interface TrialPacket { binding: TrialBinding; receipt: TrialReceipt; sig: MachineSignature }
export interface TrialAck { attemptId: string; packetDigest: string; sig: MachineSignature }

const ID = /^[a-f0-9]{32}$/;
const SHA = /^[a-f0-9]{64}$/;
const packetPayload = (b: TrialBinding, r: TrialReceipt) => 'instar-small-peer-receipt-v1\n' + requestDigest({ binding:b, receipt:r });
const ackPayload = (id: string, digest: string) => 'instar-small-peer-ack-v1\n' + id + '\n' + digest;

export function validTrialReceipt(v: unknown, attemptId: string): v is TrialReceipt {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const r = v as TrialReceipt;
  const count = (n: unknown) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
  if (!ID.test(attemptId) || r.attemptId !== attemptId || !['completed','capacity'].includes(r.outcome)
    || typeof r.reason !== 'string' || !r.reason || r.reason.length > 200 || r.cleanupProven !== true || typeof r.reserveBreached !== 'boolean'
    || (r.elapsedMs === null ? r.outcome !== 'capacity' : !Number.isFinite(r.elapsedMs) || r.elapsedMs < 0) || !count(r.samples)
    || (r.peakRssBytes !== null && !count(r.peakRssBytes)) || (r.minimumAvailableBytes !== null && !count(r.minimumAvailableBytes))) return false;
  return r.outcome === 'capacity' || (r.samples > 0 && r.peakRssBytes !== null && r.minimumAvailableBytes !== null && !r.reserveBreached);
}

function read<T>(file: string): T | null {
  try {
    if (fs.statSync(file).size > 32_768) throw new Error('oversize trial receipt record');
    return JSON.parse(fs.readFileSync(file,'utf8'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

/** Atomic create-once plus file and directory synchronization before returning an acknowledgement. */
function put(file: string, value: unknown): boolean {
  fs.mkdirSync(path.dirname(file), { recursive:true, mode:0o700 });
  const previous = read(file);
  if (previous !== null) {
    if (canonicalJson(previous) !== canonicalJson(value)) throw new Error('conflicting trial receipt record');
    return false;
  }
  const tmp = file + '.' + randomUUID() + '.tmp';
  const fd = fs.openSync(tmp,'wx',0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try {
    fs.linkSync(tmp,file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || canonicalJson(read(file)) !== canonicalJson(value)) throw e;
    return false;
  } finally {
    SafeFsExecutor.safeRmSync(tmp, {force:true,operation:'local-verify:trial-receipt-temp'});
  }
  const dir = fs.openSync(path.dirname(file),'r');
  try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  return true;
}

function directory(stateDir: string, id: string): string {
  if (!ID.test(id)) throw new Error('invalid trial attempt');
  return path.join(stateDir,'state','local-verify','small-peer-runs',id);
}

export function bindTrial(stateDir: string, req: PeerRunRequest, peer: string, dispatch = false): TrialBinding {
  const binding = {attemptId:req.attemptId,requestDigest:requestDigest(req),coordinator:req.coordinatorMachineId,peer,pr:req.pr,head:req.headSha,base:req.baseSha};
  put(path.join(directory(stateDir,req.attemptId),'binding.json'),binding);
  if (dispatch) put(path.join(stateDir,'state','local-verify','small-peer-pending',req.attemptId),binding);
  return binding;
}

export function pendingTrialBindings(stateDir: string): TrialBinding[] {
  const root = path.join(stateDir,'state','local-verify','small-peer-pending');
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).filter(id => ID.test(id)).flatMap(id => read<TrialBinding>(path.join(root,id)) ?? []);
}

export function finishDelivery(stateDir: string, id: string): void {
  if (!ID.test(id)) throw new Error('invalid trial attempt');
  const root = path.join(stateDir,'state','local-verify','small-peer-pending');
  SafeFsExecutor.safeRmSync(path.join(root,id),{force:true,operation:'local-verify:trial-receipt-confirmed'});
  syncPendingDir(root);
}

function syncPendingDir(dir: string): void {
  const fd = fs.openSync(dir,'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}


export function writeWatchdogReceipt(stateDir: string, receipt: TrialReceipt): void {
  put(path.join(directory(stateDir,receipt.attemptId),'watchdog-receipt.json'),receipt);
}

/** Called only after both the watchdog and the launchd execution scope are gone. */
export function finalizeTrialReceipt(stateDir: string, id: string, reason: string | null, elapsedMs: number | null,
  observed?: Pick<TrialReceipt, 'peakRssBytes' | 'minimumAvailableBytes' | 'samples' | 'reserveBreached'>): void {
  if (localTrialReceipt(stateDir,id)) return;
  const dir = directory(stateDir,id);
  const provisional = read<TrialReceipt>(path.join(dir,'watchdog-receipt.json'));
  const usable = validTrialReceipt(provisional,id) ? provisional : null;
  const final: TrialReceipt = !reason && usable ? usable : {
    attemptId:id, outcome:'capacity', reason:reason ?? 'watchdog-lost', cleanupProven:true,
    elapsedMs:elapsedMs ?? usable?.elapsedMs ?? null, samples:Math.max(usable?.samples ?? 0, observed?.samples ?? 0),
    peakRssBytes:usable?.peakRssBytes ?? observed?.peakRssBytes ?? null,
    minimumAvailableBytes:usable?.minimumAvailableBytes ?? observed?.minimumAvailableBytes ?? null,
    reserveBreached:!!(usable?.reserveBreached || observed?.reserveBreached),
  };
  if (final.outcome === 'capacity') {
    // Persist the admission fence before exposing a terminal receipt. A crash between
    // publishing the receipt and finishRun must still leave the peer fenced on boot.
    const root = path.dirname(path.dirname(dir));
    if (final.reserveBreached || !usable || final.minimumAvailableBytes === null
      || ['server-restarted','measurement-failed','setup-failed','cleanup-timeout','watchdog-lost','sample-expired'].includes(final.reason)) {
      writeRecoveryMarker(root,'small-peer-quarantined','recalibration required');
    }
    writeRecoveryMarker(root,'small-peer-recovering','waiting for sustained healthy samples');
  }
  put(path.join(dir,'receipt.json'),final);
}

function writeRecoveryMarker(root: string, name: string, message: string): void {
  const fd = fs.openSync(path.join(root,name),'w',0o600);
  try {
    fs.writeFileSync(fd,message);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  syncPendingDir(root);
}

export function finalizeInterruptedTrials(stateDir: string, machineId: string): void {
  const root = path.join(stateDir,'state','local-verify','small-peer-runs');
  if (!fs.existsSync(root)) return;
  for (const id of fs.readdirSync(root)) {
    if (ID.test(id) && trialBinding(stateDir,id)?.peer === machineId) {
      finalizeTrialReceipt(stateDir,id,'server-restarted',null);
    }
  }
}

export function localTrialReceipt(stateDir: string,id: string): TrialReceipt | null {
  const value = read(path.join(directory(stateDir,id),'receipt.json'));
  if (value !== null && !validTrialReceipt(value,id)) throw new Error('invalid watchdog receipt');
  return value as TrialReceipt | null;
}

export function trialBinding(stateDir: string,id: string): TrialBinding | null {
  return read(path.join(directory(stateDir,id),'binding.json'));
}

export function receivedTrial(stateDir: string,id: string): TrialPacket | null {
  return read(path.join(directory(stateDir,id),'imported.json'));
}

export function pendingTrialPackets(stateDir: string, coordinator: string, signer: MachineSigner, attemptIds: string[]): TrialPacket[] {
  if (attemptIds.length > 8 || attemptIds.some(id => !ID.test(id))) throw new Error('invalid trial receipt request');
  const packets: TrialPacket[] = [];
  for (const id of new Set(attemptIds)) {
    const dir = directory(stateDir, id);
    if (fs.existsSync(path.join(dir, 'acked.json'))) continue;
    const binding = trialBinding(stateDir, id);
    if (!binding || binding.peer !== signer.machineId() || binding.coordinator !== coordinator) continue;
    const receipt = localTrialReceipt(stateDir, id);
    if (!receipt) continue;
    packets.push({ binding, receipt, sig: signer.sign(packetPayload(binding, receipt)) });
  }
  return packets;
}

function signature(v: unknown): v is MachineSignature {
  const s = v as MachineSignature | null;
  return !!s && typeof s.machineId === 'string' && typeof s.signerKeyHash === 'string'
    && typeof s.sig === 'string' && s.sig.length <= 1024;
}

export function importTrialPacket(stateDir: string, packet: TrialPacket, peer: string, now: number,
  keys: MachineKeyLookup, signer: MachineSigner): {ack: TrialAck; fresh: boolean} {
  const id = packet?.binding?.attemptId;
  if (!id || !validTrialReceipt(packet.receipt,id) || !signature(packet.sig) || peer !== packet.sig.machineId) throw new Error('malformed trial packet');
  const binding = trialBinding(stateDir,id);
  if (!binding || binding.peer !== peer || binding.coordinator !== signer.machineId() || canonicalJson(binding) !== canonicalJson(packet.binding)
    || verifyMachineSignature(keys,packet.sig,packetPayload(binding,packet.receipt),now) !== 'ok') throw new Error('unverified trial packet');
  // Rotation or re-signing can change the signature on the same immutable receipt.
  const existing = receivedTrial(stateDir,id);
  const digest = requestDigest({binding, receipt:packet.receipt});
  if (existing && digest !== requestDigest({binding:existing.binding,receipt:existing.receipt})) throw new Error('conflicting trial packet');
  const fresh = existing === null && put(path.join(directory(stateDir,id),'imported.json'),packet);
  return {fresh, ack:{attemptId:id,packetDigest:digest,sig:signer.sign(ackPayload(id,digest))}};
}

export function acknowledgeTrial(stateDir: string, ack: TrialAck, now: number, keys: MachineKeyLookup): boolean {
  if (!ack || !ID.test(ack.attemptId) || !SHA.test(ack.packetDigest) || !signature(ack.sig)) return false;
  const binding = trialBinding(stateDir,ack.attemptId);
  const receipt = localTrialReceipt(stateDir,ack.attemptId);
  if (!binding || !receipt || binding.coordinator !== ack.sig.machineId || requestDigest({binding,receipt}) !== ack.packetDigest
    || verifyMachineSignature(keys,ack.sig,ackPayload(ack.attemptId,ack.packetDigest),now) !== 'ok') return false;
  put(path.join(directory(stateDir,ack.attemptId),'acked.json'),{digest:ack.packetDigest});
  return true;
}
