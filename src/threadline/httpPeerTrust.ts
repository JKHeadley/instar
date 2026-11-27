/**
 * HTTP peer trust (docs/specs/threadline-http-peer-trust.md).
 *
 * The direct HTTP peer path (`/threadline/handshake/*` then
 * `/threadline/messages/receive`) proves that a sender holds the private key it
 * paired with. Like the relay, it does not prove who the sender is, and a
 * handshake is not a grant. This module decides whether a message on that path
 * may go on to the router, using the SAME trust resolver the relay's
 * unknown-sender check uses (`resolveRelayUnknownSenderTrust`): the trust
 * manager stays the one authority for level → operations.
 *
 * A message is admitted only when the sender's fingerprint holds a level that
 * allows the operation. Everything else is refused before any session, thread
 * record or ack. A pairing made over this handshake, before or after this
 * check shipped, is not evidence of who the sender is, so it grants nothing.
 */

import type { AgentTrustLevel } from './AgentTrustManager.js';
import type { RelayUnknownSenderVerdict } from './relayUnknownSenderTrust.js';
import { resolveRelayUnknownSenderTrust, type RelayUnknownSenderTrustManager } from './relayUnknownSenderTrust.js';

export interface HttpPeerTrustDeps {
  /** Live switch. Absent ⇒ on. Only an explicit `false` turns the check off (the previous behaviour). */
  enabled?: () => boolean;
  /**
   * The sender's verdict from the trust manager, or null when no trust manager is
   * available. Absent ⇒ no trust source (every sender is refused).
   */
  resolve?: (fingerprint: string, wireType: unknown) => RelayUnknownSenderVerdict | null;
}

export type HttpPeerAdmission =
  | { admit: true; reason: 'disabled' | 'trusted'; level?: AgentTrustLevel }
  | { admit: false; reason: 'no-verified-principal' | 'no-trust-source' | 'not-trusted'; level?: AgentTrustLevel };

export function decideHttpPeerAdmission(input: {
  deps: HttpPeerTrustDeps | undefined;
  fingerprint: string | undefined;
  wireType: unknown;
}): HttpPeerAdmission {
  const { deps, fingerprint, wireType } = input;
  let enabled = true;
  try {
    enabled = deps?.enabled ? deps.enabled() !== false : true;
  } catch {
    enabled = true; // @silent-fallback-ok — an unreadable switch keeps the check on (never silently off)
  }
  if (!enabled) return { admit: true, reason: 'disabled' };
  if (!fingerprint) return { admit: false, reason: 'no-verified-principal' };
  let verdict: RelayUnknownSenderVerdict | null = null;
  try {
    verdict = deps?.resolve ? deps.resolve(fingerprint, wireType) : null;
  } catch {
    verdict = null; // @silent-fallback-ok — an unreadable trust source refuses (fails closed), never admits
  }
  if (!verdict) return { admit: false, reason: 'no-trust-source' };
  if (verdict.allowed) return { admit: true, reason: 'trusted', level: verdict.level };
  return { admit: false, reason: 'not-trusted', level: verdict.level };
}

/**
 * Trust sources that are a DECISION: the owner granted the level, a paired machine
 * granted it, or an out-of-band verified pairing set it. Anything else, including
 * `setup-default` (written when a stranger's message was merely recorded) and any
 * source added later, is not a grant on this path until it is listed here.
 */
const DECIDED_TRUST_SOURCES: ReadonlySet<string> = new Set(['user-granted', 'paired-machine-granted', 'mutual-verified', 'agent-proposal']);

/**
 * The sender's verdict on this path. The trust manager decides, through the SAME
 * resolver as the relay path, with two differences:
 *   1. only a profile whose source is a decision (DECIDED_TRUST_SOURCES) counts;
 *   2. EVERY message is checked at the level that may send a message, a delivery ack
 *      included. The relay lets any level ack because there an ack only confirms our
 *      own earlier send; here an ack names any thread and updates its records, so it
 *      needs a grant too. `operation` therefore never weakens the check — it is taken
 *      for the resolver interface and always asked as a message.
 */
export function resolveHttpPeerTrust(
  tm: Pick<RelayUnknownSenderTrustManager, 'getProfileByFingerprint' | 'getAllowedOperationsByFingerprint'>,
  fingerprint: string,
  _operation?: string,
): RelayUnknownSenderVerdict {
  const decidedOnly = {
    getProfileByFingerprint: (fp: string) => {
      const p = tm.getProfileByFingerprint(fp);
      return p && DECIDED_TRUST_SOURCES.has(p.source) ? p : null;
    },
    getAllowedOperationsByFingerprint: (fp: string) => tm.getAllowedOperationsByFingerprint(fp),
  } as Pick<RelayUnknownSenderTrustManager, 'getProfileByFingerprint' | 'getAllowedOperationsByFingerprint'>;
  // On this path even an ack needs the level that may send a message. The relay lets
  // every level ack because there an ack only records that OUR earlier send arrived;
  // here an ack names any thread id and updates delivery and liveness records for that
  // thread, so a sender with no grant may not send one either.
  return resolveRelayUnknownSenderTrust(decidedOnly, fingerprint, 'chat');
}

/** Process-lifetime counters, served on the authed /health detail. Never peer-visible. */
export const httpPeerTrustCounters = {
  since: new Date().toISOString(),
  admitted: 0,
  admittedSwitchOff: 0,
  refusedNoPrincipal: 0,
  refusedNoTrustSource: 0,
  refusedNotTrusted: 0,
};

export function countHttpPeerAdmission(a: HttpPeerAdmission): void {
  if (a.admit) {
    if (a.reason === 'disabled') httpPeerTrustCounters.admittedSwitchOff++;
    else httpPeerTrustCounters.admitted++;
    return;
  }
  if (a.reason === 'no-verified-principal') httpPeerTrustCounters.refusedNoPrincipal++;
  else if (a.reason === 'no-trust-source') httpPeerTrustCounters.refusedNoTrustSource++;
  else httpPeerTrustCounters.refusedNotTrusted++;
}
