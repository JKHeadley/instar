/**
 * MeshRpc — the signed, recipient-bound machine-to-machine command layer for the
 * Multi-Machine Session Pool (spec §L0). A thin request/response envelope over the
 * existing authenticated HTTP/tunnel channel carrying a small command set:
 * place / claim / release / transfer / capacity-report / session-status /
 * secret-share.
 *
 * This module is PURE LOGIC — the canonical envelope, the 5-step receipt
 * verification, and the per-command RBAC gate. Crypto (Ed25519 sign/verify), the
 * nonce store, the peer registry, and the router/ownership reads are injected as
 * seams so the dangerous parts (recipient-binding, replay, authorization) are
 * unit-testable with in-memory fakes. The HTTP transport + production wiring sit
 * on top and call these functions.
 *
 * Two independent gates protect every command (spec §L0 Invariant):
 *   (a) verifyEnvelope — WHO sent it: a valid Ed25519 signature from a registered
 *       peer of the same agent, cryptographically bound to THIS recipient, fresh
 *       (unseen nonce) and timely (timestamp within tolerance).
 *   (b) checkCommandRBAC — whether they MAY issue it: the per-command role check
 *       (place/transfer → router; claim → placement-target or failover-router;
 *       release → owner or failover-router; reports/secret-share → any peer).
 * The CAS (§L3) is the final correctness fence; these gates refuse an
 * unauthorized command at the door, before any state read/write.
 */

export type MachineId = string;

