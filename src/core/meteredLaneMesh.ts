/**
 * meteredLaneMesh — one spender, one shared cap, on a multi-machine agent
 * (docs/specs/gemini-payg-metered-lane.md §6). Transport-independent: every network
 * hop is an injected `send(machineId, command)` (the signed MeshRpc client, which
 * already tries the mesh rope and then the holder's tunnel with the same envelope).
 *
 * Three pieces:
 *   1. HolderCallStore — on the designated machine: accepts forwarded calls
 *      (`metered-gemini-call`), runs each ONCE per callId, keeps results for 30 minutes
 *      under a 64 MB cap (oldest evicted first), and answers polls
 *      (`metered-gemini-result`) only to the holder of the origin-generated result token.
 *      After eviction or a restart a poll answers `settled-result-lost` — it NEVER
 *      re-dispatches. A dispatch is idempotent by callId through the ledger's dedupe.
 *   2. forwardMeteredCall — on any other machine: submit, then poll with 2s→10s backoff
 *      until the derived deadline (+60s); a timeout returns `holder-timeout` with the
 *      callId so a later poll can still collect. Never a local spend.
 *   3. DesignationEchoTracker — on the holder: every 10s sends `designation-echo` with a
 *      fresh nonce to each peer; a confirmation counts only when an echo of a nonce
 *      issued in the current window comes back, timed on the HOLDER's own clock.
 *      `leaseConfirmedAgoMs()` replaces the `poolOn ? null` stub. A backed claim naming
 *      a DIFFERENT machine with a NEWER designationEpoch freezes this holder.
 */

import crypto from 'node:crypto';

// ── Shared ─────────────────────────────────────────────────────────────

export type MeteredSend = (machineId: string, command: Record<string, unknown>, opts?: { timeoutMs?: number }) => Promise<unknown>;

/** Map a transport refusal from an OLD peer (unknown verb) to `peer-version` (§6). */
export function classifyForwardFailure(err: unknown): 'peer-version' | 'holder-unreachable' {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return /claim-unauthorized|unknown command|unknown-command|unsupported command/i.test(msg) ? 'peer-version' : 'holder-unreachable';
}

