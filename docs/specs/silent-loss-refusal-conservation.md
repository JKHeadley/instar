---
title: "Silent-Loss Eradication — Refusal Conservation + the Wiring-Time Registry Gate: Spec"
slug: "silent-loss-refusal-conservation"
author: "echo"
parent-principle: "A Refusal Stays a Refusal — conservation of negative outcomes"
sibling-principles: "Cross-Store Coherence Is an Invariant; Test Identity Never Enters Production State; Runtime End-to-End Proof — the canary standard (G4 delivery-canary is its named first application) (all four ratified 2026-07-01, merged PR #1316); Verify the State, Not Its Symbol; Know Your Principal; The Agent Is Always Reachable; The User Experience Is the Product (umbrella — #1280, still awaiting ratification, cited aspirationally not as the resolving parent)"
eli16-overview: "silent-loss-refusal-conservation.eli16.md"
status: "approved"
approved: true
approved-by: "operator pre-approval — Justin, topic 29836, 2026-07-01: full 24h-session pre-approval for this postmortem project's specs and decisions (exercised by Echo; operator may revoke). Stamped approved after 5-round spec-converge reached zero material findings (report: docs/specs/reports/silent-loss-refusal-conservation-convergence.md)."
principal-deferral-approval: "operator pre-approval <!-- tracked: fb-1e751537-655 --> — Justin, topic 29836, 2026-07-01: the full ack-vocabulary split (wire-accepted / durably-queued / injected) is a recurrence-risking deferral (P10) <!-- tracked: fb-1e751537-655 --> explicitly signed off for a follow-up PR; <!-- tracked: fb-1e751537-655 --> this spec lands the SAFETY property (no rejection reads as delivery success — enforced by the ratchet across forwardToOwner, forceReplace, AND the drain maxAttempts escape) without the vocabulary split, and re-documents the `acked` field contract in the same PR so the field cannot be read as delivery success in the interim."
supervision-tier: "tier0-on-path (deterministic BY REQUIREMENT of the parent principle: an LLM on the inbound refusal path can fail closed under the very degradation that causes rejections — the incident's own failure mode). Tier-1 SUPERVISION is present ON THE OPERATED INSTANCE NOW (the echo fleet's G1 coherence-audit job (Haiku, daily) reads registry health + `logs/mesh-rejections.jsonl`; the G4 delivery-canary proves the path end-to-end on a cadence) — this holds PER-INSTALL, not universally; generalized fleet-wide job templates are tracked-followup (4), so a fresh install runs tier0-on-path with supervision as the tracked follow-up <!-- tracked: fb-bcba3acc-a0d --> (increments A-E close the incident deterministically fleet-wide regardless). Honest scope: not a tier omission, but supervision is operated-instance-now / fleet-wide-tracked."
parent-spec: "docs/postmortems/2026-07-01-silent-telegram-message-loss.md (the incident); DURABLE-INBOUND-MESSAGE-QUEUE spec §3.4 (the sender re-validation this hardens); MULTI-MACHINE-SESSION-POOL-SPEC §L4 (the ack protocol)"
upstream-filings: "fb-1e751537-655 (U1 silent loss), fb-b15ac10b-85c (U2 fixture clobber / wiring gate)"
lessons-engaged:
  - "A Refusal Stays a Refusal (PARENT): a terminal negative outcome must stay distinguishable from success at every boundary — the RouteOutcome action union gains a first-class 'rejected'; EVERY consumer is enumerated (an added union member does NOT force a TS error at a boolean/if-chain consumer — round-1 integration #1); the ratchet pins forwardToOwner AND forceReplace AND the drain maxAttempts escape (round-2 adversarial #M1)."
  - "Cross-Store Coherence Is an Invariant: the never-populated vs emptied-by-deletion states are byte-identical `[]` on disk (round-2 lessons — `init.ts` seeds `[]`, no high-water signal exists), so a DURABLE 'registry has held a real user' high-water marker disambiguates them; local-resolves/remote-rejects raises a coherence signal (advisory, feeds G1)."
  - "Test Identity Never Enters Production State: fixture refusal fires at the write path (typed throw), loadUsers()/merge (refuse-and-skip-with-alert, never throw — a constructor throw fails boot), AND a one-time boot remediation of already-polluted stores; the escape is double-keyed (env + on-disk test-home marker); a legitimate collision uses a dashboard-PIN-authed, profile-persisted SIGNED allow-marker (round-2 security #2 / adversarial #M2)."
  - "Verify the State, Not Its Symbol: the wiring gate probes REAL registry state (listUsers + high-water + operator-resolution) never a config flag; the empty `[]` symbol is NOT read as a state it cannot distinguish."
  - "Know Your Principal: the degenerate fail-open declines the SENDER re-validation layer (defense-in-depth atop the already-signed, router-only, recipient-bound MeshRpc envelope — foundation-confirmed round-2), never invents a principal; UserManager stays the single authority; the topic-operator store may only VETO arming + recognize its own bound operator (and only when the DECIDING machine holds that local binding — round-2 adversarial minor)."
  - "P4 Testing Integrity: three tiers + named safety-invariant tests (§3) + a Live-User-Channel Proof exercise on a throwaway home (Telegram + Slack), signed matrix, before the operator tests."
  - "Bounded Notification Surface + operator conservative-notification directive (2026-07-01): the loss notice, the disarmed alert, and the divergence alert are ONE deduped message each per (topic|cause) / (machine|cause) window to EXISTING topics only; live + drain UNIFY on ONE canonical cause enum; the cross-topic ceiling + a flapping-proof decay (time-since-first-observed, sustained-clear reset) keep a degenerate peer from flooding."
