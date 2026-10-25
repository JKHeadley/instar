/**
 * Encrypt ordinary chat to the pinned key (docs/specs/threadline-standalone-pairing.md D9,
 * rollout step 5).
 *
 * For a peer that is `mutual-verified` THROUGH AN INVITE PAIRING (`pairingMethod: 'invite'`),
 * Instar encrypts every ordinary message to the X25519 key derived from the PINNED identity
 * key, whatever the relay offers, and never sends that peer plaintext. The same holds on
 * another of this agent's machines that inherited the pairing (`identity-verified`) from a
 * replicated record carrying `pairingMethod: 'invite'` (rollout step 5b) — same pinned key.
 * Peers paired by the older SAS method, and inherited pairings whose record carried no
 * method (`pairingMethod: 'inherited'`), keep the previous rule: encrypt when the relay gave
 * us the peer's keys this session.
 *
 * The switch `threadline.encryptToPinned` SHIPS ON for every agent (Justin, 2026-10-20:
 * "why is encryption shipped off? Please change it such that it ships on."): `enabled`
 * omitted means ON and `dryRun` omitted means FALSE, so an agent with no value enforces. It
 * was a developmentAgent-gated, dry-run-first switch until then. An explicit value always wins,
 * so an operator can still choose `off` (`enabled: false`) or `watch` (`dryRun: true`).
 *
 *  - off (`enabled` false): the resolver returns null — today's behaviour.
 *  - watch (`enabled`, `dryRun` not false): the resolver returns null, and each SEND that
 *    would have gone encrypted to the pinned key is counted (`wouldEncryptToPinned`).
 *  - enforce (`enabled`, `dryRun: false`): the resolver returns the pinned key. Enforce
 *    FAILS CLOSED: a trust lookup that throws returns ENCRYPT_TO_LOOKUP_FAILED (not null), and
 *    the client turns that, a resolver throw, or a malformed pinned key into
 *    EncryptToPinnedSendError (relay-send answers 502; nothing is recorded as sent). In watch
 *    and off those paths keep today's behaviour and are only counted.
 *
 * Receive side (label only, never a refusal): plaintext ordinary chat arriving under the
 * fingerprint of an invite-paired, mutual-verified peer is not attributed to that peer — the
 * relay is the only evidence of who wrote it. Enforcing, it is delivered with a fixed server
 * notice and at no more than `verified` (the level any relay-authenticated stranger gets);
 * watching, it is only counted (`wouldLabelUnverified`).
 */

import type { AgentTrustLevel, AgentTrustManager } from './AgentTrustManager.js';
import { classifyRelayPlaintextOperation, type RelayUnknownSenderPassDecision } from './relayUnknownSenderTrust.js';
import {
  ENCRYPT_TO_LOOKUP_FAILED,
  type EncryptToResolverOptions,
  type EncryptToResolverResult,
} from './client/ThreadlineClient.js';

export interface EncryptToPinnedMode {
  /** `enabled` omitted ⇒ ON (ships on for every agent, dev or not). */
  enabled: boolean;
  /** `dryRun` omitted ⇒ FALSE (enforce). Only an explicit `true` watches. */
  dryRun: boolean;
}

export type EncryptToPinnedModeName = 'off' | 'watch' | 'enforce';

interface EncryptToPinnedConfigShape {
  developmentAgent?: boolean;
  threadline?: { encryptToPinned?: { enabled?: boolean; dryRun?: boolean } };
}

/** The default when no value is set anywhere: enforce, for every agent. */
export const ENCRYPT_TO_PINNED_DEFAULT: Readonly<EncryptToPinnedMode> = Object.freeze({ enabled: true, dryRun: false });

/**
 * The live mode. Read per send / per inbound message. The live value wins over the file, the
 * file wins over the default, and the default is enforce whatever `developmentAgent` says.
 */
