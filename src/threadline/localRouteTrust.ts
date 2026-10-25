/**
 * Local-route trust (docs/specs/a2a-local-route-trust.md, ACT-056).
 *
 * `POST /messages/relay-agent` is the same-machine A2A route. Its bearer token
 * proves the caller can read THIS agent's token — not who the caller is — and
 * until this module every sender on it was handled at the `verified` default,
 * while the relay path resolves an unknown fingerprint to `untrusted` and
 * refuses operations that level may not perform (InboundMessageGate step 4).
 *
 * This module resolves the sender's trust from the SAME AgentTrustManager the
 * relay gate uses and applies the SAME operation-permission check. It is pure
 * decision logic: the route decides what to do with the verdict (observe in
 * dry-run, refuse with a pre-admission 403 when enforcing).
 *
 * The trust manager stays the single authority for the level → operation
 * table; nothing here re-implements it.
 */

import { resolveDevAgentGate } from '../core/devAgentGate.js';
import type { AgentTrustLevel, AgentTrustManager } from './AgentTrustManager.js';

/** Which identity the profile lookup keyed on. */
export type LocalTrustIdentitySource =
  /** `from.agent` resolved to ONE fingerprint through `known-agents.json`. */
  | 'registry'
  /** No registry fingerprint; the well-formed `from.fingerprint` in the body. */
  | 'asserted'
  /** A profile stored under the sender NAME (operator grant by name, TrustBootstrap). */
  | 'name'
  /** No profile under any identity the route can resolve. */
  | 'none';

export interface LocalRouteTrustInput {
  /** `resolvePeerFingerprintByName(stateDir, from.agent)` — null when unresolved/ambiguous. */
  registryFingerprint: string | null;
  /** The body's `from.fingerprint` when well-formed — consulted ONLY when no registry fingerprint exists. */
  assertedFingerprint: string | null;
  /** The body's `from.agent`. */
  senderName: string;
  /** The envelope's `message.body` (string or object). */
  body: unknown;
}

export interface LocalRouteTrustVerdict {
  level: AgentTrustLevel;
  operation: string;
  /** May this level perform this operation, per the trust manager's table. */
  allowed: boolean;
  identitySource: LocalTrustIdentitySource;
  /** The fingerprint the lookup keyed on (null for a name-only identity). */
  fingerprint: string | null;
}

/** The slice of AgentTrustManager this module reads. */
export type LocalRouteTrustManager = Pick<
  AgentTrustManager,
  'getProfileByFingerprint' | 'getAllowedOperationsByFingerprint' | 'getProfile' | 'checkPermission'
>;

/** An operation name no trust level allows: a body whose `type` is present but unusable. */
export const INVALID_LOCAL_OPERATION = '(invalid-type)';

/**
 * The operation an envelope asks for — the local-route twin of
 * InboundMessageGate.classifyOperation: an object body that HAS a `type` names
 * the operation with it; anything else is a plain `message`. The relay gate
 * refuses a `type` that is not an allowed operation name, so a `type` that is
 * present but not a non-empty string maps to a name nothing allows.
 */
export function classifyLocalOperation(body: unknown): string {
  if (typeof body === 'object' && body !== null && 'type' in body) {
    const t = (body as { type?: unknown }).type;
    return typeof t === 'string' && t ? t : INVALID_LOCAL_OPERATION;
  }
  return 'message';
}

/**
 * Resolve the sender's trust level and whether it may perform the operation.
 *
 * Lookup order:
 *  1. the fingerprint — the registry-resolved one; the body-asserted one ONLY
 *     when the registry resolves none — against fingerprint-keyed profiles
 *     (exactly what the relay gate consults);
 *  2. a profile stored under the sender NAME that carries NO fingerprint (an
 *     operator grant by name, TrustBootstrap). A profile that belongs to a
 *     fingerprint is reachable through step 1 only — never by its display
 *     name, so leaving the fingerprint out can never yield more than stating it;
 *  3. no profile → `untrusted`, as on the relay path.
 */