tracked-followups: "Each deferral has ACTIVE follow-through: a live item in the operated feedback factory AND a child of the `self-healing-mesh` project (topic 29836), <!-- tracked: fb-1e751537-655 --> re-surfaced on a cadence (Close the Loop). (1) Full ack-vocabulary split (wire-accepted/durably-queued/injected) — needs an owner→router second ack + §L4 changes; operator-signed under `principal-deferral-approval` — DEFERRED <!-- tracked: fb-1e751537-655 -->; `acked` is re-documented in-PR so the interim can't regress. (2) Automatic bounded RE-PLACE onto the registry-resolving machine on divergence (this spec lands the SIGNAL only) — DEFERRED <!-- tracked: fb-1e751537-655 -->. (3) Sunset the senderEnvelope-absent version-skew bypass once all peers advertise the capability flag — AND, at that time, add `senderEnvelope` + the `rejected`→notice branch at the g3 lease-gated spawn-forward site (server.ts ~L2329), which is scoped-OUT now because it carries no envelope (round-2 integration #M2) — DEFERRED <!-- tracked: fb-b15ac10b-85c -->. (4) Slack SENDER re-validation (the decision side is Telegram-only today — `resolveFromTelegramUserId`, non-numeric Slack uid fails-open; increment C ships Slack NOTICE parity, not Slack sender re-validation) — DEFERRED <!-- tracked: fb-1e751537-655 -->. (5) Generalized coherence-audit + delivery-canary job templates for all installs — DEFERRED <!-- tracked: fb-bcba3acc-a0d -->."
review-convergence: "2026-07-02T02:16:16.097Z"
review-iterations: 5
review-completed-at: "2026-07-02T02:16:16.097Z"
review-report: "docs/specs/reports/silent-loss-refusal-conservation-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
cross-model-review-reason: "codex GPT-5.5 + Gemini 2.5 Pro every round; R1-R5, never degraded"
single-run-completable: true
frontloaded-decisions: 25
cheap-to-change-tags: 0
contested-then-cleared: 0
---

## 1. Problem

On 2026-07-01 every Telegram message from the verified OPERATOR was silently dropped
for most of a day (postmortem: `docs/postmortems/2026-07-01-silent-telegram-message-loss.md`).
Three stacked defects, all still present on main:

1. **A refusal is encoded as success at the routing boundary.**
   `SessionRouter.forwardToOwner` maps the owner-side `sender-rejected` NACK to
   `{action: 'forwarded', owner, detail: 'sender-rejected', acked: true}`
   (`src/core/SessionRouter.ts` ~L281). Consumers switch on `action` and see a
   successful forward; only the queue-drain consumer special-cases the `detail`
   string; the route observability line prints only action/owner/acked. Both
   machines' logs read as success while the message is terminally dropped.
2. **The receiving side keeps zero trace of its own rejection.**
   `DeliverMessageHandler` returns the `sender-rejected` NACK BEFORE
   `recordReceipt` (correct — a redelivery must re-NACK, not dedupe into
   `duplicate`) but also before ANY logging/trace. The deciding machine is
   forensically blank; the incident was diagnosed from the SENDER's ledger.
