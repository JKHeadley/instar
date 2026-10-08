/**
 * backupRoutes — the two pure decision rules of docs/specs/a2a-backup-routes.md,
 * kept out of routes.ts so the unit tests run the same code the route runs.
 *
 *  1. classifyFallthrough — after the name path's local POST, is the relay copy
 *     that follows a possible repeat (mark it `resend: true`) or is
 *     non-admission proven (leave it unmarked)? Over-marking is the safe
 *     direction: a mark on a copy that was not a repeat only changes the
 *     receiver's notice wording.
 *  2. The fingerprint branch — an exact 32-hex target, matched against
 *     known-agents.json by resolved fingerprint, de-duplicated by
 *     (fingerprint, port), exactly one match, and a live /threadline/health
 *     answer that shows the same fingerprint AND a connected relay.
 *
 * Both rules are stateless per send. The counters are in-memory observability
 * for the authed /health (the graduation evidence), never an input.
 */

import { resolvePeerFingerprint } from './peerFingerprint.js';
import { resolveDevAgentGate } from '../core/devAgentGate.js';

/** What the name path's local POST to /messages/relay-agent produced. */
export type LocalPostOutcome =
  /** No POST was issued (failed health probe, missing token, no local match). */
  | { kind: 'no-post' }
  /** The POST was issued; nothing is known yet (a throw before an answer). */
  | { kind: 'issued' }
  /** The POST's own fetch threw (timeout, reset, refused, …). */
  | { kind: 'error'; code?: string; name?: string }
  /** The POST answered with an HTTP status (2xx here means a throw AFTER the 2xx). */
  | { kind: 'status'; status: number; ledgerUnavailable?: boolean };

export interface FallthroughDecision {
  /** True when a POST was issued: the relay leg uses the local attempt's thread. */
  postIssued: boolean;
  /** True when the relay leg carries `resend: true`. */
  marked: boolean;
  /** A short, log-safe label for the outcome. */
  outcome: string;
}

/** HTTP statuses that prove the receiver did not admit the message. */
const NON_ADMISSION_STATUSES = new Set([400, 401, 404]);

/**
 * The marking rule (spec §1). Unmarked ONLY for the enumerated non-admission
 * set: no POST; ECONNREFUSED on the POST's own connection; HTTP 400/401/404;
 * HTTP 503 whose JSON body says `error: 'ledger-unavailable'`. Everything else
 * after a POST is marked.
 */
export function classifyFallthrough(outcome: LocalPostOutcome): FallthroughDecision {
  switch (outcome.kind) {
    case 'no-post':
      return { postIssued: false, marked: false, outcome: 'no-post' };
    case 'issued':
      return { postIssued: true, marked: true, outcome: 'unknown-after-post' };
    case 'error': {
      if (outcome.code === 'ECONNREFUSED') return { postIssued: true, marked: false, outcome: 'econnrefused' };
      const label = outcome.name === 'TimeoutError' || outcome.name === 'AbortError'
        ? 'timeout'
        : (outcome.code ? outcome.code.toLowerCase() : 'socket-error');
      return { postIssued: true, marked: true, outcome: label };
    }
    case 'status': {
      const s = outcome.status;
      if (NON_ADMISSION_STATUSES.has(s)) return { postIssued: true, marked: false, outcome: `http-${s}` };
      if (s === 503 && outcome.ledgerUnavailable === true) return { postIssued: true, marked: false, outcome: 'http-503-ledger-unavailable' };
      if (s >= 200 && s < 300) return { postIssued: true, marked: true, outcome: `throw-after-http-${s}` };
      return { postIssued: true, marked: true, outcome: `http-${s}` };
    }
  }
}

/**
 * The connection error code a Node `fetch` rejection carries. undici wraps the
 * socket error as `TypeError('fetch failed')` with `cause.code`; a dual-stack
 * connect failure nests it one level deeper in an AggregateError's `errors`.
 * A refusal counts only when EVERY attempt was refused.
 */
export function fetchErrorCode(err: unknown): string | undefined {
  const direct = (err as { code?: unknown } | null)?.code;
  if (typeof direct === 'string') return direct;
  const cause = (err as { cause?: unknown } | null)?.cause as { code?: unknown; errors?: unknown } | undefined;
  if (!cause) return undefined;
  if (typeof cause.code === 'string') return cause.code;
  if (Array.isArray(cause.errors) && cause.errors.length > 0) {
    const codes = cause.errors.map((e) => (e as { code?: unknown } | null)?.code);
    if (codes.every((c) => c === 'ECONNREFUSED')) return 'ECONNREFUSED';
    // Mixed: not every attempt was refused, so refusal is not proven.
    const first = codes.find((c) => typeof c === 'string' && c !== 'ECONNREFUSED')
      ?? codes.find((c) => typeof c === 'string');
    return typeof first === 'string' ? first : undefined;
  }
  return undefined;
}