export type MeshCommand =
  | { type: 'place'; session: string; machine: MachineId }
  | { type: 'claim'; session: string; epoch: number; failover?: boolean }
  | { type: 'release'; session: string; epoch: number; failover?: boolean }
  | { type: 'transfer'; session: string; target: MachineId }
  | { type: 'deliverMessage'; session: string; messageId: string; payload: unknown; ownershipEpoch: number }
  | {
      // WS1.2 drain signal (MULTI-MACHINE-SEAMLESSNESS-SPEC): the transfer
      // planner (router authority) tells the CURRENT owner of `session` to
      // drain its live session because a transfer to `target` is in flight.
      // Epoch-bound to the specific transfer (`ownershipEpoch` = the sender's
      // observed epoch; the receiver's CAS to transferring re-validates it, so
      // a stale or replayed drain dies at the fence). Router-only RBAC with
      // its OWN refusal reason (`drain-unauthorized`) — reach ≠ authority: the
      // receiver still re-validates ownership + epoch before acting. An old
      // peer without the handler 501s (`no-handler`) and the sender degrades
      // to today's idle-closeout-only transfer.
      type: 'drain';
      session: string;
      target: MachineId;
      ownershipEpoch: number;
    }
  | {
      // U4.4 lease hand-back offer (docs/specs/u4-4-lease-handback.md, R-r2-2):
      // the CURRENT lease holder offers the serving lease BACK to the F4
      // preferred captain, carrying the SIGNED, epoch-bound, TTL-bounded,
      // SINGLE-USE consent token the target presents at acquire time (the
      // `handbackOpts` branch of FencedLease.canAcquire). RBAC: its OWN case,
      // default-deny — ONLY the machine currently holding the serving lease may
      // send it (verified against the live lease, mirroring the drain verb's
      // role-checked posture). Typed handler responses: `accept` /
      // `declined:churn-latched` / `declined:quota` / `declined:legacy-peer`;
      // on timeout/silence the holder KEEPS HOLDING (claim-before-release — a
      // failed hand-back can never leave zero holders). Replay: rides the
      // standard envelope nonce guard AND the single-use consent token — a
      // replayed offer never re-authorizes a second claim. Version skew: an old
      // peer without the verb fails closed (403/`no-handler`); the sender
      // classifies that as peer-cannot-hand-back and STOPS re-offering for the
      // episode (degrade to today's sticky behavior, never hammer an old peer).
      type: 'handback-offer';
      proposedEpoch: number;
      consentToken: import('./FencedLease.js').HandbackConsentToken;
      expiresAt: string;
    }
  | { type: 'capacity-report' }
  | { type: 'session-status'; session?: string }
  | { type: 'secret-share'; encrypted: string }
  | {
      // WS5.2 R7a/R7(c) — per-account SPEND-SLICE renewal (account follow-me).
      // OPERATOR-MANDATE-GATED with its OWN `checkCommandRBAC` case — deliberately
      // NOT the "any registered peer" read/observe class (R3a/R6a discipline): a
      // borrowed account is a money/quota credential, so a slice may be issued ONLY
      // to a machine the operator's mandate names. A requesting VM asks the FENCED
      // lease holder to renew its slice; the holder (via SliceIssuer) verifies the
      // grant is live + a slice remains within `maxSpend` before issuing. A
      // non-holder receiving it MUST NOT issue (only the fenced single-writer
      // issues) — that refusal lives in the handler/SliceIssuer, the RBAC gate here
      // only proves the requester is mandate-authorized. The verb is rate-capped +
      // coalesced + P19-breaker-protected on the REQUESTER side (SliceRenewalControl)
      // so worst-case RPC rate is O(per-account-cap), not O(N).
      type: 'slice-renew';
      mandateId: string;
      accountId: string;
      requestingMachineFp: string;
      amount: number;
      expiresAt: number;
    }
  | {
      // WS5.2 R4a / R1 — ONE-DASHBOARD cross-machine account-follow-me mandate DELIVERY.
      // The operator issues the account-follow-me mandate (PIN-gated) on their SINGLE dashboard,
      // then delivers it to the TARGET machine via this verb so the target's enroll-start route
      // can honor it — WITHOUT the operator ever opening the target's own dashboard.
      //
      // NOT the "any registered peer" read class — it carries a credential-adjacent authorization.
      // But the REAL gate is NOT a role check at the RBAC layer: a delivered mandate is trusted
      // ONLY when the R4a asymmetric issuance signature in the carried PortableMandate verifies, IN
      // THE HANDLER, against THIS machine's REGISTERED operator-machine Ed25519 key + the
      // AUTHENTICATED sender fingerprint (Know Your Principal — a name in the payload is never
      // trusted; the §3.1a local HMAC proof is local-only and cannot ground a peer's mandate).
      // The RBAC case therefore proves only that the sender is a registered ACTIVE peer
      // (verifyEnvelope already did the Ed25519 + recipient-binding + nonce checks); the handler
      // fails CLOSED on any verification failure and NEVER persists an unverified mandate.
      type: 'account-follow-me-mandate-deliver';
      /** The R4a-signed bundle: the mandate + its asymmetric issuance signature. */
      portable: import('../coordination/AccountFollowMeMandateBridge.js').PortableMandate;
    }
  // Pool Dashboard Streaming (POOL-DASHBOARD-STREAM-SPEC §2.3): a peer asks this
  // machine to mint a single-use bearer ticket so it may open a /pool-stream WS
  // and watch `session`. Read/observe class — minting a ticket discloses
  // nothing; the ticket is consumed once, and any keystrokes are gated
  // serving-side by allowRemoteInput (default off).
  | { type: 'pool-stream-ticket'; session: string }
  | {
      // Coherence-journal replication transport (COHERENCE-JOURNAL-SPEC §3.4).
      // Read/observe class — any registered peer may issue it (same RBAC as
      // capacity-report/session-status). All three optional shapes ride one verb:
      //   • advert  — what the sender holds per stream (delta-request hint).
      //   • request — "serve me your own <kind> from > fromSeq" (first-hop).
      //   • batch   — durably-flushed own-stream entries the sender is pushing.
      type: 'journal-sync';
      advert?: Record<string, Record<string, { incarnation: string; lastSeq: number }>>;
      request?: { machineId: string; kind: string; fromSeq: number };
      batch?: { kind: string; incarnation: string; entries: unknown[]; oldestRetainedSeq?: number }[];
    }
  | {
      // Commitments-coherence read replication (COMMITMENTS-COHERENCE-SPEC
      // §3.2). Read/observe class — serves OWN commitment records as
      // seq-windowed delta pages (lastMutatedSeq > sinceSeq), incarnation-
      // fenced, per-field credential-shape redacted. First-hop: the receiver
      // binds the replica to the AUTHENTICATED sender and rejects rows
      // claiming other machines.
      type: 'commitments-sync';
      request: { sinceSeq: number; incarnation?: string };
    }
  | {
      // Single-origin store-snapshot pull (multi-machine-replicated-store-
      // foundation §6.1/§6.3). Read/observe class — the HOLDER serves a
      // single-origin snapshot of (store) it AUTHORED (origin === the serving
      // machine; §6.1 anti-forgery holds end-to-end exactly as first-hop binding
      // does on the tail path). The recovering machine requests its OWN-namespace
      // recovery of one origin at a time; the receiver re-validates that every
      // record's origin === the authenticated sender (validateWireSnapshot) before
      // landing anything — a cross-origin record rejects the WHOLE snapshot
      // (quarantined as untrusted-origin), never landed. The build runs OFF the
      // event loop in a worker (instar#1069); a flapping peer is served a cached
      // snapshot (breaker-gated, §6.3). The HANDLER stays dark unless the store is
      // enabled — an old peer / a dark store 501s (no-handler) and the caller
      // falls back to a from-genesis tail (the legacy behavior).
      type: 'state-snapshot';
      request: { store: string };
    }
  | {
      // Preferences-pool read replication (MULTI-MACHINE-SEAMLESSNESS-SPEC
      // §WS2.1). Read/observe class — serves OWN learned-preference records as
      // seq-windowed delta pages (lastMutatedSeq > sinceSeq), incarnation-
      // fenced, `learning`-field credential-shape redacted. First-hop: the
      // receiver binds the replica to the AUTHENTICATED sender and rejects rows
      // claiming other machines. Advisory signals, never authority.
      type: 'preferences-sync';
      request: { sinceSeq: number; incarnation?: string };
    }
  | {
      // Commitments-coherence owner-routed MUTATION (COMMITMENTS-COHERENCE-
      // SPEC §3.4). NOT read/observe class — this verb has its OWN RBAC case
      // below. verifyEnvelope (registered peer + signature + recipient
      // binding + nonce) is the SOLE authority by design; the owner's CAS
      // state machine re-validates every transition (mesh adds reach, not
      // authority), and the durable owner-side opKey window is the replay
      // control beyond the 60s nonce window.
      type: 'commitment-mutate';
      payload: {
        origin: string;
        id: string;
        op: 'deliver' | 'withdraw' | 'resume' | 'patch-beacon' | 'probe' | 'transition';
        args?: Record<string, unknown>;
        opKey: string;
        requestedAt: string;
        callerMachineId: string;
        observedStatus?: string;
      };
    }
  | {
      // Topic-profile transfer carrier (TOPIC-PROFILE-SPEC §5.3): the
      // pull-at-ACQUIRE batched profile fetch. Read/observe class — serves
      // this machine's OWN per-topic profile entries (current + dry-run
      // shadow; provenance travels verbatim as PEER-ASSERTED) to a
      // registered peer that just acquired the named topics. One batched
      // command carries ALL topics acquired from this peer (§5.3 batch
      // bound — never N per-topic requests). The RECEIVER revalidates every
      // field through the §10.2 closed-enum clamp before the entry can
      // persist or drive a launch — this verb adds reach, never authority.
      type: 'topic-profile-pull';
      topics: string[];
    }
  | {
      // Working-set handoff transport (WORKING-SET-HANDOFF-SPEC §3.2).
      // Read/observe class — the FRESH manifest computed per request is the
      // allowlist (own jailed working files only; no generic file-read
      // surface). Chunked: every response ≤ pullMaxBatchBytes (1 MiB default).
      //   • manifestOnly — list the topic's working set (entries + flags).
      //   • want         — serve content chunks at the given offsets.
      type: 'working-set-pull';
      topic: number;
      manifestOnly?: boolean;
      want?: { relPath: string; offset: number }[];
    }
  | {
      // WS4.4 "links that survive machine boundaries"
      // (MULTI-MACHINE-SEAMLESSNESS-SPEC §WS4.4). The tunnel-fronting machine
      // asks the HOLDER to serve a private view it actually holds. The
      // verifyEnvelope gate proves WHICH fronting machine is asking (the
      // authenticated sender — used as the expected assertion issuer); the
      // carried `assertion` is the audience-bound (holder fp + view id + method),
      // single-use, short-TTL attestation that the END USER authenticated at the
      // fronting edge. The holder verifies the assertion AND applies its own
      // per-view authorization (it makes the decision; the fronting machine is a
      // dumb relay). Read/observe class — serving OWN held views to a registered
      // same-operator peer, gated by the user-auth assertion the handler checks.
      // Two probe shapes ride one verb:
      //   • probeOnly  — "do you hold this view?" (holder resolution fan-out;
      //                  NO assertion required — discloses only existence to a
      //                  registered peer, never the body).
      //   • assertion  — present → serve the rendered body if the assertion
      //                  verifies and the holder authorizes.
      type: 'pool-view-fetch';
      viewId: string;
      method: string;
      probeOnly?: boolean;
      assertion?: unknown;
    };

