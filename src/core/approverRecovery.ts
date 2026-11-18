/**
 * Recovery when every approving device is lost (identity-security piece 3d) — the state and the decisions, with no
 * network or Telegram in it. The server module (src/server/mobileApproverRecovery.ts) drives it.
 *
 * Every machine keeps its own file (`state/approver-recovery.json`): its home recovery if it is one, the stops it
 * knows, when it FIRST saw each recovery and each notice in a peer's signed facts, each peer's latest facts, and its
 * own arrival decisions. The wait is measured on this machine's own clock from its own first sight, so a home that
 * claims an early start gains nothing anywhere else.
 * Spec: docs/specs/identity-security-piece3d-approver-recovery.md
 */
import fs from 'node:fs';
import path from 'node:path';

export const RECOVERY_WAIT_MS = 72 * 3600_000;
/** Umbrella §9: notices at the start, halfway and in the final hour, on the start's clock. */
export const NOTICE_AT_MS: readonly number[] = [0, 36 * 3600_000, 71 * 3600_000];
export const READY_AFTER_FINAL_MS = 3600_000;
export const FINISH_WINDOW_MS = 7 * 24 * 3600_000;
export const STOP_LOCK_MS = 7 * 24 * 3600_000;
export const STOP_KEY_MIN_AGE_MS = 24 * 3600_000;
export const PRESENCE_MARGIN_MS = 60_000;
const ENDED_STOP_KEEP_MS = 30 * 24 * 3600_000;
/** Spec §1 step 7: a machine's signed facts count at Finish only when at most one sync interval old. */
export const FACTS_FRESH_MS = 15 * 60_000;
const ENDED_STOPS_CAP = 100;

export type RecoveryState = 'waiting' | 'ready' | 'finished' | 'stopped' | 'ended';

export interface HomeRecovery {
  recoveryId: string;
  startedAt: number;
  targetDeviceId: string;
  targetName: string;
  requestId: string;
  presenceKey: string;
  keyHash: string;
  /** Owner keys valid at the start, less retired ones, with when each was added: who may sign a locking Stop. */
  countedKeys: Array<{ keyId: string; publicKey: string; addedAt: number | null }>;
  /** sha256 of each Stop-button nonce sent (the owner's tap is honoured on any lease holder). */
  stopNonceHashes?: string[];
  /** This machine's id when it started the recovery. */
  home?: string;
  /** Umbrella §4.5a: the lost keys named at the start (every owner key then), revoked only after settling plus a clean round. */
  lostKeys: Array<{ keyId: string; publicKey: string }>;
  /** When this machine first found the recovery settled, and whether the lost keys were retired. */
  settledAt?: number;
  lostRetired?: boolean;
  /** Machines registered at the start (this one included): the frozen set that must accept before it settles. */
  machinesAtStart: string[];
  /** When each of the three notices was accepted by the chat (a message id came back), else null. */
  notices: [number | null, number | null, number | null];
  state: RecoveryState;
  readyAt?: number;
  finishedAt?: number;
  entryId?: string;
  endedReason?: string;
  seenBy?: Array<{ deviceId: string; at: number }>;
}

export interface StopRow { recoveryId: string; at: number; by: string; kind: 'signed' | 'chat' | 'approval'; lock: boolean; endedAt?: number }

/** What this machine tells every peer, in its SIGNED pull request (spec §4). */
export interface ApproverRecoveryFacts {
  v: 1;
  now: number;
  recovery: null | { recoveryId: string; startedAt: number; state: RecoveryState; notices: Array<number | null>; targetName: string; machinesAtStart: string[]; finishedAt?: number;
    /** Frozen at the start: the one entry this recovery may add must carry this device and key. */
    targetDeviceId: string; keyHash: string; home: string;
    /** Counted owner keys for a signed Stop, so every machine can check one. */
    countedKeys: Array<{ keyId: string; publicKey: string }>;
    /** Hashes of the Stop-button nonces, so any lease holder can honour the owner's tap. */
    stopNonceHashes: string[] };
  stops: StopRow[];
  lastPresence: { at: number; deviceId: string } | null;
  acceptedRecoveries: Array<{ recoveryId: string; entryId: string }>;
}