export function sha256Hex(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

// ── 1. Holder call store ───────────────────────────────────────────────

export const HOLDER_RESULT_RETENTION_MS = 30 * 60 * 1000;
export const HOLDER_RESULT_MAX_BYTES = 64 * 1024 * 1024;

export type ForwardOp = 'spec-review' | 'second-opinion' | 'release-proof-forward';

export interface ForwardedCall {
  op: ForwardOp;
  originMachine: string;
  session: string;
  callId: string;
  requestSha256: string;
  /** sha256 of the origin-generated result token; the token itself never travels here. */
  resultTokenHash: string;
  /** The call payload (prompt, model, sizes, E1 binding). */
  payload: Record<string, unknown>;
}

export type HolderCallState =
  | { state: 'running'; callId: string }
  | { state: 'done'; callId: string; status: number; body: unknown }
  | { state: 'settled-result-lost'; callId: string; bookedUsd: number | null }
  | { state: 'not-yours'; callId: string }
  | { state: 'callid-conflict'; callId: string }
  | { state: 'unknown'; callId: string };

interface Entry {
  call: ForwardedCall;
  doneAt: number | null;
  status?: number;
  body?: unknown;
  bytes: number;
}

export interface HolderCallStoreOptions {
  /** Run the call through this machine's own route logic; returns status + body. */
  run: (call: ForwardedCall) => Promise<{ status: number; body: unknown }>;
  /** Ledger lookup for a callId this process no longer holds (restart/eviction). */
  ledgerLookup: (callId: string) => { requestSha256: string; bookedUsd: number | null } | null;
  now?: () => number;
  retentionMs?: number;
  maxBytes?: number;
}

export class HolderCallStore {
  private readonly entries = new Map<string, Entry>();
  private totalBytes = 0;
  private readonly now: () => number;
  private readonly retentionMs: number;
  private readonly maxBytes: number;

  constructor(private readonly opts: HolderCallStoreOptions) {
    this.now = opts.now ?? (() => Date.now());
    this.retentionMs = opts.retentionMs ?? HOLDER_RESULT_RETENTION_MS;
    this.maxBytes = opts.maxBytes ?? HOLDER_RESULT_MAX_BYTES;
  }

  /** Accept a submit. A repeated callId returns the existing state; never a second run. */
  submit(call: ForwardedCall): HolderCallState {
    this.evict();
    const existing = this.entries.get(call.callId);
    if (existing) {
      if (existing.call.requestSha256 !== call.requestSha256) return { state: 'callid-conflict', callId: call.callId };
      // A callId is not secret: only the holder of the original result token may see
      // the call's state or result (§6).
      if (existing.call.resultTokenHash !== call.resultTokenHash) return { state: 'not-yours', callId: call.callId };
      return this.stateOf(existing);
    }
    const booked = this.opts.ledgerLookup(call.callId);
    if (booked) {
      // Admitted before a restart/eviction: never re-dispatch.
      if (booked.requestSha256 !== call.requestSha256) return { state: 'callid-conflict', callId: call.callId };
      return { state: 'settled-result-lost', callId: call.callId, bookedUsd: booked.bookedUsd };
    }
    const e: Entry = { call, doneAt: null, bytes: 0 };
    this.entries.set(call.callId, e);
    void this.opts.run(call).then(
      (r) => this.finish(e, r.status, r.body),
      (err) => this.finish(e, 500, { status: 'degraded', reason: 'holder-run-failed', message: err instanceof Error ? err.message.slice(0, 200) : 'error' }),
    );
    return { state: 'running', callId: call.callId };
  }

  /** Poll by callId + result token. Without the right token the answer is `not-yours`. */
  poll(callId: string, resultToken: string): HolderCallState {
    this.evict();
    const e = this.entries.get(callId);
    if (!e) {
      const booked = this.opts.ledgerLookup(callId);
      return booked ? { state: 'settled-result-lost', callId, bookedUsd: booked.bookedUsd } : { state: 'unknown', callId };
    }
    if (typeof resultToken !== 'string' || sha256Hex(resultToken) !== e.call.resultTokenHash) return { state: 'not-yours', callId };
    return this.stateOf(e);
  }

  private stateOf(e: Entry): HolderCallState {
    return e.doneAt === null ? { state: 'running', callId: e.call.callId } : { state: 'done', callId: e.call.callId, status: e.status ?? 500, body: e.body };
  }

  private finish(e: Entry, status: number, body: unknown): void {
    e.status = status;
    e.body = body;
    e.doneAt = this.now();
    e.bytes = Buffer.byteLength(JSON.stringify(body ?? null));
    this.totalBytes += e.bytes;
    this.evict();
  }

  private evict(): void {
    const t = this.now();
    for (const [id, e] of this.entries) {
      if (e.doneAt !== null && t - e.doneAt > this.retentionMs) {
        this.totalBytes -= e.bytes;
        this.entries.delete(id);
      }
    }
    if (this.totalBytes <= this.maxBytes) return;
    const done = [...this.entries.entries()].filter(([, e]) => e.doneAt !== null).sort((a, b) => (a[1].doneAt ?? 0) - (b[1].doneAt ?? 0));
    for (const [id, e] of done) {
      if (this.totalBytes <= this.maxBytes) break;
      this.totalBytes -= e.bytes;
      this.entries.delete(id);
    }
  }

  /** For tests/observability. */
  size(): number {
    return this.entries.size;
  }
}

// ── 2. Origin forwarder ────────────────────────────────────────────────

export interface ForwardResult {
  status: number;
  body: unknown;
  callId: string;
}

export interface ForwardDeps {
  send: MeteredSend;
  holder: () => string | null;
  originMachine: string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** callId = sha256(originMachine, session, requestSha256, nonce) (§6). */
export function forwardCallId(originMachine: string, session: string, requestSha256: string, nonce: string): string {
  return sha256Hex(`${originMachine}|${session}|${requestSha256}|${nonce}`);
}

/**
 * Submit then poll. `deadlineMs` is the call's derived timeout + 60s (§6). The resume
 * fields let a caller that timed out poll again with the same callId and token.
 */
export async function forwardMeteredCall(
  deps: ForwardDeps,
  req: { op: ForwardOp; session: string; requestSha256: string; payload: Record<string, unknown>; deadlineMs: number; resume?: { callId: string; resultToken: string } },
): Promise<ForwardResult & { resultToken: string }> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => Date.now());
  const holder = deps.holder();
  const resultToken = req.resume?.resultToken ?? crypto.randomBytes(32).toString('hex');
  const callId = req.resume?.callId ?? forwardCallId(deps.originMachine, req.session, req.requestSha256, crypto.randomBytes(12).toString('hex'));
  const fail = (status: number, reason: string): ForwardResult & { resultToken: string } => ({ status, body: { status: 'unavailable', error: 'refused', reason, callId }, callId, resultToken });
  if (!holder) return fail(503, 'holder-unreachable');
  let submitReached = !!req.resume;
  if (!req.resume) {
    try {
      const ack = (await deps.send(holder, {
        type: 'metered-gemini-call',
        op: req.op,
        originMachine: deps.originMachine,
        session: req.session,
        callId,
        requestSha256: req.requestSha256,
        resultTokenHash: sha256Hex(resultToken),
        payload: req.payload,
      }, { timeoutMs: 20_000 })) as { state?: string } | null;
      if (ack?.state === 'callid-conflict') return fail(409, 'callid-conflict');
      if ((ack as { state?: string; reason?: string } | null)?.state === 'refused') return fail(503, (ack as { reason?: string }).reason ?? 'holder-refused');
      submitReached = true;
    } catch (err) {
      // A lost acknowledgment is fine: the poll below collects the same callId.
      const kind = classifyForwardFailure(err);
      if (kind === 'peer-version') return fail(503, 'peer-version');
    }
  }
  const stopAt = now() + Math.max(1_000, req.deadlineMs);
  let wait = 2_000;
  // With no evidence the holder ever got the submit, three straight transport failures
  // end the wait as holder-unreachable (the callId is returned, so a later poll can still
  // collect if the submit did land). Once the holder has answered, only the deadline ends it.
  let transportFailures = 0;
  while (now() < stopAt) {
    try {
      const st = (await deps.send(holder, { type: 'metered-gemini-result', callId, resultToken }, { timeoutMs: 15_000 })) as HolderCallState | null;
      submitReached = true;
      transportFailures = 0;
      if (st?.state === 'done') return { status: st.status, body: st.body, callId, resultToken };
      if (st?.state === 'settled-result-lost') return { status: 410, body: { status: 'unavailable', reason: 'settled-result-lost', bookedUsd: st.bookedUsd, callId }, callId, resultToken };
      if (st?.state === 'not-yours') return fail(403, 'not-yours');
      if (st?.state === 'callid-conflict') return fail(409, 'callid-conflict');
    } catch (err) {
      if (classifyForwardFailure(err) === 'peer-version') return fail(503, 'peer-version');
      transportFailures++;
      if (!submitReached && transportFailures >= 3) {
        return { status: 503, body: { status: 'unavailable', error: 'refused', reason: 'holder-unreachable', callId, retryWith: { callId, resultToken } }, callId, resultToken };
      }
    }
    await sleep(wait);
    wait = Math.min(10_000, wait + 2_000);
  }
  return { status: 504, body: { status: 'unavailable', reason: 'holder-timeout', callId, retryWith: { callId, resultToken } }, callId, resultToken };
}

