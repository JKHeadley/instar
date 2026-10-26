/**
 * machineLiveness — honest per-machine evidence and the derived `liveness`
 * field (trustworthy-machine-load-and-mesh-floor spec, Part A).
 *
 * The 2026-10-25 incident: the pool view said "offline" for a machine that was
 * running but overloaded, because "never heard from it since I restarted" and
 * "confirmed dead" looked the same, and an old relayed record was rendered as
 * if it were a live check. This module keeps the three kinds of evidence apart
 * and derives one display state from them with fixed precedence:
 *
 *   live        — a direct success (this process pulled from that machine) within
 *                 the failover threshold.
 *   unreachable — direct attempts are failing and the last direct success is older
 *                 than that; the failure shape is named (`struggling` when timeouts
 *                 or partial replies are interleaved with successes in the window,
 *                 `refusing` for resets/refusals, `silent` for no route or no answer).
 *   stale       — only relayed (git-synced) or saved (durable) evidence, shown with
 *                 its ORIGINAL age.
 *   unknown     — no evidence at all.
 *
 * "offline" is never derived here: it needs positive evidence (a shutdown
 * announcement or the sleep gate), which this layer does not have.
 *
 * DISPLAY ONLY. `MachineCapacity.online` and every placement / ownership decision
 * keep their existing semantics (spec A2); nothing here gates anything.
 *
 * Pure: no I/O, no clock reads beyond caller-supplied times.
 */

/** Shape of one failed direct attempt to reach a peer. */
export type PullFailureShape = 'timeout' | 'partial' | 'reset' | 'refused' | 'no-route';

export type MachineLivenessState = 'live' | 'unreachable' | 'stale' | 'unknown';

/** Sub-shape of `unreachable`. */
export type UnreachableShape = 'struggling' | 'refusing' | 'silent';

/** Where the evidence behind a liveness verdict came from. */
export type EvidenceSource =
  | 'self' // this machine
  | 'direct' // this process pulled from the machine
  | 'relayed' // a git-synced heartbeat file (indirect)
  | 'saved' // a durable record of an earlier direct contact (survives restarts)
  | 'peer-sighting' // another machine reports its own direct contact (display only)
  | 'none';

export interface MachineLiveness {
  state: MachineLivenessState;
  /** Only for `unreachable`. */
  shape?: UnreachableShape;
  /** The latest failure shape seen (only for `unreachable`). */
  lastFailure?: PullFailureShape;
  /** Age of the evidence that decided the state, ms (null for `unknown`). */
  evidenceAgeMs: number | null;
  /** ISO time of that evidence (origin time, never a re-read time). */
  evidenceAt: string | null;
  source: EvidenceSource;
  /** For `peer-sighting`: the machine that made the observation. */
  observerMachineId?: string;
  /**
   * The freshest sighting of this machine by another machine, display-only
   * ("Mac Mini reached it 3 min ago"). Never changes `state`.
   */
  peerSighting?: { observerMachineId: string; ageMs: number };
}

/** One recorded direct attempt (success or failure) — the window behind `struggling`. */
export interface DirectAttempt {
  atMs: number;
  ok: boolean;
  shape?: PullFailureShape;
}

export interface LivenessInputs {
  isSelf: boolean;
  nowMs: number;
  failoverThresholdMs: number;
  /** Receipt time (our clock) of the last direct success in THIS process. */
  lastDirectSuccessAtMs?: number;
  /** Recent direct attempts, oldest first (bounded by the caller). */
  attempts: DirectAttempt[];
  /** Original time of the freshest relayed (git-synced) beat, if any. */
  relayedOriginAtMs?: number;
  /** Receipt time of a direct success saved by an earlier process. */
  savedDirectAtMs?: number;
  /** Freshest peer sighting (age at receipt, plus receipt time). */
  peerSighting?: { observerMachineId: string; ageMs: number; receivedAtMs: number };
}