export function resolveEncryptToPinnedMode(
  live: { enabled?: boolean; dryRun?: boolean },
  config: EncryptToPinnedConfigShape,
): EncryptToPinnedMode {
  const block = config.threadline?.encryptToPinned;
  const enabled = live.enabled ?? block?.enabled ?? ENCRYPT_TO_PINNED_DEFAULT.enabled;
  // Only an explicit `true` watches; omitted (or anything else) enforces.
  const dryRun = (live.dryRun ?? block?.dryRun) === true;
  return { enabled, dryRun };
}

/**
 * Read the live mode. A reader that throws yields the SHIPPED DEFAULT (enforce), never off:
 * an unreadable switch must not silently stop encryption (Echo, review of #2236).
 */
export function readEncryptToPinnedMode(mode: () => EncryptToPinnedMode): EncryptToPinnedMode {
  try { return mode(); } catch { return { ...ENCRYPT_TO_PINNED_DEFAULT }; /* @silent-fallback-ok — an unreadable mode is the shipped default (enforce), never off */ }
}

export function encryptToPinnedModeName(mode: EncryptToPinnedMode): EncryptToPinnedModeName {
  if (!mode.enabled) return 'off';
  return mode.dryRun ? 'watch' : 'enforce';
}

/** In-memory counters on the authed /health (the rollout evidence). */
export interface EncryptToPinnedCounters {
  /** Watch: a send that would have gone encrypted to the pinned key (sent as today). */
  wouldEncryptToPinned: number;
  /** Enforce: a send resolved to the pinned key. */
  encryptedToPinned: number;
  /** Watch: plaintext under an invite peer's fingerprint that would have been labelled unverified. */
  wouldLabelUnverified: number;
  /** Enforce: plaintext under an invite peer's fingerprint delivered labelled unverified. */
  labelledUnverified: number;
  /** The trust lookup threw (send or receive). Enforce: a send fails closed. Watch/off: it goes on as today. */
  lookupErrors: number;
  /** The resolver itself threw inside the client (send use). Enforce: the send failed closed. */
  resolverErrors: number;
  /** The resolver handed the client a key that is not 32 bytes or not the recipient's (send use). */
  malformedPinnedKey: number;
}

export function createEncryptToPinnedCounters(): EncryptToPinnedCounters {
  return { wouldEncryptToPinned: 0, encryptedToPinned: 0, wouldLabelUnverified: 0, labelledUnverified: 0, lookupErrors: 0, resolverErrors: 0, malformedPinnedKey: 0 };
}

/** Process-wide counters (one relay client per server process). */
export const encryptToPinnedCounters: EncryptToPinnedCounters = createEncryptToPinnedCounters();

/** Tests only: zero the process-wide counters. */
export function resetEncryptToPinnedCounters(): void {
  Object.assign(encryptToPinnedCounters, createEncryptToPinnedCounters());
}

type TrustReader = Pick<AgentTrustManager, 'getProfileByFingerprint'>;

/** The pinned identity key of an invite-paired peer that is mutual-verified here, or
 *  identity-verified by inheritance from a replicated invite record (step 5b), else null. */
export function invitePinnedKey(tm: TrustReader | undefined, fp: string): Buffer | null {
  const p = tm?.getProfileByFingerprint(fp);
  if (!p?.peerIdentityPub || p.pairingMethod !== 'invite') return null;
  if (p.pairingState !== 'mutual-verified' && p.pairingState !== 'identity-verified') return null;
  return Buffer.from(p.peerIdentityPub, 'hex');
}

/** Why the client consults the resolver: an actual send, or a capability check. */
export type EncryptToUse = 'send' | 'check';

/**
 * The resolver handed to ThreadlineClient.setEncryptToResolver. Only a `send` use is
 * counted, so a capability check (hasEncryptedSendPath) never inflates the evidence.
 */