// ── 3. Designation echo (lease liveness) ───────────────────────────────

export const DESIGNATION_ECHO_INTERVAL_MS = 10_000;
export const DESIGNATION_ECHO_RPC_TIMEOUT_MS = 8_000;
export const DESIGNATION_ECHO_MAX_BACKOFF_MS = 20_000;

export interface DesignationClaim {
  machineId: string;
  designationEpoch: number;
  /** True when the claim is backed by a recorded one-key artifact (§6 "Designation conflicts"). */
  oneKeyBacked: boolean;
}

export interface DesignationEchoOptions {
  send: MeteredSend;
  /** Registered peers; null when the registry cannot be read (unknown ⇒ fences). */
  peers: () => string[] | null;
  selfMachineId: string;
  keyRef: string;
  designationEpoch: () => number;
  /** Freeze this holder (security class) on a backed newer conflicting claim. */
  onConflict: (claim: DesignationClaim) => void;
  /** Quiet signal for an older or unbacked claim naming another machine. */
  onStaleClaim?: (claim: DesignationClaim) => void;
  now?: () => number;
}

/**
 * Holder-side lease confirmation. No registered peers ⇒ a single-machine agent, which
 * trivially self-confirms. Unknown (never confirmed, no reply) ⇒ `null`, which fences.
 */