export function resolveLocalRouteTrust(tm: LocalRouteTrustManager, input: LocalRouteTrustInput): LocalRouteTrustVerdict {
  const operation = classifyLocalOperation(input.body);
  const fingerprint = input.registryFingerprint ?? input.assertedFingerprint;
  const fpSource: LocalTrustIdentitySource = input.registryFingerprint ? 'registry' : 'asserted';

  if (fingerprint) {
    const byFp = tm.getProfileByFingerprint(fingerprint);
    if (byFp) {
      return {
        level: byFp.level,
        operation,
        allowed: tm.getAllowedOperationsByFingerprint(fingerprint).includes(operation),
        identitySource: fpSource,
        fingerprint,
      };
    }
  }

  const byName = input.senderName ? tm.getProfile(input.senderName) : null;
  // A real, fingerprint-less profile whose own name is the sender name. (The
  // shape checks also reject an inherited property hit for a name such as
  // `constructor`.)
  if (
    byName && typeof byName === 'object' && typeof byName.level === 'string'
    && !byName.fingerprint && byName.agent === input.senderName
  ) {
    return {
      level: byName.level,
      operation,
      allowed: tm.checkPermission(byName.agent, operation),
      identitySource: 'name',
      fingerprint: null,
    };
  }

  // No profile: the trust manager's own unknown-sender answer (untrusted table).
  // Keyed on the fingerprint (or none) — never on peer-supplied name text.
  return {
    level: 'untrusted',
    operation,
    allowed: tm.getAllowedOperationsByFingerprint(fingerprint ?? '').includes(operation),
    identitySource: 'none',
    fingerprint: fingerprint ?? null,
  };
}

/**
 * The level a local delivery STATES to the receiving session. Every identity
 * on this route starts from text in the request body, so a resolved level may
 * LOWER what the session is told and never raise it above the `verified` the
 * route states today: a caller that claims a trusted peer's name gains nothing.
 */
export function statedLocalTrustLevel(level: AgentTrustLevel): AgentTrustLevel {
  return level === 'untrusted' ? 'untrusted' : 'verified';
}

export interface LocalRouteTrustMode {
  /** Gate-resolved: `enabled` omitted ⇒ the developmentAgent gate decides. */
  enabled: boolean;
  /** Default TRUE: log + count would-refuse verdicts, deliver exactly as today. */
  dryRun: boolean;
}

interface LocalRouteTrustConfigShape {
  developmentAgent?: boolean;
  threadline?: { localRouteTrust?: { enabled?: boolean; dryRun?: boolean } };
}

/** The live mode (spec "Configuration"). Read per request. */
export function resolveLocalRouteTrustMode(
  live: { enabled?: boolean; dryRun?: boolean },
  config: LocalRouteTrustConfigShape,
): LocalRouteTrustMode {
  const block = config.threadline?.localRouteTrust;
  const enabled = resolveDevAgentGate(live.enabled ?? block?.enabled, config);
  // Only an explicit `false` leaves dry-run; anything else observes.
  const dryRun = (live.dryRun ?? block?.dryRun) !== false;
  return { enabled, dryRun };
}

/** In-memory counters on the authed /health (the rollout evidence). */
export interface LocalRouteTrustCounters {
  /** Requests the check ran on. */
  evaluated: number;
  /** The resolved level may perform the operation. */
  allowed: number;
  /** Dry-run: would have been refused; delivered as today. */
  wouldRefuse: number;
  /** Enforcing: refused with the pre-admission 403. */
  refused: number;
  /** Feature on, no trust manager wired: handled as today. */
  noTrustManager: number;
  /** The trust lookup threw. */
  lookupErrors: number;
}

export function createLocalRouteTrustCounters(): LocalRouteTrustCounters {
  return { evaluated: 0, allowed: 0, wouldRefuse: 0, refused: 0, noTrustManager: 0, lookupErrors: 0 };
}

/** Peer-supplied text is never logged raw: printable ASCII only, bounded. */
function logSafe(value: string): string {
  return value.replace(/[^\x21-\x7e]/g, '?').slice(0, 48) || 'unknown';
}

/** The one server-log line per would-refuse / refuse verdict. */
export function localRouteTrustLogLine(kind: 'would-refuse' | 'refuse', senderName: string, v: LocalRouteTrustVerdict): string {
  return `[relay-agent-trust] ${kind} from=${logSafe(senderName)} fp=${v.fingerprint ? v.fingerprint.slice(0, 12) : 'none'} source=${v.identitySource} trust=${v.level} op=${logSafe(v.operation)}`;
}
