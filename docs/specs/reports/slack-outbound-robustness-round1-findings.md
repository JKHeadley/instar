# Round-1 convergence findings — slack-outbound-robustness

**Spec reviewed:** `docs/specs/slack-outbound-robustness.md` @ commit `5f4f5f647`
("slack outbound delivery robustness draft (roadmap 2.1)"; eli16 @ `8f4384259`).
**Report commit:** this file.
**Round-1 status: NOT CONVERGED.** 3 CRITICAL + 6 MAJOR + 7 MINOR + 3 LOW.

Round 1 ran with an EXPLICIT FIRST CHECK — drift against the CONVERGED
durable-conversation-identity spec (round 11, commit `aa5086eb8` in the
conversation-identity worktree, `review-convergence: 2026-07-03`, `approved: true`).
The draft was written while the keystone sat at ROUND-6; the keystone's final
rounds materially revised exactly the sections this spec builds on (the §5.0(a)
E1 delivery-idempotency guard became a TWO-LANE design with durable send-intent
journaling and a lane-scoped crash-window boot conversion; §5.1 pinned the
never-success-shaped dryRun contract and the permanent-error classification;
§5.0 pinned the `ownsConversation` delivery-authority predicate; §3.5.2 pinned
delivery-time id↔tuple coherence as a TYPED REFUSAL). Six of the twelve
material findings below are direct consequences of that drift.

Every code citation in the draft was verified against the worktree source
(v1.3.728). The draft's grounding is largely accurate — the verified
exceptions are themselves findings (M5, LOW-1).

---

## Reviewers who ran this round

**Internal pass (one consolidated multi-lens review by the reviewing agent —
security, scalability, adversarial, integration/multi-machine,
decision-completeness, lessons-aware — run against the committed draft with
line-level verification of every cited source location):** contributed the
cross-channel-misdelivery walk inside C1 (the blind `INSTAR_CONVERSATION_ID`
adoption arm), the shared-breaker cross-channel blast-radius walk in M2, the
restart double-post derivation that falsifies OQ-4's rationale (M4), and the
metadata-forwarding parity gap (MINOR-4).

**Standards-Conformance Gate:** ran (51 standards checked, registry canary ok) —
**3 flags**, all folded: `LLM-Supervised Execution` (tier0 declaration needs the
named supervisor-equivalent pattern), `Constitutional Traceability` (the
`parent-principle` cites the INBOUND consume-gate standard for an OUTBOUND
design — MINOR-5), `Near-Silent Notifications` (recovered-marker/escalation
chatter into the conversation needs an explicit decision — MINOR-6).

**External cross-model passes (one bounded pass each), both EXECUTED against
the committed draft + converged-keystone excerpts + a verified code-grounding
pack:**
- **pi / openai-codex provider, `--model openai-codex/gpt-5.5`, `--no-session
  --no-tools -p`, spec inlined** — RAN (exit 0). Verdict line:
  `VERDICT: 3 CRITICAL + 8 MAJOR + 3 MINOR + 2 LOW`. Its three CRITICALs
  (funnel bypass, the `topic_id = 0` lane, success-shaped dryRun) are all
  confirmed and consolidated below (its funnel-bypass CRITICAL absorbs four of
  its MAJORs as sub-arms of M1).
- **gemini-cli, `-o json -m gemini-2.5-pro`, spec on stdin** — RAN (exit 0;
  serving model from the run's own stats block: **gemini-2.5-pro**). Verdict
  line: `VERDICT: 3 CRITICAL + 2 MAJOR + 3 MINOR + 1 LOW`. Its channel-blind
  restore-purge CRITICAL is confirmed as C2; its `topic_id = 0` black-hole
  CRITICAL overlaps pi's (the round's strongest two-external overlap); its
  send-intent MINOR feeds M4.
- **codex-cli** — NOT RUN: not installed on this machine (consistent with the
  conversation-identity ceremony rounds 3–11).

Cross-external overlap was unusually high this round: the identity-less
enqueue fallback (C1), the dryRun shape (C3), the restore-purge interaction
(C2), and the tone-gate fail-direction grounding error (M5) were each found
independently by BOTH externals or by one external + the internal pass.

---

## CRITICAL findings (blocking)