/** Map a thrown POST fetch error to a LocalPostOutcome. */
export function outcomeFromFetchError(err: unknown): LocalPostOutcome {
  const name = (err as { name?: unknown } | null)?.name;
  return { kind: 'error', code: fetchErrorCode(err), name: typeof name === 'string' ? name : undefined };
}

/** Exactly 32 hex characters (compared lowercased). */
export function isExactFingerprintTarget(target: unknown): target is string {
  return typeof target === 'string' && /^[0-9a-f]{32}$/i.test(target);
}

export interface KnownAgentEntry {
  name: string;
  port: number;
  path?: string;
  fingerprint?: string;
  publicKey?: string;
}

export type FingerprintSelection<T extends KnownAgentEntry = KnownAgentEntry> =
  | { kind: 'one'; entry: T }
  | { kind: 'none' }
  | { kind: 'ambiguous'; ports: number[] };

/**
 * Select the single known-agents entry for an exact fingerprint target:
 * entries whose resolved fingerprint equals the target, de-duplicated by
 * (fingerprint, port). Two distinct ports are ambiguous — the caller sends via
 * the relay, never the "Ambiguous target" 409.
 */
export function selectFingerprintTarget<T extends KnownAgentEntry>(agents: T[], target: string): FingerprintSelection<T> {
  const want = target.toLowerCase();
  const byPort = new Map<string, T>();
  for (const a of agents) {
    if (!a || resolvePeerFingerprint(a) !== want) continue;
    const key = `${want}|${String(a.port)}`;
    if (!byPort.has(key)) byPort.set(key, a);
  }
  const unique = [...byPort.values()];
  if (unique.length === 0) return { kind: 'none' };
  if (unique.length > 1) return { kind: 'ambiguous', ports: unique.map((u) => u.port) };
  return { kind: 'one', entry: unique[0] };
}

export type FingerprintHealthVerdict =
  | { ok: true }
  | { ok: false; reason: 'not-ok' | 'fingerprint-absent' | 'fingerprint-mismatch' | 'relay-not-connected' };

/**
 * The live-health precondition for the fingerprint branch: the answer's
 * `fingerprint` equals the target (lowercased) — guards a stale port now held
 * by another agent; NOT authentication — AND `relay.state === 'connected'` (a
 * relay standby reports `not-configured`, a displaced server `displaced`;
 * neither owns the agent's conversations).
 */
export function checkFingerprintHealth(httpOk: boolean, body: unknown, target: string): FingerprintHealthVerdict {
  if (!httpOk) return { ok: false, reason: 'not-ok' };
  const b = (body ?? {}) as { fingerprint?: unknown; relay?: { state?: unknown } };
  if (typeof b.fingerprint !== 'string' || !b.fingerprint) return { ok: false, reason: 'fingerprint-absent' };
  if (b.fingerprint.toLowerCase() !== target.toLowerCase()) return { ok: false, reason: 'fingerprint-mismatch' };
  if (b.relay?.state !== 'connected') return { ok: false, reason: 'relay-not-connected' };
  return { ok: true };
}

/** The live gate (spec "Configuration"): `enabled` omitted ⇒ the dev-agent gate decides. */
export function resolveBackupRoutesEnabled(
  liveEnabled: boolean | undefined,
  config: { developmentAgent?: boolean; threadline?: { backupRoutes?: { enabled?: boolean } } },
): boolean {
  const explicit = liveEnabled ?? config.threadline?.backupRoutes?.enabled;
  return resolveDevAgentGate(explicit, config);
}

/** In-memory counters on the authed /health (graduation evidence). */
export interface BackupRouteCounters {
  markedFallthrough: number;
  unmarkedFallthroughAfterPost: number;
  fingerprintLocal: number;
  fingerprintToRelay: number;
}

export function createBackupRouteCounters(): BackupRouteCounters {
  return { markedFallthrough: 0, unmarkedFallthroughAfterPost: 0, fingerprintLocal: 0, fingerprintToRelay: 0 };
}

/** The one server-log line per marked fall-through / fingerprint-local delivery. */
export function backupLogLine(kind: 'marked-fallthrough' | 'fingerprint-local', messageId: string, peerFp: string, outcome: string): string {
  return `[a2a-backup] id=${messageId} peer=${peerFp || 'unknown'} kind=${kind} outcome=${outcome}`;
}
