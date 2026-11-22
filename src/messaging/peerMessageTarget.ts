/** N73: a nonce-bound signed recipient generation, observed before message creation.
 * Uses the canonical peer registry and existing machine-auth/relay-answer protocol;
 * no bearer token, HTTPS assumption, clock-offset estimate or new key is needed.
 */
import crypto from 'node:crypto';
import { signRequest, verifyRelayAnswer, type RelayAnswer } from '../server/machineAuth.js';
import { MESSAGE_GENERATION_PATH } from './types.js';
import type { PoolPeerTarget } from '../server/poolPeerFetch.js';

export type PeerMessageGeneration = { sessionId: string } | { reason: string };
export interface MessageGenerationObservation { target: string; sessionId: string | null; observedAt: number; }

/** Reuse relay-answer signing without pretending its serializer signs extra fields.
 * Its messageId binds this domain-separated digest of EVERY observation field.
 */
export function generationProofId(observation: MessageGenerationObservation): string {
  return 'session-generation-v1:' + crypto.createHash('sha256')
    .update(JSON.stringify([observation.target, observation.sessionId, observation.observedAt])).digest('hex');
}

export async function readPeerMessageGeneration(input: {
  peer: PoolPeerTarget | null;
  target: string;
  selfMachine: string;
  signingKeyPem: string;
  peerPublicKeyPem: string | null;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<PeerMessageGeneration> {
  if (!input.peer || !input.peerPublicKeyPem) return { reason: 'receiving machine identity or registered address is unavailable' };
  const peer = input.peer;
  const urls = [...new Set([peer.url, ...(peer.ropes ?? []).map((r) => r.url)])].filter((u) => {
    try { return ['http:', 'https:'].includes(new URL(u).protocol); }
    catch { return false; } // @silent-fallback-ok: an invalid registry address supplies no proof
  });
  const budgetMs = input.timeoutMs ?? 5_000;
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) return { reason: 'recipient generation check deadline expired' };
  const deadline = performance.now() + budgetMs;
  const totalSignal = AbortSignal.timeout(Math.ceil(budgetMs));
  let lastReason = 'the receiving machine session check did not finish';
  for (const [index, url] of urls.entries()) {
    const remaining = deadline - performance.now();
    if (remaining <= 0 || totalSignal.aborted) break;
    // Preserve an opportunity for each remaining registered rope; one hung
    // address must not consume the whole read budget before alternatives run.
    const signal = AbortSignal.any([totalSignal, AbortSignal.timeout(Math.max(1, Math.ceil(remaining / (urls.length - index))))]);
    const body = { target: input.target };
    const headers = signRequest(input.selfMachine, input.signingKeyPem, body);
    try {
      const response = await (input.fetchImpl ?? fetch)(url.replace(/\/$/, '') + MESSAGE_GENERATION_PATH, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
        redirect: 'manual', signal,
      });
      // Unsigned statuses and redirects do not identify the peer. Try the next
      // registered rope with a fresh nonce; never follow a redirect.
      if (!response.ok) { lastReason = `receiving machine could not prove its session generation (HTTP ${response.status})`; continue; }
      const text = await boundedGenerationBody(response);
      if (text === null) { lastReason = 'receiving generation proof exceeded its wire envelope'; continue; }
      const answer = JSON.parse(text) as { observation?: MessageGenerationObservation; ack?: RelayAnswer; sig?: string };
      const observation = answer.observation;
      if (!observation || observation.target !== input.target || !Number.isSafeInteger(observation.observedAt)
        || (observation.sessionId !== null && (typeof observation.sessionId !== 'string' || observation.sessionId.length < 1 || observation.sessionId.length > 200))) {
        lastReason = 'receiving machine supplied an invalid session-generation observation'; continue;
      }
      if (verifyRelayAnswer(answer.ack, answer.sig, peer.machineId, generationProofId(observation), headers['X-Nonce'], input.peerPublicKeyPem) !== 'ack') {
        lastReason = 'receiving session-generation proof did not match its machine, target or request'; continue;
      }
      return observation.sessionId ? { sessionId: observation.sessionId } : { reason: 'receiving machine has no unique running session for that role' };
    } catch {
      // @silent-fallback-ok: another registered rope may work, within ONE shared timeout
      if (totalSignal.aborted) break;
    }
  }
  return { reason: lastReason };
}

/** Wire metadata has two <=200-character fields, bounded machine/nonce/digest,
 * timestamp and Ed25519 signature; 4 KiB exceeds their complete encoding budget. */
async function boundedGenerationBody(response: Response): Promise<string | null> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 4096) { await reader.cancel(); return null; }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { reader.releaseLock(); }
}
