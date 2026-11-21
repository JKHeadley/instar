/**
 * Cross-machine relay, phase 1 (spec docs/specs/messages-reach-renamed-sessions.md §D).
 *
 * One queue per target machine. Each envelope gets ONE pass over the target's guarded
 * addresses, one request at a time, with the existing 10s timeout per address:
 *   - a signed `relay-ack-v1` from the target → `received`;
 *   - a signed `relay-nack-v1` from the target → `failed` with its code;
 *   - anything else (an unsigned answer of any status, an ack that does not verify, a
 *     connect failure, a timeout) proves nothing about who answered → next address.
 * After the last address the envelope is `failed` with every address's outcome. Two
 * readings are named, never treated as proof: an ack-less 2xx ("a server stored it
 * without confirming") and any timeout ("unconfirmed: may have arrived").
 * No retries in phase 1 (retries for a machine that is away are phase 2).
 */

import type { MessageEnvelope } from './types.js';
import { RELAY_MACHINE_PATH } from './types.js';
import { verifyRelayAnswer, type RelayAnswer } from '../server/machineAuth.js';

export const RELAY_ATTEMPT_TIMEOUT_MS = 10_000;

/** The relay route's JSON answer: a signed ack or nack. */
export interface RelayResponseBody { ack?: RelayAnswer; nack?: RelayAnswer; sig?: string; error?: string; code?: string }

export type RelayPassOutcome =
  | { kind: 'received'; via: string }
  | { kind: 'refused'; code: string; via: string }
  | { kind: 'unreachable'; reason: string };

export interface CrossMachineRelayQueueDeps {
  localMachine: string;
  /** Guarded addresses for a machine, best first. Empty ⇒ fail at once. */
  addressesFor: (machineId: string) => string[];
  /** Re-sign the envelope for this attempt (fresh timestamp + current age). */
  resignForAttempt: (envelope: MessageEnvelope) => void;
  /** Machine-auth request headers for this body. */
  signRequestHeaders: (body: unknown) => Record<string, string>;
  /** The target's signing public key, or null when unknown. */
  peerPublicKey: (machineId: string) => string | null;
  /** The pass ended: persist the phase, notify. Never throws. */
  onOutcome: (envelope: MessageEnvelope, outcome: RelayPassOutcome) => Promise<void>;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
}

export class CrossMachineRelayQueue {
  private readonly queues = new Map<string, MessageEnvelope[]>();
  private readonly running = new Set<string>();
  private readonly fetchImpl: typeof fetch;
  private started = false;
  private readonly pendingBeforeStart: MessageEnvelope[] = [];

  constructor(private readonly deps: CrossMachineRelayQueueDeps) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  /** Begin draining (called after the mesh block has set up peer addresses). */
  start(): void {
    if (this.started) return;
    this.started = true;
    for (const env of this.pendingBeforeStart.splice(0)) this.enqueue(env);
  }

  enqueue(envelope: MessageEnvelope): void {
    if (!this.started) { this.pendingBeforeStart.push(envelope); return; }
    const machine = envelope.message.to.machine;
    const q = this.queues.get(machine) ?? [];
    q.push(envelope);
    this.queues.set(machine, q);
    void this.drain(machine);
  }

  /** Waiting envelopes per machine (observability). */
  depth(): Record<string, number> {
    return Object.fromEntries([...this.queues].map(([m, q]) => [m, q.length + (this.running.has(m) ? 1 : 0)]));
  }

  private async drain(machine: string): Promise<void> {
    if (this.running.has(machine)) return;
    this.running.add(machine);
    try {
      const q = this.queues.get(machine) ?? [];
      while (q.length > 0) {
        const env = q.shift()!;
        let outcome: RelayPassOutcome;
        try { outcome = await this.onePass(env); } catch (err) {
          outcome = { kind: 'unreachable', reason: `relay error: ${err instanceof Error ? err.message : String(err)}` };
        }
        try { await this.deps.onOutcome(env, outcome); } catch (err) {
          this.deps.log?.(`[relay-queue] outcome handling failed for ${env.message.id}: ${err instanceof Error ? err.message : err}`);
        }
      }
      this.queues.delete(machine);
    } finally {
      this.running.delete(machine);
    }
  }

  /** One pass over the target's addresses. Exported for tests through the class. */
  async onePass(envelope: MessageEnvelope): Promise<RelayPassOutcome> {
    const machine = envelope.message.to.machine;
    const addresses = this.deps.addressesFor(machine);
    if (addresses.length === 0) return { kind: 'unreachable', reason: `no usable address for ${machine}` };
    const peerKey = this.deps.peerPublicKey(machine);
    const readings: string[] = [];
    let timedOut = false;
    let acklessSuccess = false;
    for (const base of addresses) {
      this.deps.resignForAttempt(envelope);
      const headers = this.deps.signRequestHeaders(envelope);
      const reqNonce = headers['X-Nonce'];
      let status = 0;
      let body: RelayResponseBody | null = null;
      try {
        const res = await this.fetchImpl(`${base.replace(/\/+$/, '')}${RELAY_MACHINE_PATH}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...headers },
          body: JSON.stringify(envelope),
          signal: AbortSignal.timeout(RELAY_ATTEMPT_TIMEOUT_MS),
        });
        status = res.status;
        try { body = (await res.json()) as RelayResponseBody; } catch { body = null; } // @silent-fallback-ok: a non-JSON body is an unsigned answer; the pass moves on
      } catch (err) {
        const name = err instanceof Error ? err.name : '';
        if (name === 'TimeoutError' || name === 'AbortError') { timedOut = true; readings.push(`${base}: timed out`); }
        else readings.push(`${base}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      if (peerKey && body) {
        const answer = body.ack ?? body.nack;
        const verdict = verifyRelayAnswer(answer, body.sig, machine, envelope.message.id, reqNonce, peerKey);
        if (verdict === 'ack' && status >= 200 && status < 300) return { kind: 'received', via: base };
        if (verdict === 'nack') return { kind: 'refused', code: answer!.code!, via: base };
      }
      if (status >= 200 && status < 300) acklessSuccess = true;
      readings.push(`${base}: HTTP ${status}${body ? '' : ' (no JSON)'} without a verified answer`);
    }
    const notes: string[] = [];
    if (acklessSuccess) notes.push(`a server stored it without confirming (an older version of ${machine}, or something in between)`);
    const prefix = timedOut ? 'unconfirmed: may have arrived; ' : '';
    return { kind: 'unreachable', reason: `${prefix}${machine} not reachable now (resend later)${notes.length ? `; ${notes.join('; ')}` : ''} [${readings.join(' | ')}]` };
  }
}
