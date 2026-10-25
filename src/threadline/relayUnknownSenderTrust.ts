/**
 * Relay unknown-sender trust (docs/specs/a2a-relay-unknown-sender-trust.md, ACT-066).
 *
 * The relay emits `unknown-sender` for a message whose sender's keys this agent
 * does not hold (it cannot decrypt it, so the payload is plaintext). Until this
 * module, that path skipped InboundMessageGate entirely and handed every such
 * message onward at trust level `verified` (reason `relay-authenticated`) — and
 * recording the interaction created a fingerprint trust profile at `verified`,
 * so the sender stayed `verified` for every later message on every path.
 *
 * The relay proves the sender holds the private key of its fingerprint. It does
 * not prove who the sender is, and nobody granted that fingerprint anything.
 *
 * This module resolves the sender's trust from the SAME AgentTrustManager the
 * relay gate reads and applies the SAME operation-permission table. The trust
 * manager stays the single authority for level → operations; nothing here
 * re-implements it. Dry-run (the default when on) logs and counts would-refuse
 * verdicts and delivers exactly as before; only an explicit `dryRun: false`
 * refuses, emits the held level, and stops new fingerprint profiles from being
 * created at `verified`.
 */

import { resolveDevAgentGate } from '../core/devAgentGate.js';
import type { AgentTrustLevel, AgentTrustManager } from './AgentTrustManager.js';
import type { ReceivedMessage } from './client/ThreadlineClient.js';

/** The slice of AgentTrustManager this module reads and writes. */
export type RelayUnknownSenderTrustManager = Pick<
  AgentTrustManager,
  'getProfileByFingerprint' | 'getAllowedOperationsByFingerprint' | 'recordMessageReceivedByFingerprint' | 'getOrCreateProfileByFingerprint'
>;

/** An operation name no trust level allows: a wire `type` that is present but unusable. */
export const INVALID_RELAY_OPERATION = '(invalid-type)';

/** Probes, as in InboundMessageGate: they pass with reason `probe`. */
const PROBE_OPS = new Set(['ping', 'health']);

/**
 * Delivery acks are consumed by the ack stage before the inbox, the warrants
 * gate and every router (docs/specs/a2a-ack-never-acked.md): they only record
 * that our own earlier send arrived. Refusing them would make every peer we
 * write to look unreachable, so every level may send one.
 */
const ACK_OP = 'ack';

/**
 * The operation a plaintext relay payload asks for. The plaintext wire carries
 * `chat` for a message and `ack` for a delivery ack (ThreadlineClient); neither
 * name is in the level table, so `chat` (and a missing type) map to `message`.
 * Any other string is taken as the operation name, exactly as the relay gate
 * takes an E2E `type`; a non-string type maps to a name nothing allows.
 */
export function classifyRelayPlaintextOperation(wireType: unknown): string {
  if (wireType === undefined || wireType === null || wireType === 'chat') return 'message';
  if (typeof wireType === 'string' && wireType) return wireType;
  return INVALID_RELAY_OPERATION;
}

export interface RelayUnknownSenderVerdict {
  /** The level the trust manager holds for the fingerprint (`untrusted` with no profile). */
  level: AgentTrustLevel;
  operation: string;
  /** May this level perform this operation, per the trust manager's table. */
  allowed: boolean;
  /** A trust profile counts for the fingerprint (a first-contact profile does not). */
  hasProfile: boolean;
}

/** Credentials never travel the plaintext fallback (verified-pairing spec). */
const CREDENTIAL_SHARE_OP = 'credential-share';

/**
 * Resolve the sender's held trust level and whether it may perform the
 * operation. Reads only.
 *
 * A profile this path itself wrote at first contact while observing
 * (`relayFirstContact`, source still `setup-default`) counts as no profile:
 * under enforcement it would never have been written at `verified`. Once the
 * operator or a pairing decides (any other source), the profile counts.
 */
