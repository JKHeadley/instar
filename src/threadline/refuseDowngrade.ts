/**
 * Refuse a downgrade after encrypted chat (docs/specs/threadline-standalone-pairing.md D6/D11,
 * rollout step 6).
 *
 * The first time a peer that is paired BY INVITE (`pairingMethod: 'invite'`, `mutual-verified`
 * here or `identity-verified` by inheritance) sends us ENCRYPTED ordinary chat, verified against
 * its pinned key, the trust profile records `encryptedSeenAt`. From then on, plaintext arriving
 * under that peer's fingerprint can only be the relay's word, and a relay that strips encryption
 * from a peer that has spoken to us encrypted is downgrading it. With the switch enforcing, that
 * plaintext is refused (never delivered, never answered). Pairing ops and credentials never set
 * the mark: they are encrypted from every version. Peers paired by SAS, and inherited pairings
 * whose record carried no method, keep the previous rule (step 5's unverified label, if on).
 *
 * The mark is one record for the whole agent: set once, merged across this agent's machines as a
 * union keeping the earliest time, removed only when the person unpairs (see
 * pairingReplicationWiring.ts and threadline-core's encryptedSeen.ts). A mark kept on one machine
 * would let the relay downgrade a peer by aiming at whichever machine takes over.
 *
 * The switch `threadline.refuseDowngrade` follows `threadline.encryptToPinned` exactly:
 * `enabled` omitted rides the developmentAgent gate, `dryRun` defaults TRUE.
 *
 *  - off (`enabled` false): nothing is recorded and nothing is refused — today's behaviour.
 *  - watch (`enabled`, `dryRun` not false): marks are recorded (and replicated); plaintext that
 *    would have been refused is counted (`wouldRefuseDowngrade`) and delivered as today.
 *  - enforce (`enabled`, `dryRun: false`): that plaintext is refused (`refusedDowngrade`).
 *
 * Rollback: set the switch to off. Marks already recorded stay in the trust profiles (they are
 * only read while the switch is on), so turning it back on resumes the same protection.
 */

import { resolveDevAgentGate } from '../core/devAgentGate.js';
import type { AgentTrustManager } from './AgentTrustManager.js';
import { invitePinnedKey } from './encryptToPinned.js';
import { classifyRelayPlaintextOperation } from './relayUnknownSenderTrust.js';

export interface RefuseDowngradeMode {
  /** Gate-resolved: `enabled` omitted ⇒ the developmentAgent gate decides. */
  enabled: boolean;
  /** Default TRUE: count would-refuse, deliver as today. */
  dryRun: boolean;
}

export type RefuseDowngradeModeName = 'off' | 'watch' | 'enforce';

interface RefuseDowngradeConfigShape {
  developmentAgent?: boolean;
  threadline?: { refuseDowngrade?: { enabled?: boolean; dryRun?: boolean } };
}

/** The live mode. Read per inbound message. */
export function resolveRefuseDowngradeMode(
  live: { enabled?: boolean; dryRun?: boolean },
  config: RefuseDowngradeConfigShape,
): RefuseDowngradeMode {
  const block = config.threadline?.refuseDowngrade;
  const enabled = resolveDevAgentGate(live.enabled ?? block?.enabled, config);
  // Only an explicit `false` leaves dry-run; anything else observes.
  const dryRun = (live.dryRun ?? block?.dryRun) !== false;
  return { enabled, dryRun };
}

export function refuseDowngradeModeName(mode: RefuseDowngradeMode): RefuseDowngradeModeName {
  if (!mode.enabled) return 'off';
  return mode.dryRun ? 'watch' : 'enforce';
}

/** In-memory counters on the authed /health (the rollout evidence). */
export interface RefuseDowngradeCounters {
  /** A mark was newly recorded on this machine (first encrypted chat from an invite peer). */
  marksRecorded: number;
  /** Watch: plaintext under a marked invite peer's fingerprint that would have been refused (delivered). */
  wouldRefuseDowngrade: number;
  /** Enforce: plaintext under a marked invite peer's fingerprint, refused. */
  refusedDowngrade: number;
  /** The trust lookup or write threw. Marking: the message went on as today. Refusing: treated
   *  as seen (fail closed while enforcing). */
  lookupErrors: number;
}