export class DesignationEchoTracker {
  private lastConfirmedAt: number | null = null;
  private readonly inFlight = new Set<string>();
  private readonly backoff = new Map<string, number>();
  private readonly nextAt = new Map<string, number>();
  private readonly now: () => number;

  constructor(private readonly o: DesignationEchoOptions) {
    this.now = o.now ?? (() => Date.now());
  }

  /** ms since the last fresh confirmation; 0 with no peers; null when unknown. */
  leaseConfirmedAgoMs(): number | null {
    const peers = this.o.peers();
    if (peers === null) return null; // registry unreadable: unknown fences
    if (peers.length === 0) return 0;
    return this.lastConfirmedAt === null ? null : Math.max(0, this.now() - this.lastConfirmedAt);
  }

  /** One round: echo each peer not already in flight and not backing off. */
  async tick(): Promise<void> {
    const peers = this.o.peers() ?? [];
    await Promise.all(peers.map(async (peer) => {
      if (this.inFlight.has(peer)) return;
      const due = this.nextAt.get(peer) ?? 0;
      if (this.now() < due) return;
      this.inFlight.add(peer);
      const nonce = crypto.randomBytes(16).toString('hex');
      const issuedAt = this.now();
      try {
        const reply = (await this.o.send(peer, { type: 'designation-echo', keyRef: this.o.keyRef, designationEpoch: this.o.designationEpoch(), nonce }, { timeoutMs: DESIGNATION_ECHO_RPC_TIMEOUT_MS })) as { nonce?: unknown; seen?: unknown } | null;
        const receivedAt = this.now();
        // Fresh only: the echoed nonce is the one issued this round, received within the window.
        if (reply && reply.nonce === nonce && receivedAt - issuedAt <= DESIGNATION_ECHO_RPC_TIMEOUT_MS) {
          this.lastConfirmedAt = receivedAt;
          this.backoff.delete(peer);
          this.nextAt.set(peer, receivedAt + DESIGNATION_ECHO_INTERVAL_MS);
          this.judgeSeen(reply.seen);
        } else {
          this.fail(peer);
        }
      } catch {
        this.fail(peer);
      } finally {
        this.inFlight.delete(peer);
      }
    }));
  }

  private fail(peer: string): void {
    const b = Math.min(DESIGNATION_ECHO_MAX_BACKOFF_MS, (this.backoff.get(peer) ?? DESIGNATION_ECHO_INTERVAL_MS / 2) * 2);
    this.backoff.set(peer, b);
    this.nextAt.set(peer, this.now() + b);
  }

  private judgeSeen(seen: unknown): void {
    const c = seen as Partial<DesignationClaim> | null | undefined;
    if (!c || typeof c.machineId !== 'string' || typeof c.designationEpoch !== 'number') return;
    if (c.machineId === this.o.selfMachineId) return; // a healthy peer echoing us: never a conflict
    const claim: DesignationClaim = { machineId: c.machineId, designationEpoch: c.designationEpoch, oneKeyBacked: c.oneKeyBacked === true };
    if (claim.oneKeyBacked && claim.designationEpoch > this.o.designationEpoch()) this.o.onConflict(claim);
    else this.o.onStaleClaim?.(claim);
  }
}

/** Peer-side answer to a designation echo: echo the nonce, report what this machine has seen. */
export function answerDesignationEcho(cmd: { nonce?: unknown; keyRef?: unknown; designationEpoch?: unknown }, seen: DesignationClaim | null): { nonce: string; seen: DesignationClaim | null } | { error: string } {
  if (typeof cmd.nonce !== 'string' || !/^[a-f0-9]{16,64}$/.test(cmd.nonce)) return { error: 'invalid' };
  return { nonce: cmd.nonce, seen };
}

/** The failover-threshold boot check (§6): refuse to arm under twice the worst-case fence time. */
export const WORST_CASE_FENCE_MS = 60_000 + DESIGNATION_ECHO_MAX_BACKOFF_MS + DESIGNATION_ECHO_RPC_TIMEOUT_MS;
export function failoverThresholdAllowsArming(failoverThresholdMs: number): boolean {
  return Number.isFinite(failoverThresholdMs) && failoverThresholdMs >= 2 * WORST_CASE_FENCE_MS;
}