/** How far back the attempt window looks when naming `struggling` (15 min). */
export const ATTEMPT_WINDOW_MS = 15 * 60_000;
/** Bound on recorded attempts per peer. */
export const MAX_ATTEMPTS = 40;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * Classify a failed `fetchPeerCapacity` into a shape. `null` (the peer answered
 * but not with a usable success, e.g. a non-200) is `partial`; a thrown abort is
 * `timeout`; socket codes map to reset / refused / no-route. Unknown errors are
 * `timeout` — the conservative "it did not answer in time" reading.
 */
export function classifyPullFailure(err: unknown): PullFailureShape {
  if (err === null || err === undefined) return 'partial';
  // Collect every code/name on the error, its cause, and (for undici's
  // `fetch failed` → AggregateError) each nested error — the refused socket is
  // three levels down in Node's fetch.
  const codes: string[] = [];
  const names: string[] = [];
  const visit = (e: unknown, depth: number): void => {
    if (!e || typeof e !== 'object' || depth > 4) return;
    const o = e as { code?: unknown; name?: unknown; cause?: unknown; errors?: unknown; message?: unknown };
    if (typeof o.code === 'string') codes.push(o.code);
    if (typeof o.name === 'string') names.push(o.name);
    if (typeof o.message === 'string') {
      const m = o.message.match(/\b(E[A-Z]+|UND_ERR_[A-Z_]+)\b/);
      if (m) codes.push(m[1]);
    }
    visit(o.cause, depth + 1);
    if (Array.isArray(o.errors)) for (const sub of o.errors.slice(0, 8)) visit(sub, depth + 1);
  };
  visit(err, 0);
  const has = (...c: string[]) => c.some((x) => codes.includes(x));
  if (has('ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET')) return 'reset';
  if (has('ECONNREFUSED')) return 'refused';
  if (has('ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN', 'EHOSTDOWN')) return 'no-route';
  if (names.includes('AbortError') || names.includes('TimeoutError') || has('ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT')) {
    return 'timeout';
  }
  return 'timeout';
}

/** Append an attempt, keeping the list bounded and inside the window. */
export function appendAttempt(list: DirectAttempt[], attempt: DirectAttempt, nowMs: number): DirectAttempt[] {
  const next = [...list, attempt].filter((a) => nowMs - a.atMs <= ATTEMPT_WINDOW_MS);
  return next.length > MAX_ATTEMPTS ? next.slice(next.length - MAX_ATTEMPTS) : next;
}

function unreachableShape(attempts: DirectAttempt[], nowMs: number): { shape: UnreachableShape; last: PullFailureShape } {
  const inWindow = attempts.filter((a) => nowMs - a.atMs <= ATTEMPT_WINDOW_MS);
  const failures = inWindow.filter((a) => !a.ok);
  const last = failures[failures.length - 1]?.shape ?? 'timeout';
  const hadSuccess = inWindow.some((a) => a.ok);
  const slowShapes = failures.some((a) => a.shape === 'timeout' || a.shape === 'partial');
  if (hadSuccess && slowShapes) return { shape: 'struggling', last };
  if (last === 'reset' || last === 'refused') return { shape: 'refusing', last };
  if (last === 'no-route') return { shape: 'silent', last };
  // Only timeouts / partial replies, no success in the window: it is not
  // answering. That is not proof it is gone, so the state stays `unreachable`.
  return { shape: 'silent', last };
}

