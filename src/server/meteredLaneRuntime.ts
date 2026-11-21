/**
 * MeteredLaneRuntime — the per-machine runtime of the Gemini pay-per-use lane's
 * multi-machine half (docs/specs/gemini-payg-metered-lane.md §6, §9).
 *
 * One object per server, so the large server files get thin hooks only:
 *   - `isDesignatedHere()` / `holder()` — read the door's designation (caps store);
 *   - `forwardSecondOpinion` / `forwardReview` — non-holder routes forward, never spend;
 *   - `handleMesh(cmd, sender)` — the holder side of the five §6 verbs;
 *   - `stopAction(...)` — freeze / lower / disable reach the SPENDER: applied locally on
 *     the holder, sent to it otherwise; "stopped" only after the holder confirms;
 *   - the designation echo (`startEcho`) that feeds the gate's `leaseConfirmedAgoMs`;
 *   - `meteredDesignation()` — what secret sync uses to route metered keys.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { HolderCallStore, forwardMeteredCall, classifyForwardFailure, DesignationEchoTracker, answerDesignationEcho, DESIGNATION_ECHO_INTERVAL_MS, type MeteredSend, type ForwardedCall, type DesignationClaim } from '../core/meteredLaneMesh.js';
import type { MeteredDesignation } from '../core/meteredSecrets.js';
import { executeReview, executeSecondOpinion, type GeminiPaygRouteDeps, type GeminiReviewBinding, type ExecResult } from './geminiPaygRoutes.js';
import type { GeminiCallRequest } from '../providers/metered/gemini-api/GeminiApiProvider.js';
import { deriveGenerateTimeoutMs } from '../providers/metered/gemini-api/geminiApiTransport.js';

export const GEMINI_PAYG_KEY_REF = 'gemini_api_key_payg';

export interface LaneDesignation {
  designatedMachineId: string;
  designationEpoch: number;
  /** A recorded one-key artifact backs this designation (§4/§6). */
  oneKeyBacked: boolean;
  transferPending: boolean;
}

export type StopAction = 'freeze' | 'lower' | 'disable-caller' | 'lower-share';

export interface MeteredLaneRuntimeDeps {
  selfMachineId: string;
  /** The door's designation from the caps store; null before go-live. */
  readDesignation: () => LaneDesignation | null;
  /** Registered active peers (excluding self); null when the registry cannot be read. */
  peers: () => string[] | null;
  /** Route-executor deps on THIS machine (provider, refusal map, audit). */
  exec: Pick<GeminiPaygRouteDeps, 'provider' | 'refusalHttp' | 'audit'>;
  /** Ledger lookup for a forwarded callId after a restart/eviction. */
  ledgerLookup: (callId: string) => { requestSha256: string; bookedUsd: number | null } | null;
  /** Apply a stop action locally (holder only). Reduce-only mutators. Throws on refusal. */
  applyStop: (action: StopAction, actor: string, params: Record<string, unknown>) => void;
  /** Vault key NAMES on this machine (never values). */
  secretNames: () => string[];
  /** Freeze this holder on a backed conflicting designation (security class; notice inside). */
  onConflict: (claim: DesignationClaim) => void;
  onStaleClaim?: (claim: DesignationClaim) => void;
  /**
   * Where an issuing machine keeps stop actions the spender has not confirmed yet
   * (`state/gemini-payg-pending-stops.json`). They are retried every 30s until the
   * holder confirms: freeze wins once the holder is reachable again (§6).
   */
  pendingStopsPath?: string;
  /**
   * Where a non-holder keeps the designation it last heard from the holder
   * (`state/gemini-payg-seen-designation.json`), so it survives a restart and the
   * review driver can tell the door is configured without asking the server.
   */
  seenDesignationPath?: string;
  /**
   * The holder side of `release-proof-forward` (§8): the release-proof recorder, which
   * stamps the proof marker ITSELF. The payload is evidence pointers only; nothing in it
   * reaches the paid call. Absent ⇒ the op is unsupported here.
   */
  releaseProof?: (originMachine: string, payload: Record<string, unknown>) => Promise<ExecResult>;
  /**
   * Render the `gemini-payg-setup` plan on THIS machine for a peer that asked (§8 "A
   * request from another machine is forwarded there"). Absent ⇒ refused.
   */
  renderSetup?: (requestedBy: string) => Promise<unknown>;
  now?: () => number;
}

interface PendingStop { requestId: string; action: StopAction; actor: string; params: Record<string, unknown>; at: number }