3. **Sender re-validation arms against a registry that cannot resolve anyone.**
   The `validateSender` closure (`src/commands/server.ts` deliverMessage wiring,
   ~L17306) is armed unconditionally. On the incident fleet one machine's
   `users.json` was fixture-clobbered 19 days earlier (the other's was missing) —
   a registry in that degenerate state rejects EVERY forwarded sender including
   the operator. Nothing validated the store at wiring time; nothing refuses
   fixture identities at the registry layer (write OR load).

## 2. Design

Five increments. A/B/E are pure honesty + hygiene (behavior identical on every
healthy path). C fires only where today's behavior is silent loss. D's gate fires
only in degenerate states that today mean total rejection of everyone. Rationale
for always-on (no dark gate) in §5; every increment's failure mode has a named
safety-invariant test in §3.

**Implementation summary (the concrete flow, for the implementer — round-5 codex):**
a message arrives on the ingress machine but the conversation is owned by a peer →
`SessionRouter.forwardToOwner` sends a signed `deliverMessage` → the owner's
`validateSender` runs (armed only if its registry is healthy, per D) → if the owner
NACKs `sender-rejected`, `forwardToOwner` returns `RouteOutcome.action:'rejected'`
(A) instead of masquerading as `forwarded` → the ingress machine's live/drain
consumer sees `rejected`, terminal-returns WITHOUT local dispatch, settles the
exactly-once ledger row `markRejected` (C, enumerated into every `LedgerState`
consumer), sends the ONE neutral user notice via the originating adapter (C), and
writes a metadata-only trace row on the owner (B). The owner's gate (D) never arms
against a MISSING / never-populated-`[]` / corrupt / operator-unresolvable registry
(it fails toward delivery loudly instead of rejecting everyone), and refuses
fixture identities at the registry write + load layers. That is the whole change;
everything below is the precise behavior of each step and its failure modes.

### A. RouteOutcome honesty — first-class `rejected`, EVERY consumer enumerated

- `RouteOutcome.action` gains `'rejected'`. `forwardToOwner`'s sender-rejected arm
  returns `{action: 'rejected', owner, detail: 'sender-rejected', acked: true}`.
  `acked: true` is retained (§L4 advances the platform offset on any typed
  terminal answer; re-delivery is the queue's job) and its type-doc is rewritten:
  **transport-terminal only, NEVER delivery success** (round-1 codex #4).
- **Every consumer enumerated + terminal-return before local dispatch** (round-1
  integration #1 — a union member does NOT error at a boolean helper / if-chain):
  - Telegram live (`server.ts` ~L2186): today `isRemotelyHandled('rejected')`
    returns false → falls through to local inject at ~L2216. Insert an explicit
    `action === 'rejected'` branch BEFORE the `isRemotelyHandled` test → notice
    (§C) + terminal-return (no local dispatch — the 2026-05-31 double-dispatch
    class). Passes a real envelope (~L2175).
  - Slack live (`server.ts` ~L7100 → `slackInboundDispatch` ~L7119): same explicit
    `rejected` branch before fall-through; passes a real envelope (~L7090). Notice
    via the Slack adapter (in-increment, §C).
  - Drain (`_drainLocalDeliver` ~L2396): today keys on `action==='forwarded' &&
    detail==='sender-rejected'`; flip to `action==='rejected'` → `sender-deauthorized`
    + `reportLoss` + the unified notice.
  - **`forceReplace` (`SessionRouter.ts:226`)**: its boolean `outcome.acked &&
    action !== 'queued' && action !== 'placement-blocked'` returns TRUE for
    `rejected` → the drain maxAttempts escape flips the row `claimed→delivered`
    (adversarial #2). `forceReplace` MUST return a **distinct verdict** for
    `rejected` (not bare `false` — bare false lands in the escape's `else` →
    mislabels it `attempts-exhausted`, losing the cause + the divergence signal,
    round-2 adversarial #M1). The drain's maxAttempts escape maps that distinct
    verdict to the SAME `sender-deauthorized` terminal handling (unified notice +
    divergence probe).
  - `isRemotelyHandled` (`SessionRouter.ts:108`): asserts `false` for `rejected`
    (a rejection is not "remotely handled") — but the live callers' explicit
    `rejected` branch runs BEFORE it, so neither falls through.
  - g3 lease-gated spawn-forward (`server.ts` ~L2329): **scoped OUT** — it passes
    NO `senderEnvelope`, so it rides the acknowledged envelope-absent bypass and
    never produces `rejected` today. Wiring a branch here now is dead code.
    Tracked-followup (3) <!-- tracked: fb-b15ac10b-85c --> ties the bypass sunset to ALSO adding the envelope + the
    `rejected`→notice branch at this exact site (round-2 integration #M2).
  - (`SessionRecovery.ts ~L232` was a comment cite; the real recovery path funnels
    through `forwardPendingInboundViaRoute` → the already-enumerated drain
    consumer — no separate site.)
- **Exhaustive-switch refactor:** every RouteOutcome consumer becomes an
  exhaustive `switch` with `assertNever(action)` (or a lint ratchet), so a FUTURE
  union member is genuinely build-breaking.
- **Ratchet + wiring tests** (§3): the ack→outcome table; per-consumer
  `rejected` terminal-no-dispatch; `isRemotelyHandled(rejected)===false`;
  `forceReplace-never-reports-rejected-as-handled`;
  `rejected-via-forceReplace-escape-terminals-sender-deauthorized`.

### B. Receiver-side rejection trace — metadata-only, self-bounded

- `DeliverMessageHandlerDeps` gains `onRejected?: (meta: {reason:'sender-rejected';
  session:string; messageId:string; senderUid?:number}) => void` — **metadata-only**
  (the raw `command`/`payload` is NOT passed through the seam; round-1 security #1),
  synchronous before the NACK, try/catch-wrapped. NO receipt write on rejection.
- One structured log line + one JSONL row to `logs/mesh-rejections.jsonl` — fields
  exactly `{ts, reason, session, messageId, senderUid}`, never payload
  (`rejection-trace-never-contains-payload` test), 0600 — **and the append path
  re-chmods 0600 after any `maybeRotateJsonl` rewrite** (round-3 integration #2:
  the rotator rewrites via `writeFileSync` with no mode → 0644, so 0600 must be
  re-applied post-rotation; blast radius is small — metadata-only rows — but the
  0600 property must not silently lapse).
- **Bounding is via `maybeRotateJsonl(logPath, {maxBytes, keepRatio:0.5})` on the
  APPEND path ONLY** (the `SecurityLog`/`ExternalOperationGate` pattern; verified
  signature `jsonl-rotation.ts:53`) — NOT the `SessionMaintenanceRunner` allowlist,
  which only rotates `<stateDir>/` files and `logs/` is a sibling of stateDir
  (`server.ts:735`), so an allowlist entry is a dead no-op (round-2 integration #M1).
- A per-`(session,messageId)` in-memory suppression **short-circuits `validateSender`
  itself** (serve the cached NACK verdict WITHOUT re-reading the registry) so a
  peer replaying one rejected messageId at high rate cannot force an unbounded
  `readFileSync` per replay on the event loop (round-2 adversarial #M4 / scalability).
  The suppression map is **bounded (the established `QueueDrainLoop.refusalCache`
  1024-cap prune pattern + a 10-min TTL)** so a flood of DISTINCT messageIds cannot
  trade the CPU/read-DoS for a memory-DoS (round-3 scalability + adversarial minor);
  the durable ledger already retains per-messageId state, so eviction only loses the
  cheap short-circuit, never correctness.

### C. Deterministic, UNIFIED loss notice on the refusing path

- On a `rejected` outcome for a **user-originated** message, send ONE deterministic
  notice to the topic via the **ORIGINATING adapter** (Telegram `sendToTopic` /
  Slack in-thread reply where the message arrived) — fire-and-forget with swallowed
  error, never the LLM tone gate.
  **User-originated predicate (frontloaded):** a real platform sender uid AND a
  topic actually bound in the adapter — A2A / job / sentinel / delivery-canary
  session keys excluded (the canary's bogus-uid probes never trip a notice).
- **Neutral fixed template, no speculation, no probing invitation, NO topology
  leak** (security #6 + round-4 codex #2 — the earlier wording named "the machine
  that owns this conversation" / "both machines", exposing internal multi-machine
  topology to a user): *"I got your message but couldn't confirm you as an approved
  sender, so it wasn't delivered. I've logged the details so this can be
  diagnosed."* — no architecture, no "registry out of sync", no resend invitation.
- **UNIFIED with the queue-drain loss notice** (`QueueDrainLoop` reportLoss ~L729):
  both route through ONE shared helper keyed on ONE **canonical cause enum**
  (`sender-deauthorized` — live `sender-rejected` normalizes to it, so the two
  paths can't emit two differently-worded notices; round-2 decision minor). Dedupe
  is durable, keyed on **messageId** (a marker on the ledger row, survives restart),
  with the 30-min (topic, cause) window a secondary cross-message bound.
- **Terminally settle the exactly-once ledger row via a DISTINCT `markRejected`
  terminal — ENUMERATED into EVERY `LedgerState` consumer** (round-3 + round-4
  adversarial). A distinct `rejected` terminal (reply_committed_at NULL, moved OUT
  of `processing`) is kept because the parent principle demands a refusal stay
  DISTINGUISHABLE from a retry-exhaustion (`abandoned`) even at the ledger layer —
  conflating them into `markAbandoned` would undercut this spec's own thesis.
  **But widening `LedgerState` carries the SAME "enumerate every consumer"
  obligation §A applies to `RouteOutcome`** (round-4 adversarial material — the fix
  otherwise re-opens the double-notify on REDELIVERY): `'rejected'` MUST be wired
  into all three ledger consumers, or a provider redelivery of the same `update_id`
  falls through to `process`, `beginProcessing` flips the terminal row back to
  `processing` (attempts++), and stuck-recovery eventually `markAbandoned`s it →
  the generic "I didn't get to N message(s)" notice fires on top of the §C notice.
  Enumerate `'rejected'` into: (1) `ingressDedup.decideIngress`'s terminal-drop
  branch (`ingressDedup.ts:78` — so a redelivered rejected `update_id` is DROPPED,
  never re-routed); (2) `MessageProcessingLedger.beginProcessing`'s terminal-drop
  guard (`~L190`, alongside reply_committed/cursor_advanced/abandoned — so it can
  never be flipped back to `processing`); (3) `isActedOn` (`~L179`). Tests:
  `rejected-redelivery-is-dropped-and-not-resurrected` (ingress-ledger — distinct
  from the owner-side `reject-still-rejects-on-redelivery`) +
  `rejected-message-does-not-produce-a-stuck-recovery-loss-notice`.
  **Rationale corrected (round-4):** a row settled terminally by increment C is
  never the double-notify source on its OWN — `reclaimStuck` selects `WHERE
  state='processing'` and `abandoned[]` only carries rows abandoned in the CURRENT
  pass (`stuckMessageRecovery.ts:129-131`), so a directly-settled terminal is never
  re-surfaced; the double-notify risk is ONLY via the redelivery-resurrection path
  above, which the three-consumer enumeration closes. Makes §L4 "never retried"
  true at the ledger, the §C notice the SOLE user notice.
- **Cross-topic ceiling + flapping-proof decay** (adversarial #8, #M3 — the
  noise-directive guard): once >3 distinct topics are rejected for one (peer, cause)
  in a window, suppress per-topic notices and emit ONE aggregated alert to the
  operator hub topic naming the peer + count. The per-(peer,cause) re-notice cadence
  decays 30m → 2h → 6h based on **time-since-first-observed**, and the step only
  fully resets after the cause has been CLEAR for a sustained window (≥ the longest
  decay step) — so a peer flapping degenerate↔healthy cannot re-arm the fast cadence.
- **Sender-side divergence signal (adversarial #9):** the ingress machine probes
  its OWN (cached) registry for the rejected uid; local-resolves + remote-rejects
  raises ONE deduped coherence alert naming the peer, feeding the G1 audit ONLY —
  never auto-remediation (it cannot distinguish a degenerate registry from a
  lawful deauth still replicating; round-2 adversarial minor). Auto re-place is
  tracked-followup (2). <!-- tracked: fb-1e751537-655 -->

### D. Wiring-time registry gate + per-call re-arm + registry fixture refusal (U2)

- **Per-call arm decision, cached read.** `validateSender` re-decides arm/disarm
  per message so a restored registry re-arms with no restart. The registry read is
  **stat-gated on `(mtimeMs, size)`** (`statSync` → reload + re-classify only when
  `users.json` changed; round-2 scalability #1 / adversarial #M4) — size is paired
  with mtime so a same-`mtimeMs`-tick double-write can't serve a stale
  classification (round-3 scalability/adversarial minor) — so repeated messages
  under a degenerate broadcast collapse to O(1), while preserving the "restored
  registry re-arms within one write" freshness. The load uses a **read-only mode that does NOT run
  the `initialUsers` merge** (which can `writeFileSync` per message).
- **Degenerate classification (`Verify the State`), with a durable disambiguator:**
  a fresh install writes `users.json` as `[]` and there is no persisted
  "ever-populated" signal, so never-populated and emptied-by-deletion are
  byte-identical (round-2 lessons material #1). A durable **high-water marker**
  (`state/registry-high-water.json`) disambiguates. **Set-point (round-3
  integration #1 — the installed-base fix):** high-water is set on EVERY
  real-user-introduction path that writes the AUTHORITATIVE local `users.json` —
  an API/CLI register of a non-fixture user and a non-fixture `initialUsers` merge
  (NOT a WS2.6 replication-in: WS2.6 records are advisory and do NOT enter
  `users.json`, so high-water tracks "the local authoritative registry held a
  resolvable real user", never merely "the agent has seen one somewhere" —
  round-4 lessons coherence); AND the §4 boot migration (write-capable, unlike the
  read-only probe) **back-fills** it whenever it observes ≥1 surviving non-fixture
  user in a store with no marker. Without this, a pre-upgrade /
  merge-populated / replicated store carries no marker, so emptying it later would
  misclassify as never-populated and fail open — the back-fill is what makes the
  emptied-by-deletion → POPULATED clause reachable for the installed base.
  High-water is **monotonic** — never cleared on user removal. (It is machine-local
  unsigned state that shares the `users.json` trust boundary: flipping it in the
  dangerous direction needs the same local FS access as clobbering `users.json`
  itself, so it needs no separate integrity envelope — at-rest honesty, security
  round-3 nit.)
  - MISSING / ENOENT / `[]`-with-NO-high-water (never populated) → **degenerate**
    → skip sender re-validation for this message (fail toward delivery) +
    rate-limited loud log (1/min per cause) + deduped alert.
  - `[]`-WITH-high-water (emptied by deleting the last real user locally) →
    **POPULATED** → keep rejecting unresolved senders + HIGH alert (closes the
    security-#2 downgrade). (A WS2.6 tombstone is NOT listed here — WS2.6 records
    are advisory and do NOT mutate `users.json`, so a peer tombstone cannot
    produce this state; security round-3 consistency fix.)
  - **parse-failure / partially-written / raw-non-empty-but-unparseable →
    `UNKNOWN_UNSAFE`** (round-3 codex external): this is NOT "never populated" —
    it is corruption / a partial write / tampering / a schema mismatch. Fail
    **CLOSED** (keep rejecting unresolved senders) + HIGH alert. Only a clean
    ENOENT or a valid-but-empty `[]`-with-no-high-water fails toward delivery; a
    store that has ANY content it cannot parse, OR any high-water / backup
    evidence of prior population, never silently opens delivery to unresolved
    senders. (The operator path still resolves via the local topic-operator
    binding where the deciding machine holds it — Know Your Principal.)
    **Conservation (round-4 codex #1):** an `UNKNOWN_UNSAFE` rejection of a
    user-originated message flows through the SAME `rejected` RouteOutcome → §C
    user notice + §B trace, not merely a HIGH operator alert — so the SENDER is
    told (the parent principle: every rejection is conserved through the notice
    path, never dependent on the operator seeing an alert that could be missed).
  - **Operator-resolution store-HEALTH probe (PRIMARY arm; adversarial #5 / lessons
    #3):** for the CURRENT topic's LOCAL (authenticated-derived) topic-operator
    binding (O(1), not all bindings), verify the registry resolves that operator
    uid; unresolvable verified operator → disarm + the same alert. This reads ONLY
    the local-authoritative `users.json` — no WS2.6 tombstone/put can remove or
    alter a locally-bound operator's resolution (round-2 security #3; named test).
    **The invariant binds ALL `users.json` mutators, not just WS2.6** (round-3
    security minor): `UserPropagator.handleIncomingUser/Removal` (`src/users/UserPropagator.ts`)
    would write a REMOTE peer's `user-removed` straight into the LOCAL `users.json`
    via `upsertUser`/`removeUser` — a remote removal of the bound operator would
    disarm validation and re-create the incident. `UserPropagator` is currently
    UNWIRED (not instantiated in `server.ts`; only exported), so this is latent —
    a `user-propagator-stays-unwired` guard test pins that status so a future
    activation cannot silently void the local-authoritative invariant without also
    routing through the same fixture-refusal + operator-resolution guards.
- **Know-Your-Principal boundary:** `UserManager` stays the single authority. The
  topic-operator store may only (a) veto arming (above) and (b) recognize its own
  bound operator — and (b) applies only when the DECIDING (owner) machine holds
  that local binding; cross-machine, where the owner usually has no local binding
  (WS2.6 topic-operator is advisory), the operator's message is delivered
  fail-toward-reachability but flagged UNVERIFIED, never re-seated as a principal
  (round-2 adversarial minor). No arbitrary sender is ever resolved via the
  topic-operator store.
- **Boot probe is READ-ONLY** (round-2 decision #2): it classifies + alerts but
  performs NO self-heal write (a boot-time identity-store write must be a decision,
  not a "MAY"). Remediation of already-polluted stores is the one-time §4 migration.
- **Fixture refusal at BOTH layers** (security #5 / integration #7): `validateProfile`
  throws a typed error on API/CLI/registration WRITE paths for `TEST_IDENTITY_MARKERS`;
  `loadUsers()`/merge **refuse-and-skip-with-loud-alert** (never throw — a
  constructor throw fails boot). Escape: `INSTAR_ALLOW_TEST_IDENTITIES=1`
  **double-keyed** to an on-disk test-home marker (written only by the isolated
  test-home scaffold); env-set-but-marker-absent → refuse + alert.
- **Marker set + match rule — IDS + reserved tokens, NEVER display-name**
  (round-2 adversarial #10): exact match on the Slack ids `{U0BA7QGPBQS,
  U0BA5NW9QA2, U0B9SFJ7QAK, U0B9SFV2BAT, U0BA4L8RMFF}` + the harness ids
  `{u-olivia, u-adam, u-mia, u-cory, u-oscar, U_OLIVIA, U_ADAM, U_MIA, U_CORY,
  U_OSCAR}`; anchored reserved-token match on `livetest`/`g3test`-prefixed
  ids/usernames. Display-name is NEVER a match criterion (a real "Olivia"
  registers — `legitimate-user-named-Olivia-registers` test). Exported as
  `TEST_IDENTITY_MARKERS`.
- **Legitimate-collision override — dashboard-PIN authed + durable signed marker**
  (round-2 security #1/#2 + adversarial #M2, reconciled): a genuine collision uses
  `X-Instar-Allow-Identity: <matched-marker>`, which is accepted ONLY on a
  **dashboard-PIN-authenticated operator request** (a Bearer token is structurally
  insufficient — else any token-holder registers a fixture-with-owner-perms,
  reproducing the S3 escalation). The PIN check REUSES the existing `checkMandatePin`
  primitive (`routes.ts:7767` — sha256 + `timingSafeEqual` + per-IP rate-limit +
  403), never a hand-rolled compare (security round-3). The header value is
  validated equal to the specific matched marker from the closed set; the
  authenticated principal is audited; the raw header is never logged. On success
  the profile persists a **signed, load-verifiable** allow-marker
  (`allowTestIdentity: {marker, sig}` — NOT a bare boolean; on the WS2.6
  field-clamp denylist).
  **Signature scheme + HONEST threat model (round-3 security material — the
  load-bearing reframe):** `sig = HMAC-SHA256(key = a server-held key that lives
  in the encrypted vault and is loaded only by the server process — NOT the
  `authToken`/`dashboardPin` and NOT any state-dir file a plain `users.json`
  writer reads, msg = canonical(userId + ":" + marker))`. The PIN gates ONLY
  **minting**; **verification** on the load path (`loadUsers()` + §4 migration)
  recomputes the HMAC with NO PIN present. What the `sig` DOES defend: (a) a
  legitimately-minted override survives quarantine at every reboot with no
  operator online (the no-dead-end property); (b) the WS2.6 peer path — already
  covered by the field-clamp denylist, the `sig` is belt-and-suspenders there; (c)
  the ACTUAL incident — an accidental clobber that writes KNOWN fixture ids is
  caught by marker-pattern + quarantine regardless of `sig`. What it explicitly
  does NOT claim to defend (at-rest honesty): a **fully-FS-privileged local
  process** — such a process can read whatever the server reads AND can simply
  register a NON-fixture-looking id to evade the markers entirely, so NO file-layer
  control stops it; that adversary is out of scope for this mechanism (documented,
  not hand-waved). So the `sig` raises the bar against a data-only write by a
  process WITHOUT the vault key, and `forged-allow-marker-rejected` (writes
  `allowTestIdentity` with a bogus/absent `sig` → quarantined) has a well-defined
  threat model; `overridden-collision-survives-reboot` covers the legit path.
- **Sender re-validation scope = Telegram** (round-2 lessons minor): the resolver
  is `resolveFromTelegramUserId`; a non-numeric Slack uid fails-open today. The
  wiring gate + sender re-validation are explicitly scoped to Telegram; Slack
  sender re-validation is tracked-followup (4). <!-- tracked: fb-1e751537-655 --> Increment C's Slack NOTICE parity
  is independent and ships now.

### E. Agent Awareness (round-1 integration #8)

- `generateClaudeMd()` gains a section: *"user asks 'why did I get a
  message-not-delivered / sender-not-recognized notice?' → the owning machine
  didn't resolve the sender in its user registry; read `logs/mesh-rejections.jsonl`
  and check the registration path."* Plus a content-sniffed `migrateClaudeMd()`
  entry (existing agents).

## 2.1 Multi-machine posture (mandatory, complete)

| Surface | Posture | Reason |
|---|---|---|
| `logs/mesh-rejections.jsonl` | machine-local BY DESIGN | forensics of the DECIDING owner machine; replicating defeats "which machine decided". |
| loss-notice dedupe (durable messageId marker + 30-min window) | machine-local BY DESIGN | notice sender is the INGRESS machine by construction; the durable key is on that machine's ledger row. |
| ledger terminal-settle (increment C) | machine-local BY DESIGN | settled synchronously by the same ingress machine that consumed `rejected`. |
| cross-topic ceiling counter + decay state | machine-local, in-memory BY DESIGN | re-arms on a lease flip; bounded like the loss-notice dedupe. |
| wiring/disarm + re-arm alert | per-machine BY DESIGN | each machine has its own registry; both-degenerate ⇒ one alert each. |
| `state/registry-high-water.json` | machine-local BY DESIGN | each machine's own users.json history; a peer's high-water is irrelevant to this machine's arm decision. |
| `TEST_IDENTITY_MARKERS` | per-version code const | old peers don't refuse; users.json is machine-local and WS2.6 records are advisory (never resolution-authoritative), so no cross-machine bypass. |
| `allowTestIdentity` signed marker | machine-local, field-clamped OFF on WS2.6 receive BY DESIGN | a legitimately-overridden fixture-collision profile does NOT replicate its marker (the clamp denylist), so a peer with user-registry replication ON (dark-default) would quarantine it on next boot — near-impossible id collision + recoverable from the quarantine backup, accepted; re-mint the override on the peer if it ever occurs. |

## 2.2 Version skew (no wire change)

Both `DeliverAck` unions already carry `sender-rejected`; all increments are
machine-local, so the WIRE vocabulary does not change. NEW router + OLD owner →
loudness router-side, no receiver trace on the old owner; OLD router + NEW owner →
owner writes the trace but the old router still collapses to `forwarded`. **The
INGRESS machine's version is load-bearing for the loudness fix.** Both-old =
today's silent status quo. The `senderEnvelope`-absent bypass (an old peer / the
g3 path sends no envelope → validation not consulted) is the dominant pre-existing
bypass; sunsetting it (+ wiring the g3 site) is tracked-followup (3). <!-- tracked: fb-b15ac10b-85c -->

## 3. Testing (Testing Integrity — three tiers + Test-as-Self)

- **Unit**: ack→outcome ratchet; per-consumer `rejected` terminal-no-dispatch;
  `isRemotelyHandled(rejected)===false`; `forceReplace-never-reports-rejected-as-handled`;
  `rejected-via-forceReplace-escape-terminals-sender-deauthorized`; drain →
  `sender-deauthorized`+`reportLoss`; `reject-still-rejects-on-redelivery`;
  `rejection-trace-never-contains-payload`; **high-water disambiguation**
  (`[]`+no-high-water → degenerate/deliver; `[]`+high-water → POPULATED/reject);
  `populated-registry-always-arms` (transient-lock read-error on a store with
  entries → ARM); **`parse-failure-fails-closed`** (a raw-non-empty-unparseable or
  high-water-present corrupt store → UNKNOWN_UNSAFE → reject unresolved senders,
  never deliver); **`high-water-backfill-on-migration`** (an already-populated
  no-marker store gets high-water set → later-emptied classifies POPULATED);
  `operator-resolution-reads-local-only` (a WS2.6 tombstone of the operator cannot
  disarm); **`user-propagator-stays-unwired`** (guard pins the latent
  local-`users.json`-mutator path); fixture refusal at write (throw) AND load
  (skip+alert);
  `legitimate-user-named-Olivia-registers`; double-keyed escape;
  `override-requires-dashboard-PIN` (Bearer-only rejected);
  `overridden-collision-survives-reboot`; `forged-allow-marker-rejected`;
  unified-notice single-cause dedupe across live+drain;
  `rejected-message-terminals-the-ledger-row`;
  `rejected-redelivery-is-dropped-and-not-resurrected` (ingress-ledger: a
  redelivered `update_id` on a `rejected` row is DROPPED by decideIngress, never
  flipped back to `processing` by beginProcessing — round-4 adversarial);
  `rejected-message-does-not-produce-a-stuck-recovery-loss-notice`; cross-topic
  ceiling + flapping-proof decay (a short recovery does NOT re-arm the fast
  cadence); `N-replays-cause-≤1-registry-read`.
- **Integration**: full route → NACK → `rejected` → exactly ONE deduped notice
  (mock adapter) across BOTH live and drain; wiring gate arms/disarms/re-arms per
  registry state incl. high-water; degenerate registry → operator delivered via the
  local binding when the deciding machine holds it, else delivered-but-unverified.
- **E2E (feature-alive)**: real `AgentServer`; EMPTY-no-high-water registry reports
  disarmed + delivers; POPULATED registry rejects an unresolvable sender AND writes
  the receiver-side metadata row (no payload).
- **Test-as-Self (Live-User-Channel Proof):** a user-role session drives the real
  Telegram AND Slack surfaces on a THROWAWAY agent home with a fixture-degenerate
  registry, forcing `sender-rejected` and asserting the neutral notice arrives
  exactly once per surface + the disarmed alert — signed PASS/FAIL matrix recorded,
  BEFORE the operator tests.
- **Full-suite sweep** (Zero-Failure + "behavior changes break old tests" memory):
  `validateProfile`'s throw breaks suites/harnesses writing
  `livetest`/`g3test`/`u-olivia`-class ids; the shared test setup exports
  `INSTAR_ALLOW_TEST_IDENTITIES=1` + writes the test-home marker for legitimately
  fixture-writing suites; the PR runs `test:all`, not just the new tests.

## 4. Migration parity

TWO migrations. (1) The CLAUDE.md template section (`generateClaudeMd` +
`migrateClaudeMd`, content-sniffed, idempotent — increment E). (2) A one-time
idempotent `PostUpdateMigrator` boot remediation of ALREADY-polluted registries:
`validateProfile` only guards NEW writes, so a machine already carrying fixture
rows would re-create the incident on its next captain flip — the migration scans
`users.json` against `TEST_IDENTITY_MARKERS`, **skips any row carrying a `sig`
that verifies** (the signed allow-marker), quarantines the rest (backup + audit
line), and alerts. The SAME migration **back-fills the high-water marker** when,
after quarantine, ≥1 surviving NON-fixture user remains in a store that has no
marker (the installed-base fix — §D set-point; a pre-upgrade / merge-populated /
replicated store then correctly classifies POPULATED if later emptied). No
config-schema change, no hook change, no skill change. `TEST_IDENTITY_MARKERS` +
the high-water helper ship as exported consts. `logs/mesh-rejections.jsonl` is
bounded via `maybeRotateJsonl` on the append path (NOT any allowlist).

## 5. Why always-on (no dark gate)

Reachability / no-silent-loss floors of the class of the Cold-Start Lifeline
Fallback under "The Agent Is Always Reachable": the constitution forbids
dark-shipping the guarantee that a message is delivered or loudly accounted for.
A/B/E are pure honesty + hygiene. C fires only where today = silent loss. D's
disarm fires only in degenerate states that today reject everyone — and its own
failure mode (a probe throwing on a transiently-locked but POPULATED store) is
pinned to ARM by `populated-registry-always-arms`, so the new code cannot regress a
security control. Enumerated failure windows: (i) atomic registry write
(temp+rename) is **already present** in `UserManager.persistUsers` (round-2
scalability/adversarial/integration/lessons all confirmed) — so no "unreadable"
window opens from a normal registration write; this spec VERIFIES it present +
regression-pins it, it is not new work; (ii) a restart mid-storm resets the
in-memory notice window — bounded by the durable per-messageId ledger marker (§2.C).

## 6. Rollback

Single PR; `git revert` restores prior behavior for all CODE. **Durable identity
mutations are NOT git-revertable and are carved out here** (round-2 decision #2 /
integration minor): the §4 boot-remediation quarantines fixture rows out of
`users.json` to a timestamped backup — a revert removes the migration code but
does not (and should not) restore quarantined rows; a wrongly-quarantined
legitimate user is recovered from that backup. The boot probe is READ-ONLY (no
self-heal write), so it leaves no state to unwind. Other surviving artifacts:
`logs/mesh-rejections.jsonl` (inert), `state/registry-high-water.json` (inert),
any already-sent notices/alerts (no cleanup possible or needed). Per-increment
rollback is clean (disjoint seams: router mapping / handler deps / notice consumer
/ wiring + UserManager / template).

## 7. Constitutional traceability (per-increment fit)

Parent `A Refusal Stays a Refusal` (merged PR #1316) — the exact parent for the
core increments A/B. Per-increment fit (so the on-disk conformance gate sees no
dangling citation):

- **A / B (honesty + trace)** → *A Refusal Stays a Refusal* (PARENT).
- **C (loss notice + ceiling)** → *The User Experience Is the Product* (umbrella,
  #1280-pending — cited aspirationally) + *Bounded Notification Surface* + the
  2026-07-01 conservative-notification directive.
- **D (wiring gate + fixture refusal)** → *Verify the State, Not Its Symbol* +
  *Cross-Store Coherence Is an Invariant* (#1316) + *Test Identity Never Enters
  Production State* (#1316) + *Know Your Principal*.
- **E (template)** → *Agent Awareness* + *Migration Parity*.

**Build dependency (met):** PR #1316 is MERGED to canonical main (2026-07-02,
commit 18ee21cb), so `A Refusal Stays a Refusal` + `Cross-Store Coherence` + `Test
Identity` resolve on-disk. The `/instar-dev` build REBASES this branch onto that
main before committing, so the conformance gate reads the ratified standards. The
umbrella `The User Experience Is the Product` (#1280) remains aspirational until
ratified — it is a sibling, not the resolving parent.

## Frontloaded Decisions

All operator-preapproved (topic 29836); reversible per §6 EXCEPT the durable
identity mutations carved out there; recorded so no builder stops mid-run:

1. **User-originated predicate** = platform sender uid AND a topic bound in the
   adapter (excludes A2A/job/sentinel/canary).
2. **Drain path covered**: drain terminal `rejected` emits the SAME unified notice,
   coalesced with the live path on the ONE canonical cause enum.
3. **`TEST_IDENTITY_MARKERS`** = fixture PLATFORM IDS (Slack + harness `u-*`/`U_*`)
   + `livetest`/`g3test` anchored reserved-token prefixes; match rule
   exact-on-id / anchored-prefix-on-token — **display-name is NEVER a criterion**.
   Legitimate collision → dashboard-PIN-authed `X-Instar-Allow-Identity` + a
   durable signed profile marker.
4. **Always-on per increment** (§5); D's disarm carries `populated-registry-always-arms`.
5. **Unreadable/empty taxonomy** (round-3 codex — parse-failure fails CLOSED):
   clean ENOENT / valid-empty `[]`-no-high-water → degenerate (deliver);
   `[]`-WITH-high-water (emptied locally) → POPULATED (reject) + HIGH alert;
   **parse-failure / partial-write / raw-non-empty-unparseable / any high-water or
   backup evidence → UNKNOWN_UNSAFE → fail CLOSED (reject unresolved) + HIGH
   alert** (corruption/tampering is NOT "never populated"). The high-water marker
   disambiguates the byte-identical valid-`[]` states; it is set on every
   real-user-introduction path + back-filled by the §4 migration, monotonic.
6. **`logs/mesh-rejections.jsonl`** bounded via `maybeRotateJsonl` on the append
   path (NOT the SessionMaintenanceRunner allowlist — a no-op for `logs/`); 0600;
   metadata-only rows.
7. **Loss-notice wording** = the fixed neutral template in §2.C.
8. **Alert surface** = the ONE operator hub topic (the same topic decision 16
   names — reconciled), deduped per (machine, cause), once-per-boot + 24h; plus a
   one-shot "re-armed" breadcrumb on the disarm→arm transition (adversarial minor).
9. **Dedupe storage** = durable per-messageId ledger marker (primary) + in-memory
   30-min (topic, cause) window (secondary); restart re-arms the window but the
   durable marker holds.
10. **Call-time degenerate log** rate = 1/min per cause.
11. **`INSTAR_ALLOW_TEST_IDENTITIES`** honored only with an on-disk test-home marker.
12. **`stale-ownership`** keeps re-route; maps to `rejected` only when re-route is
    exhausted; `onRejected` fires receiver-side for `sender-rejected` only.
13. **Ship shape** = ONE PR; per-increment independence is a rollback property.
14. **Named consts** for the dedupe window + log path + high-water path.
15. **Rejected message terminals its ledger row** (never reply-committed) so
    stuck-recovery neither replays nor double-notifies.
16. **Cross-topic ceiling** = >3 distinct topics for one (peer, cause) → suppress
    per-topic + ONE aggregated hub alert; re-notice cadence decays 30m→2h→6h on
    **time-since-first-observed**, resets only after a sustained clear window
    (flapping-proof).
17. **Atomic registry write** = VERIFIED present (`persistUsers` temp+rename) +
    regression-pinned; not new work.
18. **Sender-side divergence** raises an advisory G1 coherence signal only; auto
    re-place is tracked-followup (2). <!-- tracked: fb-1e751537-655 -->
19. **Registry read is mtime-gated + read-only-load** (no `initialUsers` merge on
    the hot path); the operator-resolution probe is scoped to the CURRENT topic's
    binding (O(1)); a rejected-messageId replay short-circuits `validateSender`
    (≤1 registry read per messageId).
20. **Boot probe is READ-ONLY** (no self-heal write); polluted-store remediation is
    the §4 migration only.
21. **Sender re-validation scope = Telegram**; Slack sender re-validation is
    tracked-followup (4); Slack NOTICE parity ships in increment C. <!-- tracked: fb-1e751537-655 -->
22. **Parent-principle = A Refusal Stays a Refusal** (#1316, merged); build rebases
    onto that main; the UX umbrella (#1280) is an aspirational sibling.
23. **Signed allow-marker key custody** (round-3 security/decision): `sig =
    HMAC-SHA256` keyed on a SERVER-held vault secret loaded only by the server
    process (NOT `authToken`/`dashboardPin`, NOT a state-dir file a plain
    `users.json` writer reads); PIN gates MINTING only, load-path VERIFIES with no
    PIN. Honest scope: it does NOT defend against a fully-FS-privileged local
    process (which could evade markers with a non-fixture id anyway) — that
    adversary is explicitly out of scope (at-rest honesty). PIN check reuses
    `checkMandatePin` (sha256 + timingSafeEqual + rate-limit).
24. **High-water set-point + backfill** (round-3 integration): set on the paths
    that write the authoritative local `users.json` — register / non-fixture
    `initialUsers` merge (NOT WS2.6 replication-in, which is advisory and doesn't
    enter `users.json` — round-4 lessons coherence); the §4 migration back-fills it
    for the installed base (≥1 surviving non-fixture user); monotonic.
    A WS2.6 tombstone cannot empty `users.json`, so it is NOT an emptied-by-deletion
    trigger. High-water shares the `users.json` FS trust boundary (unsigned, no
    separate envelope).
25. **`UserPropagator` stays unwired**: a `user-propagator-stays-unwired` guard test
    pins the latent local-`users.json`-mutator path so a future activation can't
    void the local-authoritative operator-resolution invariant.

## Open questions

None.

> Operator pre-approval covers this project's decisions (Justin, topic 29836,
> 2026-07-01); every reviewer-contested choice across three review rounds is
> resolved in the Frontloaded Decisions above — nothing is parked on the user.