export function createRefuseDowngradeCounters(): RefuseDowngradeCounters {
  return { marksRecorded: 0, wouldRefuseDowngrade: 0, refusedDowngrade: 0, lookupErrors: 0 };
}

/** Process-wide counters (one relay client per server process). */
export const refuseDowngradeCounters: RefuseDowngradeCounters = createRefuseDowngradeCounters();

/** Tests only: zero the process-wide counters. */
export function resetRefuseDowngradeCounters(): void {
  Object.assign(refuseDowngradeCounters, createRefuseDowngradeCounters());
}

type TrustReader = Pick<AgentTrustManager, 'getProfileByFingerprint'>;
type TrustMarker = TrustReader & Pick<AgentTrustManager, 'markEncryptedSeen'>;

export interface RefuseDowngradeDeps<T> {
  trustManager: T | undefined;
  mode: () => RefuseDowngradeMode;
  counters?: RefuseDowngradeCounters;
}

function readMode(mode: () => RefuseDowngradeMode): RefuseDowngradeMode {
  try { return mode(); } catch { return { enabled: false, dryRun: true }; /* @silent-fallback-ok — an unreadable mode is today's behaviour (off) */ }
}

/**
 * An ENCRYPTED message arrived and was verified (ThreadlineClient 'message'). Record the mark when
 * it is ordinary chat from an invite peer and the key that verified it is the PINNED key. Off:
 * nothing. Returns true when a mark was newly recorded.
 */
export function noteEncryptedChat(
  deps: RefuseDowngradeDeps<TrustMarker>,
  msg: { from: string; content?: { type?: unknown } | null; senderIdentityPub?: Buffer },
): boolean {
  const counters = deps.counters ?? refuseDowngradeCounters;
  if (!readMode(deps.mode).enabled) return false;
  if (classifyRelayPlaintextOperation(msg.content?.type) !== 'message') return false; // ordinary chat only
  try {
    const fp = String(msg.from || '').toLowerCase();
    const pinned = invitePinnedKey(deps.trustManager, fp);
    if (!pinned || !msg.senderIdentityPub || !pinned.equals(msg.senderIdentityPub)) return false;
    const before = deps.trustManager!.getProfileByFingerprint(fp)?.encryptedSeenAt;
    if (before) return false;
    const ok = deps.trustManager!.markEncryptedSeen(fp, pinned.toString('hex'));
    if (ok) counters.marksRecorded++;
    return ok;
  } catch {
    counters.lookupErrors++;
    return false;
  }
}

/**
 * Plaintext arrived under `fingerprint` (the relay's word). Should it be refused as a downgrade?
 * True only when enforcing, the operation is not a delivery ack, the fingerprint belongs to an
 * invite peer, and that peer's profile carries the encryptedSeen mark. Watch counts and returns
 * false; off returns false without reading anything.
 */
export function shouldRefuseDowngradedPlaintext(
  deps: RefuseDowngradeDeps<TrustReader>,
  fingerprint: string,
  wireType: unknown,
): boolean {
  const counters = deps.counters ?? refuseDowngradeCounters;
  const mode = readMode(deps.mode);
  if (!mode.enabled) return false;
  if (classifyRelayPlaintextOperation(wireType) === 'ack') return false;
  let marked: boolean;
  try {
    const fp = String(fingerprint || '').toLowerCase();
    marked = !!invitePinnedKey(deps.trustManager, fp) && !!deps.trustManager!.getProfileByFingerprint(fp)?.encryptedSeenAt;
  } catch {
    // The spec's decision table: the mark cannot be read → treat the peer as seen (fail closed).
    // We cannot tell which peer is pinned, so while enforcing, plaintext is refused until the
    // trust store answers again; watching, it is counted and delivered.
    counters.lookupErrors++;
    marked = true;
  }
  if (!marked) return false;
  if (mode.dryRun) {
    counters.wouldRefuseDowngrade++;
    return false;
  }
  counters.refusedDowngrade++;
  return true;
}