export interface MeshEnvelope {
  sender: MachineId;
  recipient: MachineId;
  command: MeshCommand;
  epoch: number;
  nonce: string;
  timestamp: number; // wall-clock ms
  signature: string;
}

/** The canonical bytes the signature covers — field-ordered, recipient included. */
export function canonicalizeEnvelope(
  e: Pick<MeshEnvelope, 'sender' | 'recipient' | 'command' | 'epoch' | 'nonce' | 'timestamp'>,
): string {
  return JSON.stringify([e.sender, e.recipient, e.command, e.epoch, e.nonce, e.timestamp]);
}

/** Build + sign an outgoing command envelope naming THIS sender + the recipient. */
export function signEnvelope(
  parts: { sender: MachineId; recipient: MachineId; command: MeshCommand; epoch: number; nonce: string; timestamp: number },
  sign: (canonical: string) => string,
): MeshEnvelope {
  return { ...parts, signature: sign(canonicalizeEnvelope(parts)) };
}

export type VerifyReason =
  | 'ok'
  | 'wrong-recipient'
  | 'signature-invalid'
  | 'unknown-sender'
  | 'replayed-nonce'
  | 'stale-timestamp';

export interface VerifyEnvelopeDeps {
  /** This machine's id — the envelope's `recipient` MUST equal it. */
  selfMachineId: MachineId;
  /** Verify the Ed25519 signature over `canonical` against `sender`'s REGISTERED key. */
  verify: (canonical: string, signature: string, sender: MachineId) => boolean;
  /** Is `sender` a registered peer machine of THIS agent? */
  isRegisteredPeer: (sender: MachineId) => boolean;
  /** Has this nonce been seen for `sender` (replay guard, NonceStore-backed)? */
  seenNonce: (sender: MachineId, nonce: string) => boolean;
  /** Wall clock (injectable). */
  now: () => number;
  /** Max |now - timestamp| (ms). Default 30000. */
  clockToleranceMs?: number;
}