export interface RecoveryFile {
  home?: HomeRecovery;
  stops: StopRow[];
  lockUntil?: number;
  /** recoveryId → when this machine first saw it, and when it first saw each accepted notice (its own clock). */
  firstSeen: Record<string, { at: number; notices: Array<number | null>; machinesAtStart?: string[]; startedAt?: number; home?: string; targetDeviceId?: string; keyHash?: string;
    /** This machine's OWN registry at first sight: the machines that must accept before it settles here (review R2-H1). */
    registeredAtSight?: string[] }>;
  /** recoveryId → when this machine first found it settled; later stops don't undo it (review R2-M2). */
  settledHere?: Record<string, number>;
  /** machineId → that machine's latest signed facts and when they arrived (this machine's clock). */
  peers: Record<string, { at: number; facts: ApproverRecoveryFacts }>;
  /** recoveryId → this machine's arrival decision, recorded once, with the exact entry it was about. */
  arrival: Record<string, 'accepted' | 'held' | 'retired'>;
  arrivalEntry?: Record<string, string>;
  /** owner-key id → when this machine first saw it in the record (for the 24-hour Stop rule; the record has no trusted time). */
  keyFirstSeen?: Record<string, number>;
  /** Owner messages already sent, by key (bounded), so a restart never repeats a milestone. */
  told?: string[];
}

/** Note owner keys this machine sees for the first time (each tick). */
export function noteOwnerKeys(stateDir: string, keyIds: string[], now: number): void {
  const f = readRecovery(stateDir);
  const seen = { ...(f.keyFirstSeen ?? {}) };
  let changed = false;
  for (const k of keyIds) if (seen[k] === undefined) { seen[k] = now; changed = true; }
  if (changed) writeRecovery(stateDir, { ...f, keyFirstSeen: seen });
}

const FILE = 'approver-recovery.json';
const cache = new Map<string, RecoveryFile>();
const fileOf = (stateDir: string): string => path.join(stateDir, 'state', FILE);

export function readRecovery(stateDir: string): RecoveryFile {
  const hit = cache.get(stateDir);
  if (hit) return hit;
  let f: RecoveryFile = { stops: [], firstSeen: {}, peers: {}, arrival: {} };
  try {
    const raw = JSON.parse(fs.readFileSync(fileOf(stateDir), 'utf8')) as Partial<RecoveryFile>;
    f = { stops: raw.stops ?? [], firstSeen: raw.firstSeen ?? {}, peers: raw.peers ?? {}, arrival: raw.arrival ?? {}, ...(raw.keyFirstSeen ? { keyFirstSeen: raw.keyFirstSeen } : {}), ...(raw.told ? { told: raw.told } : {}), ...(raw.settledHere ? { settledHere: raw.settledHere } : {}), ...(raw.home ? { home: raw.home } : {}), ...(raw.lockUntil ? { lockUntil: raw.lockUntil } : {}) };
  } catch (err) {
    // A missing file is a fresh machine. A damaged one must not read as "no stops": refuse to decide anything.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`approver recovery state unreadable: ${err instanceof Error ? err.message : String(err)}`);
  }
  cache.set(stateDir, f);
  return f;
}