export function resolveRelayUnknownSenderTrust(
  tm: Pick<RelayUnknownSenderTrustManager, 'getProfileByFingerprint' | 'getAllowedOperationsByFingerprint'>,
  fingerprint: string,
  wireType: unknown,
): RelayUnknownSenderVerdict {
  const operation = classifyRelayPlaintextOperation(wireType);
  const found = tm.getProfileByFingerprint(fingerprint);
  const profile = found && !(found.relayFirstContact && found.source === 'setup-default') ? found : null;
  const level: AgentTrustLevel = profile?.level ?? 'untrusted';
  let allowed: boolean;
  if (operation === ACK_OP) {
    allowed = true;
  } else if (operation === CREDENTIAL_SHARE_OP) {
    allowed = false;
  } else if (level === 'untrusted') {
    // One intended difference from the gate's table: an `untrusted` sender's
    // probe is NOT passed on. The gate passes probes expecting them handled
    // inline, but the server's `gate-passed` consumer routes every message it
    // receives to a session — so passing a stranger's ping would hand it the
    // very session this check exists to deny. Only its delivery acks pass.
    allowed = false;
  } else {
    allowed = tm.getAllowedOperationsByFingerprint(fingerprint).includes(operation);
  }
  return { level, operation, allowed, hasProfile: !!profile };
}

export interface RelayUnknownSenderTrustMode {
  /** Gate-resolved: `enabled` omitted ⇒ the developmentAgent gate decides. */
  enabled: boolean;
  /** Default TRUE: log + count would-refuse verdicts, deliver exactly as today. */
  dryRun: boolean;
}

interface RelayUnknownSenderTrustConfigShape {
  developmentAgent?: boolean;
  threadline?: { relayUnknownSenderTrust?: { enabled?: boolean; dryRun?: boolean } };
}

/** The live mode (spec "Configuration"). Read per message. */
export function resolveRelayUnknownSenderTrustMode(
  live: { enabled?: boolean; dryRun?: boolean },
  config: RelayUnknownSenderTrustConfigShape,
): RelayUnknownSenderTrustMode {
  const block = config.threadline?.relayUnknownSenderTrust;
  const enabled = resolveDevAgentGate(live.enabled ?? block?.enabled, config);
  // Only an explicit `false` leaves dry-run; anything else observes.
  const dryRun = (live.dryRun ?? block?.dryRun) !== false;
  return { enabled, dryRun };
}

/** True only when the check is on AND enforcing. */
export function isRelayUnknownSenderTrustEnforcing(mode: RelayUnknownSenderTrustMode): boolean {
  return mode.enabled && !mode.dryRun;
}

/**
 * The level a NEW fingerprint trust profile is created at. Today `verified`;
 * `untrusted` while the check is enforcing — a first contact is not a grant.
 */
export function newFingerprintProfileLevel(mode: RelayUnknownSenderTrustMode): AgentTrustLevel {
  return isRelayUnknownSenderTrustEnforcing(mode) ? 'untrusted' : 'verified';
}

/** In-memory counters on the authed /health (the rollout evidence). */
export interface RelayUnknownSenderTrustCounters {
  /** Unknown-sender messages the check ran on. */
  evaluated: number;
  /** The held level may perform the operation. */
  allowed: number;
  /** Dry-run: would have been refused; delivered as today. */
  wouldRefuse: number;
  /** Enforcing: refused, not delivered. */
  refused: number;
  /** Dry-run: a first contact wrote a `verified` profile, marked `relayFirstContact` (enforcement would write none). */
  firstContactProfiles: number;
  /** The trust lookup threw. */
  lookupErrors: number;
  /** New fingerprint profiles created at `untrusted` because the check was enforcing. */
  profilesCreatedUntrusted: number;
}

export function createRelayUnknownSenderTrustCounters(): RelayUnknownSenderTrustCounters {
  return {
    evaluated: 0, allowed: 0, wouldRefuse: 0, refused: 0,
    firstContactProfiles: 0, lookupErrors: 0, profilesCreatedUntrusted: 0,
  };
}

/** Peer-supplied text is never logged raw: printable ASCII only, bounded. */
function logSafe(value: string): string {
  return value.replace(/[^\x21-\x7e]/g, '?').slice(0, 48) || 'unknown';
}

/** The one server-log line per would-refuse / refuse verdict. */
export function relayUnknownSenderTrustLogLine(
  kind: 'would-refuse' | 'refuse',
  fingerprint: string,
  v: RelayUnknownSenderVerdict,
): string {
  return `[relay-unknown-sender-trust] ${kind} fp=${logSafe(fingerprint).slice(0, 12)} profile=${v.hasProfile ? 'yes' : 'no'} trust=${v.level} op=${logSafe(v.operation)}`;
}

/** What `gate-passed` carries (the shape the server's relay consumer reads). */
export interface RelayUnknownSenderPassDecision {
  action: 'pass';
  reason: 'relay-authenticated' | 'probe';
  trustLevel: AgentTrustLevel;
  fingerprint: string;
  message: ReceivedMessage;
}

