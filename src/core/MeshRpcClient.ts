/**
 * MeshRpcClient — the SEND side of MeshRpc (Multi-Machine Session Pool §L0), the
 * outbound counterpart to MeshRpcDispatcher (the receive side). It builds a §L0
 * envelope (recipient-bound, Ed25519-signed, nonce + timestamp), POSTs it to a peer's
 * `/mesh/rpc`, and returns the typed result. This is what makes the router's
 * `deliverMessage`/`spawnOnMachine` and the TransferOrchestrator's `sendTransferRpc`
 * deps live across machines — it is the activation transport (D11).
 *
 * Transport-agnostic + fully injected (fetch, sign, nonce, clock) so the wire logic is
 * deterministic and unit-testable against a real dispatcher over loopback. Each attempt
 * honors a per-attempt timeout; retry/backoff is the CALLER's policy (the router owns it).
 */

import type { MeshCommand, MeshEnvelope } from './MeshRpc.js';
import { signEnvelope } from './MeshRpc.js';

export interface MeshPeer {
  machineId: string;
  /** Base URL of the peer's instar server (e.g. https://mini.dawn-tunnel.dev). */
  url: string;
}

export interface MeshRpcClientResult {
  status: number;
  ok: boolean;
  /** The dispatcher's `result` (handler return) on 200, else undefined. */
  result?: unknown;
  /** The dispatcher's rejection reason on a non-200 (not-router, replayed-nonce, …). */
  reason?: string;
}

export interface MeshRpcClientDeps {
  selfMachineId: string;
  /** Sign the canonical envelope bytes with THIS machine's private signing key. */
  sign: (canonical: string) => string;
  /** Mint a fresh nonce (NonceStore-backed, unique per send). */
  nonce: () => string;
  now?: () => number;
  /** Injected fetch (defaults to global fetch). */
  fetchFn?: (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ status: number; json: () => Promise<unknown> }>;
  /** Per-attempt timeout (ms). Default 5000. */
  timeoutMs?: number;
}

export class MeshRpcClient {
  private readonly d: MeshRpcClientDeps;
  constructor(deps: MeshRpcClientDeps) {
    this.d = deps;
  }

  /** Build + sign an envelope for `peer` carrying `command` at `epoch`. */
  buildEnvelope(peer: MeshPeer, command: MeshCommand, epoch: number): MeshEnvelope {
    return signEnvelope(
      {
        sender: this.d.selfMachineId,
        recipient: peer.machineId,
        command,
        epoch,
        nonce: this.d.nonce(),
        timestamp: this.d.now ? this.d.now() : Date.now(),
      },
      (c) => this.d.sign(c),
    );
  }

  /**
   * Send one signed command to a peer's /mesh/rpc. Resolves with the typed result
   * (never throws on a non-200 — it maps the dispatcher's reason); throws ONLY on a
   * transport error / timeout, so the caller's retry loop can catch it.
   */
  async send(peer: MeshPeer, command: MeshCommand, epoch: number): Promise<MeshRpcClientResult> {
    const env = this.buildEnvelope(peer, command, epoch);
    const fetchFn = this.d.fetchFn ?? ((url, init) => fetch(url, init as RequestInit) as unknown as Promise<{ status: number; json: () => Promise<unknown> }>);
    const timeoutMs = this.d.timeoutMs ?? 5000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchFn(peer.url.replace(/\/$/, '') + '/mesh/rpc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(env),
        signal: controller.signal,
      });
      const body = (await res.json().catch(() => ({}))) as { result?: unknown; reason?: string };
      return res.status === 200
        ? { status: 200, ok: true, result: body.result }
        : { status: res.status, ok: false, reason: body.reason };
    } finally {
      clearTimeout(timer);
    }
  }
}