export function writeRecovery(stateDir: string, f: RecoveryFile): void {
  const file = fileOf(stateDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(f, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  cache.set(stateDir, f);
}

export function resetRecoveryCacheForTests(): void { cache.clear(); }

/** Keep stops for unended recoveries forever; ended ones for 30 days, at most 100. */
function pruneStops(stops: StopRow[], now: number): StopRow[] {
  const open = stops.filter((s) => s.endedAt === undefined);
  const ended = stops.filter((s) => s.endedAt !== undefined && now - s.endedAt < ENDED_STOP_KEEP_MS).sort((a, b) => b.endedAt! - a.endedAt!).slice(0, ENDED_STOPS_CAP);
  return [...open, ...ended];
}

/** This machine's facts for its signed pull requests. */
export function recoveryFacts(stateDir: string, input: { now: number; lastPresence: { at: number; deviceId: string } | null }): ApproverRecoveryFacts {
  const f = readRecovery(stateDir);
  const h = f.home;
  return {
    v: 1, now: input.now,
    recovery: h ? { recoveryId: h.recoveryId, startedAt: h.startedAt, state: h.state, notices: [...h.notices], targetName: h.targetName, machinesAtStart: h.machinesAtStart, ...(h.finishedAt ? { finishedAt: h.finishedAt } : {}),
      targetDeviceId: h.targetDeviceId, keyHash: h.keyHash, home: h.home ?? '', countedKeys: h.countedKeys.map((k) => ({ keyId: k.keyId, publicKey: k.publicKey })), stopNonceHashes: h.stopNonceHashes ?? [] } : null,
    stops: f.stops,
    lastPresence: input.lastPresence,
    // An acceptance is withdrawn once a stop is known here, unless this machine had already settled it (review R3-M1).
    acceptedRecoveries: Object.entries(f.arrival).filter(([id, d]) => d === 'accepted' && (!stoppedIds(f).has(id) || f.settledHere?.[id] !== undefined)).map(([id]) => ({ recoveryId: id, entryId: f.arrivalEntry?.[id] ?? '' })),
  };
}

function validFacts(x: unknown): x is ApproverRecoveryFacts {
  const o = x as ApproverRecoveryFacts | null;
  return !!o && typeof o === 'object' && o.v === 1 && Number.isFinite(o.now) && Array.isArray(o.stops) && Array.isArray(o.acceptedRecoveries) && o.acceptedRecoveries.every((a) => !!a && typeof a === 'object' && typeof (a as { recoveryId?: unknown }).recoveryId === 'string');
}

/**
 * A peer's signed facts arrived (its pull request, verified by the mesh). Records them, and this machine's FIRST
 * sight of the peer's home recovery and of each accepted notice, on this machine's own clock. Stops are merged.
 */
const firstSightListeners: Array<(recoveryId: string, targetName: string) => void> = [];
/** Spec §1 step 5 (review L6): every machine pushes to the owner's devices on its own first sight of a recovery. */
export function onFirstSight(fn: (recoveryId: string, targetName: string) => void): void { firstSightListeners.push(fn); }

export function ingestPeerFacts(stateDir: string, peer: string, facts: unknown, now: number, registered: string[] = []): void {
  if (!validFacts(facts)) return;
  const f = readRecovery(stateDir);
  f.peers[peer] = { at: now, facts };
  const r = facts.recovery;
  // Only a recovery's own home reports it (review R2-M3); another machine relaying it is ignored, and two different
  // homes claiming one id stop it.
  if (r && typeof r.recoveryId === 'string' && r.home && r.home !== peer) {
    // ignored
  } else if (r && typeof r.recoveryId === 'string' && f.firstSeen[r.recoveryId]?.home && f.firstSeen[r.recoveryId]!.home !== peer) {
    if (!f.stops.some((x) => x.recoveryId === r.recoveryId && x.kind === 'approval' && x.by === 'conflicting-home')) f.stops.push({ recoveryId: r.recoveryId, at: now, by: 'conflicting-home', kind: 'approval', lock: false });
  } else if (r && typeof r.recoveryId === 'string') {
    const isNew = !f.firstSeen[r.recoveryId];
    const seen = f.firstSeen[r.recoveryId] ?? { at: now, notices: [null, null, null], machinesAtStart: r.machinesAtStart, startedAt: r.startedAt, home: peer, targetDeviceId: r.targetDeviceId, keyHash: r.keyHash, registeredAtSight: registered };
    if (isNew) firstSightListeners.forEach((fn) => { try { fn(r.recoveryId, r.targetName); } catch { /* @silent-fallback-ok: a notice listener's failure doesn't change the record */ } });
    r.notices.slice(0, 3).forEach((n, i) => { if (typeof n === 'number' && seen.notices[i] == null) seen.notices[i] = now; });
    f.firstSeen[r.recoveryId] = seen;
  }
  const known = new Set(f.stops.map((s) => `${s.recoveryId}|${s.by}|${s.kind}`));
  for (const s of facts.stops.slice(0, 200)) {
    if (!s || typeof s.recoveryId !== 'string' || typeof s.by !== 'string') continue;
    const key = `${s.recoveryId}|${s.by}|${s.kind}`;
    if (!known.has(key)) { f.stops.push({ recoveryId: s.recoveryId, at: s.at, by: s.by, kind: s.kind, lock: s.kind === 'signed' && s.lock === true, ...(s.endedAt ? { endedAt: s.endedAt } : {}) }); known.add(key); }
    if (s.kind === 'signed' && s.lock === true) f.lockUntil = Math.max(f.lockUntil ?? 0, s.at + STOP_LOCK_MS);
  }
  f.stops = pruneStops(f.stops, now);
  writeRecovery(stateDir, f);
}

/** Record a stop received on this machine (before answering). */
export function recordStop(stateDir: string, row: StopRow): void {
  const f = readRecovery(stateDir);
  if (!f.stops.some((s) => s.recoveryId === row.recoveryId && s.by === row.by && s.kind === row.kind)) f.stops.push(row);
  if (row.lock) f.lockUntil = Math.max(f.lockUntil ?? 0, row.at + STOP_LOCK_MS);
  if (f.home && f.home.recoveryId === row.recoveryId && (f.home.state === 'waiting' || f.home.state === 'ready')) f.home = { ...f.home, state: 'stopped', endedReason: `stopped by ${row.by}` };
  f.stops = pruneStops(f.stops, row.at);
  writeRecovery(stateDir, f);
}

export function stoppedIds(f: RecoveryFile): Set<string> { return new Set(f.stops.map((s) => s.recoveryId)); }

/** Any approval by a device other than the candidate at or after the start (less the margin), on this machine. */
export function approvalDuring(lastPresence: { at: number; deviceId: string } | null, startedAt: number, candidateDeviceId: string, clockShift = 0): boolean {
  return !!lastPresence && lastPresence.deviceId !== candidateDeviceId && lastPresence.at + clockShift >= startedAt - PRESENCE_MARGIN_MS;
}

/** Spec §1 step 5: ready after 72 h, three accepted notices, and an hour after the final one. */
export function isReady(h: HomeRecovery, now: number): boolean {
  if (h.state !== 'waiting' && h.state !== 'ready') return false;
  const [a, b, c] = h.notices;
  return a != null && b != null && c != null && now - h.startedAt >= RECOVERY_WAIT_MS && now - c >= READY_AFTER_FINAL_MS;
}

/** Which notice is due now (0, 1, 2), or null. Each comes at least 30 h after the previous one was accepted. */
export function noticeDue(h: HomeRecovery, now: number): 0 | 1 | 2 | null {
  if (h.state !== 'waiting') return null;
  for (const i of [0, 1, 2] as const) {
    if (h.notices[i] != null) continue;
    if (i > 0 && h.notices[i - 1] == null) return null; // in order
    return now - h.startedAt >= NOTICE_AT_MS[i]! ? i : null;
  }
  return null;
}

/** Spec §1 step 8: the two 7-day ends. */
export function endReason(h: HomeRecovery, now: number): string | null {
  // Umbrella §9: 7 days to finish, counted from the wait's end; a late readiness never extends it.
  if ((h.state === 'waiting' || h.state === 'ready') && now >= h.startedAt + RECOVERY_WAIT_MS + FINISH_WINDOW_MS) return h.state === 'waiting' ? 'not-ready-in-time' : 'not-finished-in-time';
  return null;
}

/**
 * Spec §2: this machine's own decision about a recovered entry when it arrives. `accept`, `hold` (check again next
 * tick; never ingest yet) or `retire` (a stop or an approval during the wait: take it in, retire its key at once).
 */
export function arrivalDecision(stateDir: string, input: {
  recoveryId: string; entryId: string; candidateDeviceId: string; candidateKeyHash: string; proofBy: string; now: number; selfMachineId: string;
  lastPresence: { at: number; deviceId: string } | null; registeredNow?: string[];
}): 'accept' | 'hold' | 'retire' | 'refuse' {
  const f = readRecovery(stateDir);
  const prior = f.arrival[input.recoveryId];
  // One entry per recovery: a second, different entry is refused, and records no stop (review H1, R2-M1).
  if (prior === 'accepted') return f.arrivalEntry?.[input.recoveryId] === input.entryId ? 'accept' : 'refuse';
  if (prior === 'retired') return 'retire';
  const home = f.home && f.home.recoveryId === input.recoveryId ? f.home : null;
  const seen = home
    ? { at: home.startedAt, notices: home.notices, home: input.selfMachineId, targetDeviceId: home.targetDeviceId, keyHash: home.keyHash }
    : f.firstSeen[input.recoveryId];
  if (seen) {
    // The entry must be the one frozen at the start, attested by its home; anything else is refused (no stop).
    if (seen.targetDeviceId !== input.candidateDeviceId || seen.keyHash !== input.candidateKeyHash || (seen.home && seen.home !== input.proofBy)) return 'refuse';
    if (stoppedIds(f).has(input.recoveryId)) return 'retire';
    // A machine that saw the recovery itself ALWAYS applies its own wait and its own approval check (review R2-H1).
    if (approvalDuring(input.lastPresence, seen.at, input.candidateDeviceId)) return 'retire';
    const final = seen.notices[2];
    if (!(input.now - seen.at >= RECOVERY_WAIT_MS && final != null && input.now - final >= READY_AFTER_FINAL_MS)) return 'hold';
    // First sight from the entry itself (no home report): every other machine in this registry must also accept it.
    const fromEntry = !home && (f.firstSeen[input.recoveryId]?.machinesAtStart?.length ?? 0) === 0;
    if (fromEntry) {
      const others = (f.firstSeen[input.recoveryId]?.registeredAtSight ?? input.registeredNow ?? []).filter((m) => m !== input.selfMachineId);
      if (!others.every((m) => f.peers[m]?.facts.acceptedRecoveries.some((a) => a.recoveryId === input.recoveryId && a.entryId === input.entryId))) return 'hold';
    }
    return 'accept';
  }
  if (stoppedIds(f).has(input.recoveryId)) return 'retire';
  // Never saw it here (joined later, lost its records, or a peer hid it): the entry's own arrival is this machine's
  // first sight. It waits 72 h on its own clock from now and checks its own approvals, AND every other machine in
  // its own registry must report accepting this exact entry (review R2-H1, R3-H1). A compromised peer can't skip it.
  f.firstSeen[input.recoveryId] = { at: input.now, notices: [input.now, input.now, input.now], machinesAtStart: [], home: input.proofBy,
    targetDeviceId: input.candidateDeviceId, keyHash: input.candidateKeyHash, registeredAtSight: input.registeredNow ?? [] };
  writeRecovery(stateDir, f);
  firstSightListeners.forEach((fn) => { try { fn(input.recoveryId, 'a new device'); } catch { /* @silent-fallback-ok: a listener's failure doesn't change the record */ } });
  return 'hold';
}

export function recordArrival(stateDir: string, recoveryId: string, decision: 'accepted' | 'held' | 'retired', entryId = ''): void {
  const f = readRecovery(stateDir);
  if (f.arrival[recoveryId] === 'accepted' || f.arrival[recoveryId] === 'retired') return; // recorded once
  f.arrival[recoveryId] = decision;
  f.arrivalEntry = { ...(f.arrivalEntry ?? {}), [recoveryId]: entryId };
  writeRecovery(stateDir, f);
}

/**
 * Spec §2: settled when every machine registered at the start has accepted the entry with no stop anywhere.
 * Until then the recovered key approves nothing.
 */
export function isSettled(stateDir: string, recoveryId: string, selfMachineId: string, entryId?: string, registered?: Set<string>): boolean {
  const f = readRecovery(stateDir);
  const mine = f.arrivalEntry?.[recoveryId] ?? '';
  if (entryId !== undefined && mine && mine !== entryId) return false;
  // Once settled here, a later stop doesn't undo it (review R2-M2): the owner is told it already finished.
  if (f.settledHere?.[recoveryId] !== undefined) return true;
  if (stoppedIds(f).has(recoveryId)) return false;
  if (f.arrival[recoveryId] !== 'accepted') return false;
  const id = entryId ?? mine;
  // The machines that must accept: this machine's OWN registry at its first sight (or, on the home, at the start),
  // less any removed since (review R2-H1, M3). Never the home's claim.
  const base = f.home?.recoveryId === recoveryId ? f.home.machinesAtStart : (f.firstSeen[recoveryId]?.registeredAtSight ?? [...(registered ?? [])]);
  const remaining = base.filter((m) => m !== selfMachineId && (!registered || registered.has(m)));
  const ok = remaining.every((m) => f.peers[m]?.facts.acceptedRecoveries.some((a) => a.recoveryId === recoveryId && a.entryId === id));
  if (ok) { f.settledHere = { ...(f.settledHere ?? {}), [recoveryId]: Date.now() }; writeRecovery(stateDir, f); }
  return ok;
}

/**
 * Spec §1 step 7: the Finish read over every machine's latest SIGNED facts. `stale` names machines whose facts are
 * older than one sync interval (they count as not answering); `stopped` says why the recovery must stop.
 */
export function finishRead(stateDir: string, input: { recoveryId: string; startedAt: number; candidateDeviceId: string; machines: string[]; selfMachineId: string; now: number; selfLastPresence: { at: number; deviceId: string } | null; registered?: Set<string> }): { stale: string[]; stopped: string | null } {
  const f = readRecovery(stateDir);
  if (stoppedIds(f).has(input.recoveryId)) return { stale: [], stopped: 'a stop was recorded' };
  if (approvalDuring(input.selfLastPresence, input.startedAt, input.candidateDeviceId)) return { stale: [], stopped: `${input.selfLastPresence!.deviceId} approved something on this computer` };
  const stale: string[] = [];
  for (const m of input.machines) {
    if (m === input.selfMachineId) continue;
    if (input.registered && !input.registered.has(m)) continue; // removed since the start (its stops stay in the union)
    const p = f.peers[m];
    if (!p || input.now - p.at > FACTS_FRESH_MS) { stale.push(m); continue; }
    if (p.facts.stops.some((s) => s.recoveryId === input.recoveryId)) return { stale: [], stopped: `${m} recorded a stop` };
    // Shift the peer's clock to ours by the difference between its reported now and when its facts arrived here.
    const shift = p.at - p.facts.now;
    if (approvalDuring(p.facts.lastPresence, input.startedAt, input.candidateDeviceId, shift)) return { stale: [], stopped: `${p.facts.lastPresence!.deviceId} approved something on ${m}` };
  }
  return { stale, stopped: null };
}

/** Review M6: any approval by another device since the start, here or on any peer (clocks shifted), during the wait. */
export function approvalSinceStart(stateDir: string, h: HomeRecovery, selfLastPresence: { at: number; deviceId: string } | null): string | null {
  if (approvalDuring(selfLastPresence, h.startedAt, h.targetDeviceId)) return selfLastPresence!.deviceId;
  const f = readRecovery(stateDir);
  for (const [m, p] of Object.entries(f.peers)) {
    if (approvalDuring(p.facts.lastPresence, h.startedAt, h.targetDeviceId, p.at - p.facts.now)) return `${p.facts.lastPresence!.deviceId} on ${m}`;
  }
  return null;
}

/** Review L2: mark a recovery's stops ended, so retention can drop them after 30 days. */
export function endStops(stateDir: string, recoveryId: string, at: number): void {
  const f = readRecovery(stateDir);
  let changed = false;
  f.stops = f.stops.map((x) => (x.recoveryId === recoveryId && x.endedAt === undefined ? (changed = true, { ...x, endedAt: at }) : x));
  if (changed) { f.stops = pruneStops(f.stops, at); writeRecovery(stateDir, f); }
}

/** Review M5: every remaining machine's latest facts arrived after this time. */
export function allFactsAfter(stateDir: string, machines: string[], selfMachineId: string, t: number): boolean {
  const f = readRecovery(stateDir);
  return machines.filter((m) => m !== selfMachineId).every((m) => (f.peers[m]?.at ?? 0) > t);
}

/** Review M1: a Stop-button nonce whose hash a peer's facts carry (the owner's tap reached a different machine). */
export function recoveryForStopNonceHash(stateDir: string, hash: string): string | null {
  const f = readRecovery(stateDir);
  if (f.home?.stopNonceHashes?.includes(hash)) return f.home.recoveryId;
  for (const p of Object.values(f.peers)) if (p.facts.recovery?.stopNonceHashes?.includes(hash)) return p.facts.recovery.recoveryId;
  return null;
}