1. **The identity-less enqueue fallback (`topic_id = 0` + load-bearing
   `conversation_ref`) violates the converged identity authority and opens BOTH
   a misdelivery vector and a black-hole loss lane** `[pi-ext #2 + gemini-ext
   #2 + internal — the round's strongest overlap]`. Four independent walks land
   on the same §2.6 design:
   - *Misdelivery (internal):* `slack-reply.sh` takes an arbitrary
     `CHANNEL_ID[:THREAD_TS]` argument per call, but §2.6 sources the enqueue
     address from the SESSION's `INSTAR_CONVERSATION_ID` env. A proactive reply
     to a channel OTHER than the session's own conversation that fails →
     enqueued under the session's minted id → the redrive `resolve(id)` yields
     the SESSION's channel → the message re-delivers into the WRONG channel.
     C3-class misdelivery, the top severity class of the keystone ceremony.
   - *Black hole (gemini):* the fallback's server-side resolve cannot work for
     a never-minted conversation — the keystone's `GET /conversations/resolve`
     **mints NOTHING** (converged §8), and the sentinel has no mint authority
     either (mint chokepoints are deliberately bounded to authorized-inbound +
     the pool seam — §6.2/§6.3). A `topic_id = 0` row for an unminted
     conversation is undrainable by construction and dies at the 24h TTL.
   - *Identity authority (pi):* the drain-by-ref lane makes a lookup STRING the
     delivery authority — precisely what the converged spec forbids (the tuple
     is identity, the key is lookup; delivery resolves through the registry,
     §3.0 contracts 1/4).
   - *Key-domain conflation (internal):* `0` is outside the keystone id domain
     (`>0` Telegram, `<0` minted; the funnel 400s negatives to `/telegram/reply`
     and the grep-audit note reserves `0` as General-topic semantics). All
     unresolved-Slack rows would share dedup key `(0, text_hash)` — two
     DIFFERENT conversations sending the same templated text cross-suppress,
     contradicting the draft's own §2.2 uniqueness claim — and stampede
     grouping on key `0` digests N distinct conversations into one row whose
     delivery target `resolve(0)` is undefined.
   **Fix adopted for round 2:** DELETE the `topic_id = 0` lane. Enqueue
   REQUIRES a minted id whose registry tuple MATCHES the script's own target
   argument (env id accepted only after tuple-match validation; otherwise
   resolve by key via the read route). No id obtainable → NO enqueue, loud
   exit-1 (today's behavior — the residual server-down + never-minted-target
   window is named honestly; it is strictly narrower than today's total loss
   and strictly safer than misdelivery). `conversation_ref` survives as audit +
   drain-time COHERENCE input only (see M1). Resolves OQ-2.

2. **The channel-blind restore-purge composes with unconditional enqueue and
   the dark/dry Slack lane into systematic deletion of queued Slack messages —
   the 2026-06-05 lesson recurring one level up** `[gemini-ext #1 + pi-ext
   M#6 + internal]`. Walk: Layers 1–2 ship unconditionally (§5), so fleet
   agents enqueue `channel:'slack'` rows the moment the script tail lands. On
   any agent with the sentinel ENABLED but `channels:['telegram']` (the fleet
   default posture) — or with the Slack lane in dryRun — those rows are never
   drained, but `purgeStaleRows()` at every sentinel start lists and deletes
   ALL queued/claimed rows older than 60 min **with no channel filter**
   (`listStaleClaimable`/`purgeStaleClaimable` — verified channel-blind). Every
   queued Slack message on such an agent is deleted at the next boot without
   ONE drain attempt. Loud-per-row, but systematic — the restore-purge lesson
   (`delivery-failure-sentinel.ts:83-90`) the draft cites as engaged is
   violated by the composition. The draft also leaves the per-row behavior for
   a channel NOT in `channels` entirely undefined (decision-completeness).
   **Fix adopted:** rows of a not-enabled channel are NOT claimable AND are
   EXEMPT from restore-purge (purge scoped to enabled channels); a >24h
   backlog on a disabled channel raises ONE deduped attention item; §7 gains
   the dark-rollout-then-enable test.