/**
 * The 5-step receipt verification (spec §L0), evaluated IN ORDER. Pure: it does
 * NOT record the nonce — the caller records it ONLY on a fully-accepted command
 * (after RBAC), so a rejected command never burns a nonce.
 */
export function verifyEnvelope(env: MeshEnvelope, deps: VerifyEnvelopeDeps): { ok: boolean; reason: VerifyReason } {
  const tol = deps.clockToleranceMs ?? 30000;
  // (1) recipient-bound: a command signed for A cannot be replayed to C.
  if (env.recipient !== deps.selfMachineId) return { ok: false, reason: 'wrong-recipient' };
  // (2) signature valid for the claimed sender's registered key.
  if (!deps.verify(canonicalizeEnvelope(env), env.signature, env.sender)) return { ok: false, reason: 'signature-invalid' };
  // (3) sender is a registered peer of this agent.
  if (!deps.isRegisteredPeer(env.sender)) return { ok: false, reason: 'unknown-sender' };
  // (4) nonce unseen (replay guard).
  if (deps.seenNonce(env.sender, env.nonce)) return { ok: false, reason: 'replayed-nonce' };
  // (5) timestamp within tolerance.
  if (Math.abs(deps.now() - env.timestamp) > tol) return { ok: false, reason: 'stale-timestamp' };
  return { ok: true, reason: 'ok' };
}

export type RbacReason =
  | 'ok'
  | 'not-router'
  | 'claim-unauthorized'
  | 'release-unauthorized'
  | 'drain-unauthorized'
  | 'slice-renew-unauthorized'
  | 'mandate-deliver-unauthorized'
  | 'handback-offer-unauthorized';