export interface RelayUnknownSenderHandlerDeps {
  trustManager: RelayUnknownSenderTrustManager;
  mode: () => RelayUnknownSenderTrustMode;
  counters: RelayUnknownSenderTrustCounters;
  emit: (decision: RelayUnknownSenderPassDecision) => void;
  log?: (line: string) => void;
}

export type RelayUnknownSenderOutcome =
  | 'passed-legacy'
  | 'passed-dry-run'
  | 'would-refuse-delivered'
  | 'passed'
  | 'refused'
  | 'refused-lookup-error';

/**
 * Handle one unknown-sender relay message after the payload-size check.
 *
 *  - off: exactly today's behaviour (record, emit `verified`).
 *  - dry-run: today's delivery, plus the verdict counted and logged.
 *  - enforcing: refuse when the held level may not perform the operation;
 *    otherwise emit the held level. The interaction is recorded only for a
 *    sender that already has a profile, so a stranger's probe writes nothing.
 */
export function handleRelayUnknownSender(
  deps: RelayUnknownSenderHandlerDeps,
  received: ReceivedMessage,
  wireType: unknown,
): RelayUnknownSenderOutcome {
  const { trustManager: tm, counters } = deps;
  const log = deps.log ?? ((line: string) => console.log(line));
  const fingerprint = received.from;
  const mode = deps.mode();

  const legacyDeliver = (): void => {
    // Evidence only: an unreadable profile counts as existing (no first-contact mark).
    let existed = true;
    try { existed = !!tm.getProfileByFingerprint(fingerprint); } catch { /* @silent-fallback-ok — counter evidence only */ }
    if (mode.enabled && !existed) {
      // Dry-run keeps today's profile write, but the profile is created already
      // marked (one atomic write — a crash cannot leave it unmarked), so neither
      // later dry-run verdicts nor enforcement count it as a grant.
      counters.firstContactProfiles++;
      try { tm.getOrCreateProfileByFingerprint(fingerprint, undefined, { relayFirstContact: true }); } catch { /* @silent-fallback-ok — the record below writes today's profile */ }
    }
    tm.recordMessageReceivedByFingerprint(fingerprint);
    deps.emit({ action: 'pass', reason: 'relay-authenticated', trustLevel: 'verified', fingerprint, message: received });
  };

  if (!mode.enabled) {
    legacyDeliver();
    return 'passed-legacy';
  }

  let verdict: RelayUnknownSenderVerdict;
  try {
    verdict = resolveRelayUnknownSenderTrust(tm, fingerprint, wireType);
  } catch (err) {
    counters.lookupErrors++;
    log(`[relay-unknown-sender-trust] lookup failed: ${err instanceof Error ? err.message : String(err)}`);
    if (mode.dryRun) {
      legacyDeliver();
      return 'passed-dry-run';
    }
    // Enforcing and the authority cannot answer: fail closed. The relay sender
    // gets no answer either way, exactly as for a gate block.
    return 'refused-lookup-error';
  }
  counters.evaluated++;

  if (mode.dryRun) {
    if (verdict.allowed) {
      counters.allowed++;
      legacyDeliver();
      return 'passed-dry-run';
    }
    counters.wouldRefuse++;
    log(relayUnknownSenderTrustLogLine('would-refuse', fingerprint, verdict));
    legacyDeliver();
    return 'would-refuse-delivered';
  }

  if (!verdict.allowed) {
    counters.refused++;
    log(relayUnknownSenderTrustLogLine('refuse', fingerprint, verdict));
    return 'refused';
  }
  counters.allowed++;
  if (verdict.hasProfile) tm.recordMessageReceivedByFingerprint(fingerprint);
  deps.emit({
    action: 'pass',
    reason: PROBE_OPS.has(verdict.operation) ? 'probe' : 'relay-authenticated',
    trustLevel: verdict.level,
    fingerprint,
    message: received,
  });
  return 'passed';
}

/**
 * Process-wide counters (one relay client per server process). The bootstrap
 * writes them; the authed /health reads them.
 */
export const relayUnknownSenderTrustCounters: RelayUnknownSenderTrustCounters = createRelayUnknownSenderTrustCounters();

/** Tests only: zero the process-wide counters. */
export function resetRelayUnknownSenderTrustCounters(): void {
  Object.assign(relayUnknownSenderTrustCounters, createRelayUnknownSenderTrustCounters());
}