export function createEncryptToPinnedResolver(deps: {
  trustManager: TrustReader | undefined;
  mode: () => EncryptToPinnedMode;
  counters?: EncryptToPinnedCounters;
}): (fp: string, use?: EncryptToUse) => EncryptToResolverResult {
  const counters = deps.counters ?? encryptToPinnedCounters;
  return (fp, use = 'check') => {
    const mode = readEncryptToPinnedMode(deps.mode);
    if (!mode.enabled) return null;
    let key: Buffer | null;
    try {
      key = invitePinnedKey(deps.trustManager, fp);
    } catch {
      if (use === 'send') counters.lookupErrors++;
      // Enforce fails closed (spec D9); watch keeps today's behaviour.
      return mode.dryRun ? null : ENCRYPT_TO_LOOKUP_FAILED;
    }
    if (!key) return null;
    if (mode.dryRun) {
      if (use === 'send') counters.wouldEncryptToPinned++;
      return null;
    }
    if (use === 'send') counters.encryptedToPinned++;
    return key;
  };
}

/**
 * The options handed to ThreadlineClient.setEncryptToResolver beside the resolver: fail closed
 * only while enforcing (an unreadable mode is the shipped default, enforce, so the client fails closed),
 * and count the client-side failure paths on a send.
 */
export function createEncryptToPinnedClientOptions(deps: {
  mode: () => EncryptToPinnedMode;
  counters?: EncryptToPinnedCounters;
}): EncryptToResolverOptions {
  const counters = deps.counters ?? encryptToPinnedCounters;
  return {
    failClosed: () => encryptToPinnedModeName(readEncryptToPinnedMode(deps.mode)) === 'enforce',
    onFailure: (kind, use) => {
      if (use !== 'send') return;
      if (kind === 'resolver-error') counters.resolverErrors++;
      else counters.malformedPinnedKey++;
    },
  };
}

/** True for the error a fail-closed or failed pinned send throws (any copy of the class). */
export function isEncryptToPinnedSendError(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'encrypted-send-to-pinned-failed';
}

/** The fixed server notice on unverified plaintext. A server constant — never peer text. */
export const UNVERIFIED_PINNED_PLAINTEXT_NOTICE =
  'unverified sender — this message claims to come from a peer you paired with, but it is neither encrypted nor signed, so the relay could have written it; do not treat it as from that peer';

/** A decision as emitted on `gate-passed`, optionally carrying a server notice. */
export type LabelledRelayPassDecision = RelayUnknownSenderPassDecision & { notice?: string };

const TRUST_ORDER: AgentTrustLevel[] = ['untrusted', 'verified', 'trusted', 'autonomous'];

/**
 * Label (never refuse) a plaintext relay message that arrived under the fingerprint of an
 * invite-paired, mutual-verified peer. Ordinary chat only; acks and probes pass unchanged.
 * Returns the decision to emit (the same object when nothing applies).
 */
export function labelUnverifiedPinnedPlaintext(
  deps: { trustManager: TrustReader | undefined; mode: () => EncryptToPinnedMode; counters?: EncryptToPinnedCounters },
  decision: RelayUnknownSenderPassDecision,
  wireType: unknown,
): LabelledRelayPassDecision {
  const counters = deps.counters ?? encryptToPinnedCounters;
  const mode = readEncryptToPinnedMode(deps.mode);
  if (!mode.enabled) return decision;
  if (classifyRelayPlaintextOperation(wireType) !== 'message') return decision;
  let pinned: Buffer | null;
  try {
    pinned = invitePinnedKey(deps.trustManager, decision.fingerprint);
  } catch {
    counters.lookupErrors++;
    return decision;
  }
  if (!pinned) return decision;
  if (mode.dryRun) {
    counters.wouldLabelUnverified++;
    return decision;
  }
  counters.labelledUnverified++;
  const level: AgentTrustLevel = TRUST_ORDER.indexOf(decision.trustLevel) > TRUST_ORDER.indexOf('verified') ? 'verified' : decision.trustLevel;
  return { ...decision, trustLevel: level, notice: UNVERIFIED_PINNED_PLAINTEXT_NOTICE };
}