export interface RbacDeps {
  /** The machine currently holding the router lease (verify-on-read, §L1), or null. */
  routerHolder: () => MachineId | null;
  /** The current owner machine of a session, or null. */
  ownerOf: (session: string) => MachineId | null;
  /** The machine the router last assigned (via place/transfer) for a session, or null. */
  placementTargetOf: (session: string) => MachineId | null;
  /**
   * WS5.2 R7a — the operator-mandate gate for the `slice-renew` verb. Returns true ONLY when the
   * authorizing mandate authorizes (sender, accountId, requesting fingerprint) for account follow-me
   * — deny-by-default. INJECTED so the dangerous authority decision is a real check, never an
   * inherit. ABSENT ⇒ the verb is refused (fail-closed): on a build without the seam wired, a
   * slice-renew can never be authorized. Mirrors the deny-by-default discipline of R3a/R4a.
   */
  authorizeSliceRenew?: (args: {
    sender: MachineId;
    mandateId: string;
    accountId: string;
    requestingMachineFp: string;
  }) => boolean;
  /**
   * WS5.2 R4a — the gate for `account-follow-me-mandate-deliver`. Returns true ONLY when account
   * follow-me is ENABLED on this machine AND the sender is THIS machine's trusted operator machine
   * (the verified-operator binding). Deny-by-default: ABSENT ⇒ the verb is refused (fail-closed) —
   * on a build without the seam wired, or on a non-dev/dark agent, a delivered mandate can never be
   * accepted at the gate. This is ONLY the coarse "should I even look at it" gate; the LOAD-BEARING
   * authority is the R4a asymmetric signature verification in the handler, which re-binds to the
   * authenticated sender + registered operator key. Mirrors the deny-by-default discipline of R3a.
   */
  authorizeMandateDeliver?: (args: { sender: MachineId }) => boolean;
}

/**
 * Per-command authorization gate (spec §L0). A valid signature proves WHO; this
 * proves they MAY. Runs BEFORE any state read/write. `sender` is the verified
 * envelope sender; `command` is its command.
 */