/** Derive the display liveness (spec A2). Pure. */
export function deriveLiveness(i: LivenessInputs): MachineLiveness {
  const sighting = i.peerSighting
    ? { observerMachineId: i.peerSighting.observerMachineId, ageMs: i.peerSighting.ageMs + Math.max(0, i.nowMs - i.peerSighting.receivedAtMs) }
    : undefined;
  const withSighting = (l: MachineLiveness): MachineLiveness => (sighting ? { ...l, peerSighting: sighting } : l);

  if (i.isSelf) {
    return { state: 'live', evidenceAgeMs: 0, evidenceAt: iso(i.nowMs), source: 'self' };
  }

  const succ = i.lastDirectSuccessAtMs;
  if (succ !== undefined && i.nowMs - succ < i.failoverThresholdMs) {
    return withSighting({ state: 'live', evidenceAgeMs: i.nowMs - succ, evidenceAt: iso(succ), source: 'direct' });
  }

  const lastFailure = [...i.attempts].reverse().find((a) => !a.ok);
  const failingAfterSuccess = lastFailure && (succ === undefined || lastFailure.atMs > succ);
  if (failingAfterSuccess) {
    const { shape, last } = unreachableShape(i.attempts, i.nowMs);
    // Evidence age for an unreachable machine is the age of its last REAL
    // contact we know of (direct, then saved, then relayed) — that is what the
    // reader needs ("unreachable, last reached 40 min ago").
    const contact = succ ?? i.savedDirectAtMs ?? i.relayedOriginAtMs;
    const source: EvidenceSource = succ !== undefined ? 'direct' : i.savedDirectAtMs !== undefined ? 'saved' : i.relayedOriginAtMs !== undefined ? 'relayed' : 'none';
    return withSighting({
      state: 'unreachable',
      shape,
      lastFailure: last,
      evidenceAgeMs: contact !== undefined ? Math.max(0, i.nowMs - contact) : null,
      evidenceAt: contact !== undefined ? iso(contact) : null,
      source,
    });
  }

  // Only indirect or saved evidence: stale, with the FRESHEST original age.
  const candidates: Array<{ at: number; source: EvidenceSource }> = [];
  if (succ !== undefined) candidates.push({ at: succ, source: 'direct' });
  if (i.savedDirectAtMs !== undefined) candidates.push({ at: i.savedDirectAtMs, source: 'saved' });
  if (i.relayedOriginAtMs !== undefined) candidates.push({ at: i.relayedOriginAtMs, source: 'relayed' });
  if (candidates.length > 0) {
    const best = candidates.reduce((a, b) => (b.at > a.at ? b : a));
    return withSighting({ state: 'stale', evidenceAgeMs: Math.max(0, i.nowMs - best.at), evidenceAt: iso(best.at), source: best.source });
  }
  return withSighting({ state: 'unknown', evidenceAgeMs: null, evidenceAt: null, source: 'none' });
}

/** "3 min" / "2 h" / "4 d" — never a fabricated value. */
export function formatAge(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return 'unknown';
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return `${sec} s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr} h`;
  return `${Math.floor(hr / 24)} d`;
}

const SOURCE_WORDS: Record<EvidenceSource, string> = {
  self: 'this machine',
  direct: 'a direct check from this machine',
  relayed: 'a relayed heartbeat file',
  saved: 'a saved record of a direct check',
  'peer-sighting': 'another machine',
  none: 'nothing',
};

/** The one wording template (spec A5): `<liveness>, last evidence <age> ago from <source>`. */
export function formatLivenessLine(l: MachineLiveness, nicknameOf: (machineId: string) => string = (id) => id): string {
  if (l.state === 'unknown') {
    const base = 'unknown — no evidence yet';
    return l.peerSighting ? `${base}; ${nicknameOf(l.peerSighting.observerMachineId)} reached it ${formatAge(l.peerSighting.ageMs)} ago` : base;
  }
  if (l.source === 'self') return 'live (this machine)';
  const label = l.state === 'unreachable' ? `unreachable (${l.shape ?? 'struggling'})` : l.state;
  const ev = l.evidenceAgeMs === null ? 'no successful contact on record' : `last evidence ${formatAge(l.evidenceAgeMs)} ago from ${SOURCE_WORDS[l.source]}`;
  const sight = l.peerSighting ? `; ${nicknameOf(l.peerSighting.observerMachineId)} reached it ${formatAge(l.peerSighting.ageMs)} ago` : '';
  return `${label}, ${ev}${sight}`;
}