export class MeteredLaneRuntime {
  private send: MeteredSend | null = null;
  private readonly store: HolderCallStore;
  private echo: DesignationEchoTracker | null = null;
  private echoTimer: ReturnType<typeof setInterval> | null = null;
  /** The last designation this machine heard in an echo from the holder (peer side). */
  private lastSeen: DesignationClaim | null = null;
  private retryTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly d: MeteredLaneRuntimeDeps) {
    if (d.seenDesignationPath) {
      try {
        const v = JSON.parse(fs.readFileSync(d.seenDesignationPath, 'utf-8')) as Partial<DesignationClaim>;
        if (typeof v.machineId === 'string' && typeof v.designationEpoch === 'number') this.lastSeen = { machineId: v.machineId, designationEpoch: v.designationEpoch, oneKeyBacked: false };
      } catch { /* @silent-fallback-ok: nothing heard yet — the next echo (≤10s) supplies it */ }
    }
    this.store = new HolderCallStore({
      run: (call) => this.runForwarded(call),
      ledgerLookup: (id) => d.ledgerLookup(id),
      ...(d.now ? { now: d.now } : {}),
    });
  }

  /** Late-bound signed mesh client (MeshRpc). Absent ⇒ forwarding is holder-unreachable. */
  setSend(send: MeteredSend): void {
    this.send = send;
  }

  /**
   * The designated spender: from this machine's own caps record (the holder), else the
   * designation it last heard in the holder's echo (every non-holder; §6 "Forwarding
   * needs only the published designation"). Unknown ⇒ null.
   */
  holder(): string | null {
    let own: string | null = null;
    try { own = this.d.readDesignation()?.designatedMachineId ?? null; } catch { /* @silent-fallback-ok: fail-closed — the caller gets an explicit refusal or unknown, never a pass */ own = null; }
    return own ?? this.lastSeen?.machineId ?? null;
  }

  isDesignatedHere(): boolean {
    return this.holder() === this.d.selfMachineId;
  }

  /** For secret sync: where metered keys may travel (fail-closed on unknown). */
  meteredDesignation(): MeteredDesignation | null {
    let des: LaneDesignation | null = null;
    try { des = this.d.readDesignation(); } catch { /* @silent-fallback-ok: fail-closed — the caller gets an explicit refusal or unknown, never a pass */ des = null; }
    if (des) return { designatedMachineId: des.designatedMachineId, transferPending: des.transferPending };
    // A non-holder learns the designation from the holder's echo; unknown ⇒ strip.
    return this.lastSeen ? { designatedMachineId: this.lastSeen.machineId } : null;
  }

  // ── Forwarding (non-holder) ─────────────────────────────────────

  private deadlineFor(maxOut: number): number {
    return deriveGenerateTimeoutMs(maxOut, undefined) + 60_000;
  }

  async forwardSecondOpinion(call: GeminiCallRequest & { session: string }): Promise<ExecResult> {
    // No designation published anywhere ⇒ the lane is simply not on (§8 fleet defaults).
    if (!this.holder()) return { status: 503, body: { error: 'refused', reason: 'money-layer-off', message: 'The Gemini lane is not available on this machine.' } };
    if (!this.send) return { status: 503, body: { error: 'refused', reason: 'holder-unreachable' } };
    const { session, ...payload } = call;
    const r = await forwardMeteredCall(
      { send: this.send, holder: () => this.holder(), originMachine: this.d.selfMachineId },
      { op: 'second-opinion', session, requestSha256: hashPayload(payload), payload: payload as unknown as Record<string, unknown>, deadlineMs: this.deadlineFor((payload.maxOutputTokens ?? 4096) + 2048) },
    );
    return { status: r.status, body: r.body };
  }

  async forwardReview(req: GeminiReviewBinding & { promptText: string; session: string }): Promise<ExecResult> {
    if (!this.holder()) return { status: 503, body: { status: 'unavailable', reason: 'money-layer-off' } };
    if (!this.send) return { status: 503, body: { status: 'unavailable', reason: 'holder-unreachable' } };
    const { session, promptText, ...binding } = req;
    const r = await forwardMeteredCall(
      { send: this.send, holder: () => this.holder(), originMachine: this.d.selfMachineId },
      { op: 'spec-review', session, requestSha256: hashPayload({ binding, promptText }), payload: { binding, promptText }, deadlineMs: this.deadlineFor(16_384 + 8_192) },
    );
    return { status: r.status, body: r.body };
  }

  // ── Holder side ─────────────────────────────────────────────────

  private async runForwarded(call: ForwardedCall): Promise<ExecResult> {
    if (!this.isDesignatedHere()) return { status: 503, body: { error: 'refused', reason: 'no-cap-slice' } };
    if (call.op === 'second-opinion') {
      // Rebuild the call from an allowlist: a peer can never smuggle an E1 slot, a proof
      // marker, a thinking budget or another caller's component into a second opinion.
      const p = call.payload as Record<string, unknown>;
      const rawComponent = typeof p.component === 'string' ? p.component : '';
      const purpose = rawComponent.startsWith('second-opinion:') ? rawComponent.slice('second-opinion:'.length) : 'forwarded'; // bounded-input-reviewed: strips a fixed label prefix, never cuts content
      if (typeof p.prompt !== 'string' || !p.prompt.trim() || purpose.length === 0 || purpose.length > 200) {
        return { status: 400, body: { error: 'bad-request', reason: 'bad-request' } };
      }
      const req: GeminiCallRequest = {
        caller: 'second-opinion',
        component: `second-opinion:${purpose}`,
        model: typeof p.model === 'string' ? p.model : 'hydrogen',
        prompt: p.prompt,
        ...(typeof p.systemInstruction === 'string' ? { systemInstruction: p.systemInstruction } : {}),
        ...(typeof p.maxOutputTokens === 'number' ? { maxOutputTokens: p.maxOutputTokens } : {}),
        callId: call.callId,
        run: `${call.originMachine}:${call.session}`,
      };
      return executeSecondOpinion(this.d.exec, req, call.session, purpose);
    }
    if (call.op === 'spec-review') {
      const p = call.payload as { binding?: GeminiReviewBinding; promptText?: string };
      if (!p.binding || typeof p.promptText !== 'string') return { status: 400, body: { status: 'unavailable', reason: 'bad-request' } };
      return executeReview(this.d.exec, p.binding, p.promptText, call.session);
    }
    if (call.op === 'release-proof-forward') {
      // The holder's recorder stamps the marker itself; the origin machine is the
      // AUTHENTICATED sender. Only the live-test evidence pointer is read from the payload.
      if (!this.d.releaseProof) return { status: 503, body: { status: 'unavailable', reason: 'release-recorder-unavailable' } };
      const p = call.payload as Record<string, unknown>;
      const lt = p.liveTestArtifact as { featureId?: unknown; runId?: unknown } | undefined;
      const payload: Record<string, unknown> = lt && typeof lt.featureId === 'string' && typeof lt.runId === 'string'
        ? { liveTestArtifact: { featureId: lt.featureId.slice(0, 160), runId: lt.runId.slice(0, 160) } }
        : {};
      return this.d.releaseProof(call.originMachine, payload);
    }
    return { status: 400, body: { status: 'unavailable', reason: 'unsupported-op' } };
  }

  /** The holder side of the §6 verbs. Returns the reply body. */
  async handleMesh(cmd: Record<string, unknown>, sender: string): Promise<unknown> {
    switch (cmd.type) {
      case 'metered-gemini-call': {
        if (!this.isDesignatedHere()) return { state: 'refused', reason: 'no-cap-slice' };
        const c = cmd as unknown as ForwardedCall & { type: string };
        if (!['spec-review', 'second-opinion', 'release-proof-forward'].includes(c.op) || typeof c.callId !== 'string' || !/^[a-f0-9]{64}$/.test(c.callId)
          || typeof c.requestSha256 !== 'string' || typeof c.resultTokenHash !== 'string' || !/^[a-f0-9]{64}$/.test(c.resultTokenHash)
          || !c.payload || typeof c.payload !== 'object') return { state: 'refused', reason: 'invalid' };
        // The origin machine is the AUTHENTICATED sender, never a field in the body.
        return this.store.submit({ op: c.op, originMachine: sender, session: String(c.session ?? '').slice(0, 120), callId: c.callId, requestSha256: c.requestSha256, resultTokenHash: c.resultTokenHash, payload: c.payload });
      }
      case 'metered-gemini-result':
        return this.store.poll(String(cmd.callId ?? ''), String(cmd.resultToken ?? ''));
      case 'metered-stop-action': {
        if (!this.isDesignatedHere()) return { ok: false, reason: 'not-holder' };
        const action = cmd.action as StopAction;
        if (!['freeze', 'lower', 'disable-caller', 'lower-share'].includes(action)) return { ok: false, reason: 'invalid' };
        try {
          this.d.applyStop(action, `peer:${sender}`, (cmd.params as Record<string, unknown>) ?? {});
          return { ok: true, applied: action, requestId: cmd.requestId ?? null };
        } catch (err) { /* @silent-fallback-ok: fail-closed — the caller gets an explicit refusal or unknown, never a pass */
          return { ok: false, reason: err instanceof Error ? err.message.slice(0, 160) : 'refused' };
        }
      }
      case 'designation-echo': {
        // Peer side: remember the holder's designation (it routes metered secret sync)
        // and echo the nonce with what this machine has seen.
        if (typeof cmd.designationEpoch === 'number' && (!this.lastSeen || cmd.designationEpoch >= this.lastSeen.designationEpoch)) {
          const changed = this.lastSeen?.machineId !== sender || this.lastSeen?.designationEpoch !== cmd.designationEpoch;
          this.lastSeen = { machineId: sender, designationEpoch: cmd.designationEpoch, oneKeyBacked: false };
          if (changed && this.d.seenDesignationPath) {
            try {
              fs.mkdirSync(path.dirname(this.d.seenDesignationPath), { recursive: true });
              fs.writeFileSync(this.d.seenDesignationPath, JSON.stringify({ ...this.lastSeen, keyRef: GEMINI_PAYG_KEY_REF, heardAt: new Date().toISOString() }), { mode: 0o600 });
            } catch (err) { console.error(`[instar] gemini-payg: could not persist the heard designation: ${String(err)}`); }
          }
        }
        let own: LaneDesignation | null = null;
        try { own = this.d.readDesignation(); } catch { /* @silent-fallback-ok: fail-closed — the caller gets an explicit refusal or unknown, never a pass */ own = null; }
        const seen: DesignationClaim | null = own ? { machineId: own.designatedMachineId, designationEpoch: own.designationEpoch, oneKeyBacked: own.oneKeyBacked } : null;
        return answerDesignationEcho(cmd as { nonce?: unknown }, seen);
      }
      case 'secret-names':
        try {
          return { names: this.d.secretNames() };
        } catch { /* @silent-fallback-ok: NOT a pass — the asker gets an explicit error answer, which blocks a go-live render */
          return { error: 'vault-unreadable' };
        }
      case 'gemini-payg-setup-render': {
        if (!this.d.renderSetup) return { ok: false, reason: 'render-unavailable' };
        try {
          return { ok: true, plan: await this.d.renderSetup(sender) };
        } catch (err) { /* @silent-fallback-ok: the refusal is RETURNED to the asking machine, never swallowed */
          const e = err as { code?: unknown; message?: unknown; detail?: unknown };
          return { ok: false, reason: typeof e.code === 'string' ? e.code : 'render-refused', message: typeof e.message === 'string' ? e.message.slice(0, 600) : '', ...(e.detail ? { detail: e.detail } : {}) };
        }
      }
      default:
        return { ok: false, reason: 'unknown-verb' };
    }
  }

  /** The designation this machine last heard from a holder's echo (null before any). */
  heardDesignation(): DesignationClaim | null {
    return this.lastSeen ? { ...this.lastSeen } : null;
  }

  /**
   * `secret-names` on every registered peer (§4 go-live precondition). A peer the rope
   * cannot reach is `unreachable` (offline: cleared by mint-after-filter); a peer that
   * answers without a names list is `error`. Null when the registry cannot be read.
   */
  async peerSecretNames(timeoutMs = 8_000): Promise<Array<{ machineId: string; outcome: 'names' | 'unreachable' | 'error'; names?: string[]; detail?: string }> | null> {
    const peers = this.d.peers();
    if (peers === null) return null;
    return Promise.all(peers.map(async (machineId) => {
      if (!this.send) return { machineId, outcome: 'unreachable' as const, detail: 'no mesh transport' };
      try {
        const r = (await this.send(machineId, { type: 'secret-names' }, { timeoutMs })) as { names?: unknown } | null;
        if (r && Array.isArray(r.names) && r.names.every((n) => typeof n === 'string')) return { machineId, outcome: 'names' as const, names: r.names as string[] };
        return { machineId, outcome: 'error' as const, detail: 'answered without a names list' };
      } catch (err) { /* @silent-fallback-ok: classified below — an old peer is an error, an unreachable one is offline */
        const cls = classifyForwardFailure(err);
        return cls === 'peer-version'
          ? { machineId, outcome: 'error' as const, detail: 'peer-version (an older build that cannot answer secret-names)' }
          : { machineId, outcome: 'unreachable' as const };
      }
    }));
  }

  /** Forward the release proof to the holder (§8 check (a)+(e) on a multi-machine agent). */
  async forwardReleaseProof(session: string, payload: Record<string, unknown>): Promise<ExecResult> {
    if (!this.holder()) return { status: 503, body: { status: 'unavailable', reason: 'money-layer-off' } };
    if (!this.send) return { status: 503, body: { status: 'unavailable', reason: 'holder-unreachable' } };
    const r = await forwardMeteredCall(
      { send: this.send, holder: () => this.holder(), originMachine: this.d.selfMachineId },
      { op: 'release-proof-forward', session, requestSha256: hashPayload({ op: 'release-proof-forward', payload }), payload, deadlineMs: this.deadlineFor(64 + 128) },
    );
    return { status: r.status, body: r.body };
  }

  /** Ask the named machine to render the go-live plan there (it renders only where its proposal names). */
  async forwardSetupRender(machineId: string): Promise<{ ok: boolean; reason?: string; message?: string; plan?: unknown; detail?: unknown }> {
    if (!this.send) return { ok: false, reason: 'holder-unreachable', message: 'no mesh transport to reach that machine' };
    try {
      const r = (await this.send(machineId, { type: 'gemini-payg-setup-render' }, { timeoutMs: 30_000 })) as { ok?: boolean; reason?: string; message?: string; plan?: unknown; detail?: unknown } | null;
      return r && typeof r === 'object' ? { ok: r.ok === true, ...(r.reason ? { reason: r.reason } : {}), ...(r.message ? { message: r.message } : {}), ...(r.plan !== undefined ? { plan: r.plan } : {}), ...(r.detail ? { detail: r.detail } : {}) } : { ok: false, reason: 'bad-reply' };
    } catch (err) { /* @silent-fallback-ok: the failure is returned and shown, never a local render */
      return { ok: false, reason: classifyForwardFailure(err) };
    }
  }

  // ── Stop actions reach the spender (§6, §9) ─────────────────────

  async stopAction(action: StopAction, actor: string, params: Record<string, unknown> = {}): Promise<{ ok: boolean; confirmed: boolean; reason?: string }> {
    const holder = this.holder();
    if (!holder || holder === this.d.selfMachineId) {
      try {
        this.d.applyStop(action, actor, params);
      } catch (err) { /* @silent-fallback-ok: fail-closed — the caller gets an explicit refusal or unknown, never a pass */
        return { ok: false, confirmed: false, reason: err instanceof Error ? err.message : 'refused' };
      }
      // Applied here. It is confirmed for the SPENDER only when this machine is it; with no
      // known designation this machine cannot vouch for another one (§6).
      return holder ? { ok: true, confirmed: true } : { ok: true, confirmed: false, reason: 'designation-unknown' };
    }
    const pending: PendingStop = { requestId: `${this.d.selfMachineId}:${crypto.randomBytes(8).toString('hex')}`, action, actor, params, at: (this.d.now ?? Date.now)() };
    const r = await this.deliverStop(holder, pending);
    if (r.ok) return { ok: true, confirmed: true };
    if (r.reason === 'holder-unreachable') {
      // Kept and retried until the spender confirms: a stop is never dropped (§6).
      this.savePending([...this.loadPending(), pending]);
      this.ensureRetry();
    }
    // "stop requested; the spending machine has not confirmed yet" — never "stopped".
    return { ok: false, confirmed: false, reason: r.reason };
  }

  private async deliverStop(holder: string, p: PendingStop): Promise<{ ok: boolean; reason: string }> {
    if (!this.send) return { ok: false, reason: 'holder-unreachable' };
    try {
      const r = (await this.send(holder, { type: 'metered-stop-action', action: p.action, keyRef: GEMINI_PAYG_KEY_REF, requestId: p.requestId, params: p.params }, { timeoutMs: 15_000 })) as { ok?: boolean; reason?: string } | null;
      return r?.ok ? { ok: true, reason: 'ok' } : { ok: false, reason: r?.reason ?? 'holder-refused' };
    } catch { /* @silent-fallback-ok: fail-closed — the caller gets an explicit refusal or unknown, never a pass */
      return { ok: false, reason: 'holder-unreachable' };
    }
  }

  private loadPending(): PendingStop[] {
    if (!this.d.pendingStopsPath) return [];
    try {
      const v = JSON.parse(fs.readFileSync(this.d.pendingStopsPath, 'utf-8')) as unknown;
      return Array.isArray(v) ? (v as PendingStop[]).slice(-200) : [];
    } catch { return []; } // @silent-fallback-ok — no file yet: nothing pending
  }

  private savePending(list: PendingStop[]): void {
    if (!this.d.pendingStopsPath) return;
    try {
      fs.mkdirSync(path.dirname(this.d.pendingStopsPath), { recursive: true });
      const tmp = `${this.d.pendingStopsPath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(list.slice(-200)), { mode: 0o600 });
      fs.renameSync(tmp, this.d.pendingStopsPath);
    } catch (err) { /* @silent-fallback-ok: fail-closed — the caller gets an explicit refusal or unknown, never a pass */
      console.error(`[instar] gemini-payg: could not persist a pending stop (it is still retried in memory): ${String(err)}`);
    }
  }

  /** Retry every pending stop once; drop those the spender confirmed (or that are moot). */
  async retryPendingStops(): Promise<number> {
    const pending = this.loadPending();
    if (pending.length === 0) return 0;
    const holder = this.holder();
    if (!holder) return pending.length;
    const left: PendingStop[] = [];
    for (const p of pending) {
      if (holder === this.d.selfMachineId) {
        try { this.d.applyStop(p.action, p.actor, p.params); } catch { /* @silent-fallback-ok: a refused reduction (already lower) is moot */ }
        continue;
      }
      const r = await this.deliverStop(holder, p);
      // Kept while the spender is unreachable or the designation moved (not-holder).
      if (!r.ok && (r.reason === 'holder-unreachable' || r.reason === 'not-holder')) left.push(p);
    }
    this.savePending(left);
    return left.length;
  }

  private ensureRetry(): void {
    if (this.retryTimer) return;
    this.retryTimer = setInterval(() => {
      void this.retryPendingStops().then((n) => { if (n === 0 && this.retryTimer) { clearInterval(this.retryTimer); this.retryTimer = null; } }).catch(() => { /* @silent-fallback-ok: fail-closed — the caller gets an explicit refusal or unknown, never a pass */ });
    }, 30_000);
    this.retryTimer.unref?.();
  }

  /** At boot: resume retrying any stop a previous process could not deliver. */
  resumePendingStops(): void {
    if (this.loadPending().length > 0) this.ensureRetry();
  }

  // ── Lease liveness ─────────────────────────────────────────────

  /** Start the holder's echo loop (only meaningful on the designated machine). */
  startEcho(): void {
    if (this.echoTimer) return;
    this.echo = new DesignationEchoTracker({
      send: (m, c, o) => (this.send ? this.send(m, c, o) : Promise.reject(new Error('no-transport'))),
      peers: () => this.d.peers(),
      selfMachineId: this.d.selfMachineId,
      keyRef: GEMINI_PAYG_KEY_REF,
      designationEpoch: () => { try { return this.d.readDesignation()?.designationEpoch ?? 0; } catch { /* @silent-fallback-ok: fail-closed — the caller gets an explicit refusal or unknown, never a pass */ return 0; } },
      onConflict: (c) => this.d.onConflict(c),
      ...(this.d.onStaleClaim ? { onStaleClaim: this.d.onStaleClaim } : {}),
      ...(this.d.now ? { now: this.d.now } : {}),
    });
    const tick = () => { if (this.isDesignatedHere()) void this.echo?.tick().catch(() => { /* @silent-fallback-ok: fail-closed — the caller gets an explicit refusal or unknown, never a pass */ }); };
    tick();
    this.echoTimer = setInterval(tick, DESIGNATION_ECHO_INTERVAL_MS);
    this.echoTimer.unref?.();
  }

  stopEcho(): void {
    if (this.echoTimer) clearInterval(this.echoTimer);
    this.echoTimer = null;
    if (this.retryTimer) clearInterval(this.retryTimer);
    this.retryTimer = null;
  }

  /** The gate's lease input. Not the holder, or never started ⇒ null (fences). */
  leaseConfirmedAgoMs(): number | null {
    if (!this.isDesignatedHere()) return null;
    const peers = this.d.peers();
    if (peers === null) return null; // unknown fences
    if (peers.length === 0) return 0;
    return this.echo?.leaseConfirmedAgoMs() ?? null;
  }
}

function hashPayload(v: unknown): string {
  // Stable enough for dedupe: the origin computes it once per request object.
  return crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
}