export function checkCommandRBAC(command: MeshCommand, sender: MachineId, deps: RbacDeps): { ok: boolean; reason: RbacReason } {
  const isRouter = deps.routerHolder() === sender;
  switch (command.type) {
    case 'place':
    case 'transfer':
    case 'deliverMessage':
      // Router-only (the router forwards inbound messages to the session owner — §L4).
      return isRouter ? { ok: true, reason: 'ok' } : { ok: false, reason: 'not-router' };
    case 'drain':
      // WS1.2: router-only with its OWN refusal reason (spec: "a NEW mesh verb
      // with its own router-only RBAC case"). Only the transfer planner — the
      // lease-holder — may order an owner to drain; a peer (even the transfer
      // TARGET) may not.
      return isRouter ? { ok: true, reason: 'ok' } : { ok: false, reason: 'drain-unauthorized' };
    case 'handback-offer':
      // U4.4 (R-r2-2): only the CURRENT lease holder may offer the lease back —
      // verified against the live lease view, default-deny, its OWN refusal
      // reason (mirrors the drain verb's posture). A non-holder — including the
      // preferred captain itself — can never manufacture a hand-back offer;
      // the LOAD-BEARING authority remains the holder-signed consent token the
      // handler verifies at acquire time (this gate is the coarse pre-filter).
      return isRouter ? { ok: true, reason: 'ok' } : { ok: false, reason: 'handback-offer-unauthorized' };
    case 'claim': {
      // The router's assigned target for this session, OR the router on a failover re-place.
      if (deps.placementTargetOf(command.session) === sender) return { ok: true, reason: 'ok' };
      if (isRouter && command.failover === true) return { ok: true, reason: 'ok' };
      return { ok: false, reason: 'claim-unauthorized' };
    }
    case 'release': {
      // The current owner, OR the router during a fenced failover.
      if (deps.ownerOf(command.session) === sender) return { ok: true, reason: 'ok' };
      if (isRouter && command.failover === true) return { ok: true, reason: 'ok' };
      return { ok: false, reason: 'release-unauthorized' };
    }
    case 'slice-renew': {
      // WS5.2 R7a — OPERATOR-MANDATE-GATED, deliberately its OWN case (NOT the
      // "any registered peer" read class). verifyEnvelope already proved WHO; this
      // proves the operator's mandate AUTHORIZES this requester to borrow this
      // account's spend. DENY-BY-DEFAULT: with no `authorizeSliceRenew` seam wired,
      // or when the mandate does not authorize (sender, account, requesting fp), the
      // verb is refused. The FENCED-single-writer "only the lease holder issues"
      // check lives in the handler/SliceIssuer (a non-holder still refuses there);
      // the gate's job is the mandate authorization, before any issuance work.
      const authd = deps.authorizeSliceRenew?.({
        sender,
        mandateId: command.mandateId,
        accountId: command.accountId,
        requestingMachineFp: command.requestingMachineFp,
      }) ?? false;
      return authd ? { ok: true, reason: 'ok' } : { ok: false, reason: 'slice-renew-unauthorized' };
    }
    case 'account-follow-me-mandate-deliver': {
      // WS5.2 R4a — deliberately its OWN case (NOT the "any registered peer" read class). The
      // RBAC gate proves the sender is a registered ACTIVE peer (verifyEnvelope already did the
      // crypto) AND that follow-me is enabled with this sender bound as the operator machine.
      // DENY-BY-DEFAULT: with no `authorizeMandateDeliver` seam wired, or when the sender is not
      // the trusted operator machine / the feature is dark, the verb is refused HERE — before the
      // handler runs. The LOAD-BEARING authority is still the R4a signature re-verification in the
      // handler (this gate is the coarse, fail-closed pre-filter).
      const authd = deps.authorizeMandateDeliver?.({ sender }) ?? false;
      return authd ? { ok: true, reason: 'ok' } : { ok: false, reason: 'mandate-deliver-unauthorized' };
    }
    case 'commitment-mutate':
      // MUTATING verb, deliberately its OWN case (COMMITMENTS-COHERENCE-SPEC
      // §3.4/§5): any registered peer may issue it under the same-operator
      // posture — meaning RBAC adds NO authorization beyond verifyEnvelope,
      // WHICH IS THE INTENDED SOLE AUTHORITY (stated so no reviewer assumes
      // a role check exists). The owner re-validates every transition through
      // the unchanged commitment state machine; replay is fenced by the
      // durable owner-side opKey window.
      return { ok: true, reason: 'ok' };
    case 'capacity-report':
    case 'session-status':
    case 'pool-stream-ticket':
    case 'journal-sync':
    case 'working-set-pull':
    case 'topic-profile-pull':
    case 'commitments-sync':
    case 'preferences-sync':
    case 'state-snapshot':
    case 'pool-view-fetch':
    case 'secret-share':
      // Read/observe class (or e2e-encrypted) — any registered peer (already
      // proven a registered peer by verifyEnvelope). journal-sync joins this
      // class: it serves/applies own-stream coherence-journal deltas, which are
      // self-binding (first-hop sender binding fences forged entries in the
      // applier) — no router/owner role is required. working-set-pull joins
      // it (WORKING-SET-HANDOFF-SPEC §3.2): it serves OWN jailed working
      // files behind a fresh-manifest allowlist (disclosure accepted for
      // registered same-operator peers, §3.1 note); the handler itself stays
      // dark unless replication is explicitly enabled (§3.7 gate).
      // topic-profile-pull joins it (TOPIC-PROFILE-SPEC §5.3): it serves OWN
      // per-topic profile entries — disclosure-only for registered
      // same-operator peers; the receiver revalidates every field (§10.2)
      // before anything persists, so the verb carries reach, not authority.
      // pool-view-fetch joins it (MULTI-MACHINE-SEAMLESSNESS-SPEC §WS4.4): the
      // verb is reachable by any registered peer, but its HANDLER is the real
      // gate — it serves a private view body ONLY when the carried user-auth
      // ASSERTION verifies (audience-bound to this holder + this view + this
      // method, single-use, signed by the authenticated sender) AND the
      // holder's own per-view authorization passes. The probeOnly shape
      // discloses only existence (not the body) to a registered peer.
      // state-snapshot joins it (multi-machine-replicated-store-foundation
      // §6.1/§6.3): the HOLDER serves a SINGLE-ORIGIN snapshot of a store it
      // authored to a registered same-operator peer. It is self-binding —
      // origin === the authenticated sender end-to-end, and the recovering
      // machine re-validates every record's origin before landing (a
      // cross-origin record rejects the whole snapshot), so no router/owner role
      // is required; the handler itself stays dark unless the store is enabled.
      return { ok: true, reason: 'ok' };
    default:
      return { ok: false, reason: 'claim-unauthorized' };
  }
}

