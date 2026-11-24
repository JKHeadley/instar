/**
 * SEC-133: the relay and registry login challenges are signed RAW with the agent identity key,
 * the same key that signs pair-verify receipts and handshake answers. A relay that chose the
 * challenge bytes could therefore get any of those signed. The real relay
 * (src/threadline/relay/ConnectionManager.ts) always sends 32 random bytes as base64: exactly 44
 * characters of the base64 alphabet ending in one '='. The agent signs only a challenge of that
 * shape, which no receipt, digest or envelope can take (they carry a context string, NUL and length
 * bytes, raw 32-byte digests, or JSON). This keeps every existing relay working, with no protocol
 * change. Binding the signature to the relay itself, so a challenge cannot be relayed from one
 * relay to another, needs a relay-side change and is its own step (commitment CMT-025).
 */
import { DegradationReporter } from '../../monitoring/DegradationReporter.js';

export const RELAY_CHALLENGE_RE = /^[A-Za-z0-9+/]{43}=$/;

export function isRelayChallengeNonce(nonce: unknown): nonce is string {
  return typeof nonce === 'string' && RELAY_CHALLENGE_RE.test(nonce) && Buffer.from(nonce, 'base64').length === 32;
}

/** Records a refused challenge where the operator can see it (health degradations), so a relay that keeps the agent off the network is visible. */
const REPORT_EVERY_MS = 10 * 60_000;
const lastReported = new Map<string, number>();

export function reportRefusedChallenge(where: 'relay' | 'registry', relayUrl: string, now: number = Date.now()): void {
  try {
    let host = 'unknown relay';
    try { host = new URL(relayUrl).host; } catch { /* @silent-fallback-ok — unparseable URL is named generically */ }
    // Throttled: a relay that always sends bad challenges is reported once per host per 10 minutes.
    const key = `${where}:${host}`;
    const last = lastReported.get(key);
    if (last !== undefined && now - last < REPORT_EVERY_MS) return;
    lastReported.set(key, now);
    if (lastReported.size > 256) lastReported.delete(lastReported.keys().next().value as string);
    DegradationReporter.getInstance().report({
      feature: where === 'relay' ? 'RelayClient.challengeRefused' : 'RegistryRestClient.challengeRefused',
      primary: 'Log in to the agent network relay',
      fallback: 'No signature is sent; the login is refused and retried later.',
      reason: `The relay at ${host} sent a login challenge that is not 32 random bytes.`,
      impact: 'This agent stays off that relay until it sends a real challenge. A relay doing this may be misbehaving or hostile.',
    });
  } catch { /* @silent-fallback-ok — reporting must never break the refusal */ }
}

/** Test seam: forget the throttle state. */
export function resetRefusedChallengeReportsForTesting(): void { lastReported.clear(); }