3. **`slackDryRun` as specified is success-shaped — the converged §5.1 posture
   ("dryRun returns typed `not-delivered`, NEVER success-shaped") is violated,
   and the literal text specifies message loss** `[pi-ext #3 + gemini-ext
   m#1 + internal]`. "The full state machine, ledger rows tagged dryRun:true,
   posts NOTHING" — a state machine run to `delivered-recovered` without a
   post is a delivery-shaped record of a delivery that never happened; the row
   is consumed and the message is gone (and if the rows are instead left
   queued, C2's purge eats them). **Fix adopted:** dryRun is HOLD-shaped — a
   dry tick logs the would-redrive verdict (ledger `dryRun:true`), makes NO
   `delivered-*` transition, increments NO attempt, and pushes
   `next_attempt_at` forward (riding the purge's existing hold-exemption).
   When the lane flips live, held rows drain for real; rows already past TTL
   escalate LOUDLY (visible, never silent).

## MAJOR findings (blocking)

1. **The Slack redrive and every sentinel-authored Slack notice bypass the
   converged delivery-authority funnel — ownership, binding coherence,
   permanent-error classification, P17 budgets, and E1 accounting are all
   skipped** `[pi-ext #1 (rated CRITICAL there; its M#1/M#2/M#5 are arms of
   this) + gemini-ext M#1/M#2 + internal]`. The converged keystone pins
   delivery authority in `deliverToConversation`: `ownsConversation(id)` §5.0
   (with STAND-DOWN, not retry-burn, on non-owning), delivery-time id↔tuple
   coherence §3.5.2 (incoherent = typed refusal, NEVER a delivery on either
   field — R5-M2/R6-M4), §5.1 permanent-error classification, §5.2
   per-conversation + GLOBAL budgets, and the §5.0(a) E1 lanes — and its
   Phase-2.1 handoff clause says robustness "slots in UNDER this funnel." The
   draft's `defaultPostReplySlack` re-implements a bare resolve-and-POST
   beside all of that: on a machine that does not own the conversation (or has
   no local Slack adapter — route 503) the redrive burns the 24h TTL in
   retries; a ref/resolve disagreement is a "LOUD diagnostic" that still
   delivers; sentinel notices dodge the funnel budgets. **Fix adopted:** the
   Slack lane's delivery hop IS the funnel — `postReplyFor('slack')` calls
   `deliverToConversation(row.topic_id, text, opts)` with an additive
   `opts.deliveryId` (and system-template marker) forwarded to the route; a
   pinned typed-result → recovery-policy mapping table replaces raw-HTTP
   classification for Slack rows (delivered → finalize-success;
   `already-delivered-recently` → delivered-equivalent finalize;
   tone-gate verdict → `delivered-tone-gated`; `conversation-unreachable` →
   terminal + out-of-band escalation; non-owning / unresolvable /
   `conversation-binding-incoherent` → HOLD (stand-down; no attempt burn, no
   breaker arm); transient → backoff retry; dryRun/dark → HOLD). Drain-time
   coherence: the row's `conversation_ref` tail must match `resolve(id)`'s
   tuple — mismatch is the typed incoherent HOLD + one deduped attention item,
   never a delivery.

2. **Permanent Slack errors are invisible through the HTTP hop, and their
   escalations target the unreachable conversation itself — repeated
   escalation failures then trip the ONE SHARED circuit breaker, so a Slack
   channel-state outage suspends the TELEGRAM lane too (P19 cross-channel
   blast radius)** `[pi-ext M#3 + internal]`. Verified: `/slack/reply` flattens
   adapter errors to `500 {error: message}`; recovery-policy retries 5xx; the
   converged §5.1 classifies `is_archived` / `channel_not_found` /
   `not_in_channel` (via `SlackApiError.slackError`) as PERMANENT
   `conversation-unreachable` with a drift canary and emitter-level
   aggregation. Under the draft, an archived-channel row retries for 24h, then
   `escalate` posts the escalation INTO the archived channel → guaranteed
   escalation failure → `recordEscalationFailure()` → breaker trips →
   `suspended = true` pauses ALL channels. The draft asserts the shared
   breaker as a feature ("a Slack storm trips the SAME breaker — asserted")
   without arguing this failure shape. **Fix adopted:** M1's funnel routing
   supplies the §5.1 classification for free; `conversation-unreachable` rows
   terminalize WITHOUT the 24h burn; their operator notice goes OUT-OF-BAND
   (attention queue, which aggregates mass events per the keystone's 60s
   coalescing window) — never into the unreachable conversation; escalation-
   failure accounting and suspension become PER-CHANNEL (shared code, per-
   channel state), pinned by a §7 test: a Slack escalation-failure storm never
   suspends Telegram redrives.

3. **The draft's E1 characterization is stale against the converged §5.0(a) —
   and one claim is false** `[pi-ext M#4 + gemini-ext M#2 + drift-check]`.
   The draft (§2.1) describes E1 as a dedup of "a LOGICAL SEND (commitmentId +
   sendSeq) … for beacon traffic" and asserts "a beacon send that reaches the
   route carries its own delivery-id like any caller." The converged E1 is a
   TWO-LANE guard covering ALL `id<0` funnel callers — retirement-scoped
   logical lane for beacon traffic AND a 15-min WINDOW content-hash lane for
   identity-less callers (reap notices, attention items, and — after M1 — the
   sentinel's own notices), with durable `send-intent` journaling and a
   LANE-SCOPED crash-window boot conversion (one-off notices resolve toward
   RETRY; beacon intents suppress-on-unknown). And the converged funnel mints
   NO delivery-id — nothing in §5 sets `X-Instar-DeliveryId`, so the quoted
   claim is unverifiable-to-false. **Fix adopted:** restate E1 accurately;
   pin which traffic is protected by which layer (funnel callers: E1 lanes +
   route dedup; script sends: queue state machine + route delivery-id +
   content dedup); the delivery-id the route sees from the funnel exists ONLY
   when a caller (the M1 redrive) passes `opts.deliveryId` — beacon sends do
   not carry one, and that is stated rather than hand-waved.

4. **OQ-4's "not needed" rationale is factually wrong — the restart
   double-post window is derivable today** `[internal + gemini-ext m#3;
   mirrors the keystone's R4-M2 walk]`. Walk: redrive attempt k delivers but
   the ack is lost (the row stays claimed; the route recorded the id in the
   IN-MEMORY LRU only) → server restarts (instar restarts on every
   auto-update — the exact R4-M2 argument) → LRU empty → next redrive at
   backoff step k (≥15 min from attempt 5 on) → the durable content-dedup
   window (15 min) has lapsed → the route posts AGAIN. The row state machine
   does NOT cover this case (the row was never transitioned — the ack was
   lost before the 2xx reached the sentinel). **Fix adopted:** the delivery-id
   ledger becomes DURABLE (a small SQLite table beside
   `SqliteOutboundDedupStore`, 24h TTL, shared by `/telegram/reply` and
   `/slack/reply`; the in-memory LRU stays as the hot cache). Closes OQ-4 for
   both channels; the §7 restart test asserts exactly-once across a restart
   at a ≥15-min backoff step. (gemini's send-intent suggestion is noted as
   the stronger-still variant; the durable ledger closes the identified
   window at a fraction of the machinery, and funnel traffic already gets
   send-intent via the keystone.)

5. **The fail-direction table misstates the deployed tone-gate availability
   behavior — a §0 operator-visible property table must describe reality**
   `[pi-ext M#7 + gemini-ext #3 + internal grounding]`. The draft: "the
   sentinel treats a gate ERROR as a transient retry, not a drop." Verified
   reality: the sentinel's pre-check `checkToneLocally` FAILS OPEN on a gate
   error (`passed:true, failedOpen:true` — `local-tone-check.ts`) and the
   sentinel proceeds to POST; availability-failure direction is then owned by
   the ROUTE-side gate (`failClosedMode` tri-state), whose resulting HTTP
   status is what recovery-policy actually classifies. **Fix adopted:**
   correct the row to the layered reality (local pre-check fails open →
   route gate owns availability direction → policy maps the route's status);
   no behavior change is proposed (the fail-open pre-check + route re-gate is
   the deployed, argued design).

6. **`/internal/slack-forward` gate-only leaves a semantically-inverted echo
   route live — OQ-1 resolved to a typed refusal** `[pi-ext M#8 + gemini-ext
   m#2]`. Both externals independently rejected the breadcrumb-only posture:
   the route's ONLY semantic today is a bug (it posts INBOUND user text back
   OUT), it has zero live callers, and gating an echo defect still ships an
   echo defect the moment SlackLifeline is instantiated. **Fix adopted:** the
   route keeps Bearer auth and returns a typed `misdirected-route` refusal
   (409, named error body + one-time deduped attention breadcrumb) until
   Phase 2.2 re-points it at session-injection parity. Fail-toward-delivery
   does not apply — there is no legitimate delivery through an echo bug, and
   the operator channel it would "deliver" to is the wrong direction
   entirely. Resolves OQ-1 (the full re-point stays 2.2 — it drags the
   ingress ledger in, exactly as the draft judged).

## MINOR findings (batch)

1. **Keystone status metadata is stale** `[pi-ext L#1]`: frontmatter
   `depends-on` + §1.1 say ROUND-6 / commit `69004a39c` /
   `review-convergence: null`. Reality: CONVERGED round 11, commit
   `aa5086eb8`, `review-convergence: 2026-07-03`, `approved: true`. Build-gate
   condition (a) is now MET; (b) — registry + funnel increments merged —
   remains open and stays normative.
2. **Read-route and session-surface citations drift from the converged
   contract** `[pi-ext m#1]`: the resolve route is
   `GET /conversations/resolve?key=…` (or `?sessionKey=…`) and MINTS NOTHING
   (load-bearing for C1's fix); the session surface pins the metadata field
   key `conversationId` (§6.3) — an env var name is an implementation mapping,
   not the pinned surface.
3. **The pre-mint content-dedup fallback ("key on the routing-key string
   hash") collides key domains and contradicts the draft's own zero-module-
   change claim** `[pi-ext m#2 + internal]`: `OutboundContentDedup` keys on a
   NUMBER; a string-hash-as-number can collide with a real minted id or a
   Telegram topic id → cross-conversation suppression. Fix: pre-mint sends
   SKIP content dedup (fail-open to delivery, honest tiny window; delivery-id
   idempotency still covers the re-POST class).
4. **The Slack redrive must forward `message_metadata` whole** `[internal]`:
   `defaultPostReply` forwards the row's kind metadata (messageKind,
   allowDuplicate, formatMode ride there); the draft's `defaultPostReplySlack`
   sends `{text, thread_ts}` only — a redriven mrkdwn-authored reply would be
   re-formatted, and kind-aware gate signals would be lost. Pin parity.
5. **Constitutional anchoring** `[conformance gate]`: the `parent-principle`
   cites *The Operator Channel Is Sacred* — whose registry rule text governs
   the INBOUND consume/pause gate — for an OUTBOUND delivery layer. The
   correct outbound anchor is *Guards Degrade, Not Outage* (the registry's
   named outbound extension), with Operator-Channel-Sacred as sibling context.
   The `supervision: tier0` declaration also adopts the keystone §6.2 pattern
   explicitly (deliberate standard-aware exception + NAMED supervisor-
   equivalent: the §7 three-tier suite + live proof; the in-path LLM judgment
   is the EXISTING tone gate, which keeps its own posture).
6. **Near-silent posture for recovery chatter needs an explicit decision**
   `[conformance gate]`: recovered markers + tone-gate meta-notices post into
   the conversation. Decision: KEEP for parity and user value (a recovered
   marker explains a late out-of-order delivery the user was actively
   missing; both are single fixed templates, P17-bounded), stated in the spec
   with the Near-Silent Notifications standard engaged — while M2 moves
   unreachable-conversation escalations out-of-band.
7. **System-template bypass parity pins** `[pi-ext m#3]`: `/slack/reply`'s
   bypass must carry the same constraints as Telegram's — compiled-in
   template set, build-time SHA integrity, exact-membership check, no
   runtime template registration — pinned by a §7 test (spoofed header +
   arbitrary text still gates).

## LOW findings (batch)

1. **Path citations**: reply-script templates live at
   `src/templates/scripts/…` (draft omits `src/`); the tone gate is
   `src/core/MessagingToneGate.ts`; the sentinel gate is
   `src/server/AgentServer.ts` `[pi-ext L#2 + internal]`.
2. **Script-side 5-second enqueue-dedup parity** `[gemini-ext L#1]`:
   `telegram-reply.sh`'s embedded enqueue carries a 5-SECOND same-
   (topic,hash) dedup (tight-loop flood guard — distinct from the route's
   15-min window). Decide-and-state: ported to `slack-reply.sh` (yes — same
   flood class).
3. **Mixed-channel drain fairness** `[internal]`: `selectClaimable`'s single
   LIMIT-100 oldest-first scan means a Slack backlog can delay Telegram
   redrives by ticks (bounded by maxConcurrent + per-topic caps). Accepted
   with a stated bound; revisit only if the §7 e2e shows starvation.

---

## Convergence recommendation

**NOT CONVERGED.** 3 CRITICAL + 6 MAJOR block.

The drift-first check did its job: the draft's four heaviest problems (C1, C3,
M1, M3) are all places where the pre-round-6 keystone snapshot aged out from
under it — the converged spec's identity-authority, never-success-shaped
dryRun, ownership/stand-down, coherence-refusal, and two-lane E1 contracts
now exist precisely to forbid the shapes the draft improvised. The
architectural resolution is one move: the Slack lane's delivery hop becomes
the keystone funnel (M1), which resolves ownership, coherence, permanent-error
classification, and budgets in a single stroke and keeps ONE delivery
authority. C2 is the strongest genuinely-new catch (both externals + internal
independently): the channel-blind restore-purge composing with unconditional
enqueue is the 2026-06-05 silent-deletion lesson repeating one abstraction
level up.

All four Open Questions are resolvable from round-1 evidence and are folded as
Frontloaded Decisions in the round-2 revision: OQ-1 → typed refusal (M6);
OQ-2 → fallback deleted, tuple-validated enqueue (C1); OQ-3 → dev-gate default
kept (unchanged position, now with C2's disabled-channel semantics making it
safe); OQ-4 → durable delivery-id ledger (M4).

**Verdict: NOT CONVERGED** (3 CRITICAL + 6 MAJOR + 7 MINOR + 3 LOW).