/**
 * Full acceptance gate: verify (who) THEN RBAC (may). Returns the first failure's
 * reason. The caller records the nonce ONLY when this returns ok (so a rejected
 * command never consumes a nonce). Convenience over verifyEnvelope + checkCommandRBAC.
 */
export function acceptEnvelope(
  env: MeshEnvelope,
  verifyDeps: VerifyEnvelopeDeps,
  rbacDeps: RbacDeps,
): { ok: boolean; reason: VerifyReason | RbacReason } {
  const v = verifyEnvelope(env, verifyDeps);
  if (!v.ok) return v;
  return checkCommandRBAC(env.command, env.sender, rbacDeps);
}

// ── Dispatcher (transport-agnostic: the receive side of MeshRpc) ──────

/** A handler for one command type. Receives the (already-authorized) command, the
 *  verified sender, and the full envelope (for nonce/epoch/timestamp, e.g. the
 *  per-session ownership CAS uses `env.nonce`). */
export type MeshCommandHandler = (command: MeshCommand, sender: MachineId, env: MeshEnvelope) => Promise<unknown> | unknown;

export interface MeshRpcDispatcherDeps {
  verify: VerifyEnvelopeDeps;
  rbac: RbacDeps;
  /** Record a nonce as seen (NonceStore-backed) — called ONLY on full accept. */
  recordNonce: (sender: MachineId, nonce: string) => void;
  /** Per-command handlers. A missing handler → `no-handler` (the command is verified+authorized but unimplemented on this layer). */
  handlers: Partial<Record<MeshCommand['type'], MeshCommandHandler>>;
  /** Audit sink for rejections (SecurityLog). Optional. */
  onReject?: (env: MeshEnvelope, reason: string) => void;
  logger?: (msg: string) => void;
}

export type DispatchResult =
  | { ok: true; result: unknown }
  | { ok: false; reason: VerifyReason | RbacReason | 'no-handler'; status: number };

/** HTTP status for each rejection reason — auth failures 401/403, freshness 409, unimplemented 501. */
function statusForReason(reason: string): number {
  switch (reason) {
    case 'wrong-recipient':
    case 'signature-invalid':
    case 'unknown-sender':
      return 401;
    case 'not-router':
    case 'claim-unauthorized':
    case 'release-unauthorized':
    case 'drain-unauthorized':
    case 'slice-renew-unauthorized':
    case 'mandate-deliver-unauthorized':
    case 'handback-offer-unauthorized':
      return 403;
    case 'replayed-nonce':
    case 'stale-timestamp':
      return 409;
    case 'no-handler':
      return 501;
    default:
      return 400;
  }
}

/**
 * The receive side of MeshRpc — transport-agnostic (the HTTP route, or a tunnel
 * carrier, calls `dispatch(envelope)`). Runs the two gates (verify THEN rbac),
 * records the nonce ONLY on full accept (a rejected command never burns a nonce),
 * audits rejections, then routes to the registered handler. Returns a result +
 * an HTTP status so any transport can map it.
 */
export class MeshRpcDispatcher {
  private readonly d: MeshRpcDispatcherDeps;
  constructor(deps: MeshRpcDispatcherDeps) {
    this.d = deps;
  }

  async dispatch(env: MeshEnvelope): Promise<DispatchResult> {
    const accept = acceptEnvelope(env, this.d.verify, this.d.rbac);
    if (!accept.ok) {
      this.d.onReject?.(env, accept.reason);
      this.d.logger?.(`[mesh-rpc] rejected ${env.command?.type} from ${env.sender}: ${accept.reason}`);
      return { ok: false, reason: accept.reason, status: statusForReason(accept.reason) };
    }
    // Accepted — burn the nonce so an immediate replay is caught.
    this.d.recordNonce(env.sender, env.nonce);
    const handler = this.d.handlers[env.command.type];
    if (!handler) {
      return { ok: false, reason: 'no-handler', status: statusForReason('no-handler') };
    }
    const result = await handler(env.command, env.sender, env);
    return { ok: true, result };
  }
}
