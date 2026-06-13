---
title: "Threadline Single-Negotiator Lock + Honest Ack Semantics (Robustness Phase 1)"
slug: "threadline-single-negotiator"
author: "echo"
eli16-overview: "threadline-single-negotiator.eli16.md"
tracking: "CMT-1362"
program: "Threadline Robustness (problem statement .instar/plans/threadline-robustness-problem-statement.md, F1–F6)"
parent-principle: "Structure beats Willpower"
lessons-engaged:
  - "docs/signal-vs-authority.md — the send-gate's only blocking authority is the lease, keyed on a structural send path, not on a classifier output"
  - "guard-bypass-carries-its-own-cap — the fail-open path for ordinary prose is bounded + logged + alertable; the authority path (existing Mandate/ReviewExchange) fails closed"
  - "Bounded Notification Surface — holding-notice has a global min-interval floor, not just per-epoch"
  - "P10 Comprehensive-First — no recurrence-risking partial ship: G2 (prose inertness) + G3 (acks) ship in CORE, ungated"
  - "Structure > Willpower — one voice and prose-inertness are structural, not rules a session must remember"
approved: true
approved-by: "Justin (operator, telegram topic 12476)"
approved-at: "2026-06-12T18:01:00-07:00"
review-convergence: "2026-06-12T09:06:17.579Z"
review-iterations: 4
review-completed-at: "2026-06-12T09:06:17.579Z"
review-report: "docs/specs/reports/threadline-single-negotiator-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
single-run-completable: true
frontloaded-decisions: 11
cheap-to-change-tags: 1
contested-then-cleared: 1
---

# Threadline Single-Negotiator Lock + Honest Ack Semantics (Robustness Phase 1)

## Problem statement

On the evening of 2026-06-11, parallel Claude sessions of two agents (Echo and Dawn) negotiated
and "locked" an **irreversible production cutover window** (W1, Fri 10:00 PT) that neither fleet
can attribute to a coherent single self. The lock was "confirmed" by a **warm keep-alive session**
the proposing session never knew about. No harm fired only because an unrelated accident (the
cutover target was NXDOMAIN, so the safety gate physically could not pass). The failure is
structural: **nothing in Threadline prevented a side-channel session from binding the agent, and
nothing made a prose "confirmed" carry less authority than an operator-anchored decision.**

This spec is **Phase 1** of the Threadline Robustness program. It makes that incident
**structurally impossible on our side** — given the existing single-holder model (a Threadline
conversation is processed by exactly one machine at a time; FD-2) — via three guarantees, closing
the two highest-risk evidenced failure modes (F1, F4). The precise residual is named honestly: the
Phase-1 guarantees hold **if and only if** the single-holder invariant holds; genuinely concurrent
multi-machine processing of one conversation is the F2 logical-identity surface, explicitly Phase 3
(and the build adds an invariant test for holder-singularity — FD-2 — so a violation is loud, not
silent).

- **G1 — One voice (closes F1).** Under an available lease store and the single-holder invariant
  (FD-2), at most one session of an agent owns a conversation's outbound voice at a time. A
  warm/keep-alive/side session can never speak content in the agent's name; the most it can emit is
  a fixed structural "owner will respond" notice. (The two named conditions are honest caveats, not
  loopholes: a lease-store outage suspends G1 only for inert prose and raises a loud alert — D-B;
  the single-holder invariant is guarded by a runtime duplicate-holder alert — FD-2.)
- **G2 — Prose is inert; binding lives only in the existing operator-anchored primitives.** A
  normal message — any text, any wording — **never** creates an authoritative "we agreed to X"
  record and **never** authorizes an irreversible step. Binding exists only through instar's
  existing PIN-anchored **Coordination Mandate** / **ReviewExchange** flow. There is no "binding
  prose" to detect-and-block because prose has no pathway to authority. (In control-plane terms:
  this is a deliberate **data-plane / control-plane split** — Threadline prose is the data plane
  and carries no authority; the control plane is the existing anchored-artifact channel.)
- **G3 — Honest acks (closes F4).** Delivery/ack state matches reality, so `stale: true` means
  something and can drive escalation instead of being permanent noise.

### Why G2 is "prose is inert," not "detect and block binding prose"

The first draft proposed a content classifier that would detect commitment-class prose and
**refuse** to send it unless anchored. Convergence review (lessons-aware + adversarial + the
external GPT-tier pass, rounds 1–2) rejected that as **two failures**:

1. **Signal-vs-Authority violation.** A heuristic/LLM content classifier is a *signal emitter*;
   making its output the authority that **blocks** an irreversible bind is exactly the
   detector-with-blocking-authority anti-pattern the constitution forbids (the 2026-04-15
   four-filters-before-the-gate incident; the 2026-06-09 brittle-heuristic-as-authority lesson).
2. **It cannot work.** The incident's own evidence — "see you at the gate," "division of labor,
   08:00 check-in," and ordinary greenlights like "yep, go ahead" — contains **no** lexical
   binding keyword. Any enumerable classifier is evadable by paraphrase, so detect-and-block
   re-opens F1 the moment a commitment is phrased colloquially.

The inversion fixes both: **authority is positive and structural, not detection-based.** Binding
happens only through the existing operator-anchored channel (Mandate/ReviewExchange). Prose is
inert *by construction*, so there is nothing to classify on the authority path and nothing to
evade. The classifier survives only as a **signal-only nudge** to the sending session ("this looks
like a commitment — it carries no authority unless you anchor it via a mandate/review-exchange"),
which never blocks and fails open to no-nudge.

### What this spec is NOT

Phase 1 is scoped deliberately narrow. It does **not** attempt:
- Canonical/symmetric/auditable cross-end history (F3, F5) — **Phase 2**.
- **Bilateral agreement on commitment *content*** (both ends provably agreeing to the same bytes)
  — also **Phase 2** (it needs symmetric history). Phase 1 guarantees only that *our* side never
  manufactures authority from prose; it does not prove the peer understood the same commitment.
- One-logical-identity-per-agent across machines/fingerprints (F2) — **Phase 3**. In particular, a
  conversation genuinely running live on two machines at once is an F2 surface (see FD-2 for how
  the existing single-holder model keeps that out of scope for Phase 1).

These are named so reviewers can confirm Phase 1 leaves their surfaces untouched and additive.

## Grounding in current code (what exists today)

Verified on `echo/threadline-robustness` (off `upstream/main` @ v1.3.490):

1. **`ConversationStore`** (`src/threadline/ConversationStore.ts`) — the durable per-thread record:
   **per-machine** `{stateDir}/threadline/conversations.json`, **single-writer `mutate(threadId,
   fn)` with optimistic version CAS, FIFO queue per threadId (max depth 256), 8-retry CAS budget,
   reload-before-commit, 250ms snapshot cache, atomic tmp-write+rename**. Holds `boundSessionName`,
   `boundTopicId`, `machineOrigin`, `version`, `state`, `participants`, `agentIdentity`, a
   `journalSeam` lifecycle hook. Pruned (`MAX_ENTRIES`). **Home for the lease** — already the one
   CAS-protected per-conversation writer; no new store, no new lock.

2. **`ThreadResumeMap`** — `threadId → {uuid, sessionName, remoteAgent, subject, state}`. **No
   owner/lease field**; `get()` (`ThreadlineRouter.ts:553/619`) returns the entry without an
   ownership challenge. F1 gap on the cold/resume path.

3. **`WarmSessionPool`** — per-thread `peerId` conflict check on `admit()`, but only on the warm
   path and only against the inbound peer, not a single owning session of the agent's voice. An
   admitted warm session has the **same MCP toolset** and its `threadline_send` is
   indistinguishable to the peer.

4. **Outbound send path** — `ThreadlineMCPServer.ts` `threadline_send` (`:544–666`) →
   `deps.sendMessage()` → `RelayClient.sendMessage()` → relay `MessageRouter.route()`. **No
   thread-ownership validation**; only `envelope.from === senderAgentId` (always true). **The single
   chokepoint** for the lease/voice gate. The session's own (sessionName, machineId) is known
   **server-side** here — never taken from a client/peer-supplied string.

5. **`A2ADeliveryTracker`** — durable SQLite (`{stateDir}/state/a2a-delivery.{agentId}.sqlite`,
   WAL). `awaiting-ack → acked` via `recordAck`/`recordAckByThread`. **Reply-counts-as-ack already
   works** (keys on threadId, name/fingerprint-asymmetry-robust, regression-tested).

6. **F4 is a pure wiring gap.** `commands/server.ts` (~:10087) and `routes.ts` (~:17527) call
   `recordAckByThread` on a received reply; the **verified E2E relay inbound path** (`POST
   /threadline/messages/receive`, `ThreadlineEndpoints.ts ~:374–450`) does **not** — so live
   exchange over it never recorded acks, producing the 9-pending/9.6h-stale false signal.

7. **Operator-anchoring primitives already in-tree** (G2 reuses; does NOT duplicate or wrap in a
   new Threadline wire kind):
   - **Coordination Mandate** (`src/coordination/`, `MandateStore`, `/mandate/*`) — PIN-gated
     `authProof` (a Bearer-only agent cannot mint/widen one); `evaluate(action,…) → {decision}`;
     hash-chained audit; scoped to a **pair of agent fingerprints** (`agents: [fpA, fpB]`).
   - **ReviewExchange** (`src/coordination/ReviewExchange.ts`) — content-addressed, linear,
     mandate-gated mutual sign-off with its own delivery + audit.
   - **`OperatorConfirmGate`**, **`AuthorizationPolicy`**, **`ApprovalQueue`** — additional
     operator-anchored gates already in the tree.
   - **`ContentClassifier`** — demoted here to a **signal** source only.

## Proposed design

Three changes, all **local to the sending agent** (no required peer change → no flag-day):

### D-A. The Negotiator Lease (delivers G1)

A **per-conversation lease** naming exactly one session as the owner of that conversation's
outbound voice. Stored as new **optional** fields on the existing `Conversation` record (inherits
CAS/single-writer/atomic-write). Backward-compatible: an existing `conversations.json` without
these fields loads unchanged; the acquire path defensively initializes them.

```
negotiatorLease?: {
  ownerSessionName: string;   // server-authoritative live session identity at the chokepoint
  ownerMachineId: string;     // this machine's id
  epoch: number;              // monotonic; every (re)acquire increments — fences stale holders
  acquiredAt: string; renewedAt: string; expiresAt: string;  // renew-on-send; no background timers
}
lastHoldingNoticeEpoch?: number;  // durable holding-notice rate-limit (FD-3)
lastHoldingNoticeAt?: string;     // durable global min-interval floor (FD-3)
```

**Acquire-or-renew is synchronous at the send chokepoint**, one `ConversationStore.mutate()` CAS
transaction — **no background renewal timers** (avoids O(active-threads) timers; FD-6):
- No lease / **expired** (`now > expiresAt`) / owner session **provably dead** (absent from the
  server's live session registry) → acquire: owner = this session, `epoch += 1`, stamp times.
- This session already owns it → renew (extend `expiresAt`), epoch unchanged.
- A **live, unexpired foreign** lease → not acquired → holding path (D-B).
- **CAS budget exhausted** (8 retries) → "could not confirm ownership": under enforce the content
  send is withheld (holding outcome); under dry-run, logged. Retry counts go to the dry-run JSONL.

**`epoch` fences a stale holder.** A session that held epoch N, stalled past TTL, and was taken
over (epoch N+1) will, on its delayed send, re-read the live lease at the chokepoint, find N+1 ≠ N,
and take the holding/acquire path — it never sends content as owner. Because acquisition is the
**same synchronous CAS** the send gate runs (FD-6, no background renewal that could silently
succeed), a wedged owner can never send content unaware of having lost the lease.

### D-B. The Lease/Voice Send Gate (the chokepoint; delivers G1)

The send gate at `threadline_send` (before `deps.sendMessage`) does exactly one thing: enforce the
lease so only the owner is the agent's voice. There is **no commitment branch in the send path** —
binding is out-of-band via the existing primitives (D-C), so the gate has no authority over
content *meaning*, only over *who speaks*.

1. Acquire-or-renew the lease (D-A).
   - **Own it** → `allow`. (The prose is inert by construction — G2 — so allowing it carries no
     commitment authority.)
   - **Foreign live lease** → `holding`: the content send is withheld; the gate emits at most one
     typed **`holding-notice`** to the peer (rate-limited, FD-3; wire shape FD-11). Fixed template,
     only owner/agent names + epoch interpolated; `kind: "holding-notice"`; **never**
     ack/content/message-count-bearing; **cannot contain model-authored text**.
   - **Lease store error** → **fail OPEN** for the send: it proceeds, but **G1 is explicitly NOT
     enforced during a fail-open window** — the spec does not pretend single-voice holds while the
     lock store is unreadable. The event is recorded (`action: "fail-open", threadId, sessionName,
     attemptCount`) to the dry-run JSONL **and raises a HIGH-priority alert** (an Attention-queue
     item, not a silent advisory) — a state where the single-negotiator lock is not being enforced
     must never be silent. Safe because prose is inert (worst case: two of the agent's own sessions
     briefly both speaking inert prose, never a binding), but the suspension of G1 is surfaced
     loudly. This bounded+counted+loudly-alerted fail-open is the escape hatch's own cap
     (*guard-bypass-carries-its-own-cap*).

**The classifier is signal-only.** On a send whose text *looks* like an attempt to commit/lock an
irreversible step, `ContentClassifier` (deterministic lexicon tier; LLM tier advisory, never
required) emits a **nudge** into the sending session's own context: "this reads like a commitment;
it carries no authority unless you anchor it via a mandate/review-exchange." It **never blocks,
never refuses, fails open to no-nudge**, and runs **off the wire/send path** (no latency, no new
failure mode on the send). It is a convenience pointing the session to the structured path — not a
gate. The **only blocking authority** in Phase 1 is the lease (one voice), keyed on the structural
ownership check.

### D-C. Binding lives only in the existing operator-anchored primitives (delivers G2)

Phase 1 does not add a new "commitment" wire kind or send operation (an early draft did; the
external GPT-tier review and decision-completeness review flagged it as an underspecified,
self-reinventing workflow protocol). Instead:

- **A prose `threadline_send` NEVER writes a commitment / agreement / approval record** in our
  state, regardless of wording. This is the negative guarantee, and it is **tested** (below).
- **The only way to record or authorize a commitment with a peer is the existing PIN-anchored
  Coordination Mandate / ReviewExchange flow** — already self-scoped to an agent-fingerprint pair,
  PIN-gated (a Bearer-only agent cannot mint authority), and hash-chain audited. Phase 1 reuses it
  as-is; it does not weaken or wrap it.
- **G2 is only real if no downstream action-gate treats Threadline prose as evidence — and we
  enforce that POSITIVELY, not as a negative audit that rots.** The durable form (per the external
  GPT-tier review) is a **positive authorization interface**: an irreversible-action gate may accept
  authorization **only** as a typed anchored-artifact (a `Mandate` / `ReviewExchange` /
  `OperatorConfirm` reference) — never a string, transcript, history summary, or `ContentClassifier`
  output. Phase 1 (a) defines/threads that artifact type at the irreversible-action gates in reach
  (cutover-readiness door, external-operation gate, approval/automation paths), and (b) ships a
  **type/import-boundary test** that fails if an action gate's authorization input is anything other
  than the anchored-artifact type — so a *future* gate that tries to consume a derived
  "conversation summary" fails the test by construction rather than slipping past a keyword audit. A
  negative scan over current call sites is run too, but the positive type boundary is the durable
  guarantee. **The Phase-1-covered gates are enumerated, not left vague:** the cutover-readiness
  door (`/cutover-readiness`), the external-operation gate (`/operations/evaluate`), and the
  ApprovalQueue / AuthorizationPolicy paths. Any other irreversible-action gate found during the
  audit is resolved to a concrete disposition — (i) non-irreversible (out of scope), (ii)
  blocked-until-migrated to the typed boundary, or (iii) explicit documented residual risk filed
  loudly — so "in reach" is never silently assumed covered. This converts G2 from an assertion into
  a verified, rot-resistant property.
- **The classifier nudge** points a session that is trying to commit in prose toward the Mandate/
  ReviewExchange path.

### D-D. Cross-agent honesty (no-flag-day backstop for irreversible steps)

We cannot force an **un-upgraded peer** (Dawn on her own train) to treat *her own* prose as inert.
Phase 1's honest guarantee is therefore scoped precisely:
- **On our side**, G1 + G2 hold unconditionally.
- **The irreversible action itself** remains gated by its own operator-anchored door (e.g. the
  cutover-readiness door is already operator-only — "the door is NOT yours"; the 2026-06-11 step
  also required the operator to name the window and a preflight that did not exist). Phase 1 never
  produces a *substitute* authority for those.
- The `holding-notice` is an **additive wire kind**: an un-upgraded peer renders it as a harmless
  one-line text and is otherwise unaffected (FD-11 specifies the exact envelope + legacy
  behavior). Ordinary conversation needs no peer change. If a peer never adopts the structured
  commitment primitives, irreversible steps simply cannot be "locked" by prose on either side — the
  correct safe failure (the outcome NXDOMAIN produced on 2026-06-11, now structural).

### D-E. Honest Ack Wiring (delivers G3 / closes F4)

Wire the verified E2E relay inbound path to record the implicit ack. In `ThreadlineEndpoints.ts`
`POST /threadline/messages/receive`, after the message is accepted + authenticated
(`trust.kind === 'verified'` yields the sender fingerprint), with the background
`handleInboundMessage` spawn:
```
ctx.a2aDeliveryTracker?.recordInboundFrom(senderFingerprint, senderName ?? null);
if (inbound.message?.threadId) ctx.a2aDeliveryTracker?.recordAckByThread(inbound.message.threadId);
```
Same proven, idempotent call as the other two paths. (The round-1 trace identified the verified
E2E relay inbound path in `ThreadlineEndpoints.ts` as the one lacking the call; the build confirms
the exact missing route(s) by **enumeration** rather than trusting a single name — see the funnel
test below.) All inbound-receive sites are **funnelled** through one `recordInboundAck(ctx, msg)`
helper, and a wiring-integrity test enumerates the inbound routes and asserts each goes through the
funnel (a future path that bypasses it fails the test).

### Rollout posture (Graduated Feature Rollout)

- **G2 (prose inertness + the downstream-gate audit) + G3 (ack wiring) ship in CORE, ungated.**
  Prose inertness is the *absence* of a prose→binding pathway plus reuse of existing
  operator-anchored gates — no blocking authority over ordinary traffic, nothing to dry-run. Ack
  wiring is pure observability correctness. **Nothing incident-critical is behind a flag** (the
  explicit answer to the round-1 "recurrence-risking partial-ship" finding).
- **G1 (the lease) hard-block enforcement is the only dry-run-gated rung** (withholding a content
  send is the one new blocking action over ordinary traffic):
  - `threadline.singleNegotiator.enabled` (default **false**) — off ⇒ lease is observe-only
    (recorded, never enforced); gate is pass-through.
  - `threadline.singleNegotiator.dryRun` (default **true** when enabled) — logs the verdict it
    *would* reach + CAS-retry + fail-open counts to `logs/threadline-negotiator.jsonl`, still
    sends, measuring false-positive rate before it can withhold a real send.
  - Even with the lease OFF, G2 + G3 still hold.

## Decision points touched

- **New blocking action on the send chokepoint** — the lease withholds a non-owner's *content*
  send (G1). Narrow: keyed on the structural lease check; fails OPEN (bounded/logged/alertable) for
  the send on store error.
- **One additive wire kind** — `holding-notice` (FD-11). Degrades to plain text on an un-upgraded
  peer; never ack/content-bearing. No other new wire kind (binding reuses existing Mandate/Review).
- **`ContentClassifier` gains a `commitment-class` SIGNAL** — advisory nudge only; no authority.
- **Ack recording added to the verified inbound route** via a shared funnel (D-E) — wiring fix.
- **New read-only route `GET /threadline/negotiator`** — bearer-gated, paginated, own-data-only.
- **A downstream-gate audit/test** asserting no action gate consumes Threadline prose as authority.

## Frontloaded Decisions

1. **Lease TTL = 90s, renew-on-send (no background timer).** Configurable
   `threadline.singleNegotiator.leaseTtlMs` (default 90000). Long enough to not thrash mid-reply,
   short enough that a dead owner's lease is reclaimable within ~90s.

2. **Lease owner = (sessionName, machineId), `epoch`-fenced, server-authoritative; the lease is a
   per-machine, intra-machine voice guarantee.** Identity is read from the server's live session
   registry at the chokepoint, never from a message body, so it cannot be forged by a peer.
   `conversations.json` is **per-machine** (not a shared filesystem) — so the lease serializes the
   sessions **on one machine**. Cross-machine single-voice is NOT provided by a shared CAS (the
   round-2 + external review correctly rejected the earlier "shared store" wording); it is provided
   by the **existing Threadline single-holder model**: a Threadline conversation is served by
   exactly one machine (the relay address is part of that machine's identity; conversations do not
   migrate — see the Conversation Coherence journal), and the active-active machine lease keeps one
   machine awake per topic. So in normal operation only the holder machine processes a
   conversation, and the negotiator lease makes the voice singular within it. A conversation
   genuinely live on two machines at once is the F2 logical-identity surface, **explicitly Phase
   3** (named in "What this spec is NOT"). No per-session crypto challenge is added — same-agent
   sessions share one trust domain and a local-FS attacker is already game-over. **The build adds
   holder-singularity guards at two levels** (a unit test can prove implementation behavior, not
   production topology, so we do both): a TEST over the known holder-election/relay-routing
   invariants, plus a **runtime duplicate-live-holder detector** that emits a HIGH-priority alert
   (Attention-queue) if two machines are ever observed holding the same conversation — so a
   violation of the single-holder assumption (split-brain, routing bug, clock skew) is surfaced
   loudly rather than silently re-opening the cross-machine incident path.

3. **Holding notices: durable per-epoch limit AND a global min-interval floor.** At most once per
   `(thread, epoch)` (durable `lastHoldingNoticeEpoch`, restart-safe) **and** at most once per
   `holdingNoticeMinIntervalMs` per thread (default 300000 = 5 min, via `lastHoldingNoticeAt`) —
   closing the epoch-cycling flood. The notice **includes the epoch** so a peer can invalidate a
   stale (epoch,owner) belief; the epoch is a session-transition signal only (a peer ignores
   epochs older than the last it saw). Fixed template, no model text.

4. **G2 is structural, not classifier-gated.** Binding exists only via the existing
   Mandate/ReviewExchange flow; prose is inert regardless of wording; the classifier is a
   signal-only nudge (advisory, fail-open, off the wire path).

5. **No new commitment wire protocol in Phase 1.** Binding reuses Coordination Mandate /
   ReviewExchange as-is (self-scoped to a fingerprint pair, PIN-anchored, audited). This resolves
   the round-2/external finding that a bespoke Threadline "commitment handshake" would reinvent a
   workflow protocol incompletely.

6. **Renew-on-send, no background timers.** Lease acquired/renewed only synchronously at the send
   chokepoint. An idle owner that doesn't send for > TTL lets the lease lapse; its next send
   re-acquires (or yields holding if taken over). Eliminates timer growth and the "renewal silently
   succeeded while wedged" race.

7. **Default-off, dry-run-first for the LEASE only.** Enforce enabled only after dry-run telemetry
   shows acceptable false-positive rate. G2 + G3 ship live in core.

8. **Migration Parity.** `migrateConfig()` adds `threadline.singleNegotiator.*` (existence-checked,
   safe off/dry-run defaults) and seeds the same keys in `ConfigDefaults.ts`; `migrateClaudeMd()`
   adds a Threadline-negotiator awareness paragraph; the new route follows the standard
   route-addition path. The `negotiatorLease` / holding-notice fields are **additive + optional**
   on `Conversation`: existing `conversations.json` loads unchanged, the acquire path defensively
   initializes the lease object. The build verifies `threadline/conversations.json` is within the
   backup manifest's include set (it is the agent's existing conversation store). No hook/skill
   changes. On revert (flag off) the lease is observe-only and stale lease state is inert (no
   cleanup job).

9. **`GET /threadline/negotiator`** — bearer-gated, paginated (default 100, `after` cursor),
   returns this agent's own lease state per active conversation (holder + epoch + expiry) plus
   dry-run would-hold + CAS-retry + fail-open counts. The dry-run JSONL rotates daily,
   `threadline.singleNegotiator.dryRunRetentionDays` (default 7).

10. **commitment-class SIGNAL lexicon (advisory only).** Deterministic tier matches binding verbs
    (lock/confirm/approve/schedule/go-live/sign-off/"go ahead"/"let's schedule"/"move forward")
    over an irreversible/temporal object; the optional LLM tier adds recall. Because it has **no
    authority**, an incomplete lexicon is not a safety hole (a missed nudge = no hint; the prose is
    inert either way) — so it need not be exhaustive to be correct.

11. **`holding-notice` wire shape (the only new wire kind).** Envelope:
    `{ kind: "holding-notice", owner: { sessionName, machineId }, epoch: <int>, text: "<fixed
    template naming owner+agent+epoch>" }`, carried in the existing message envelope's content
    field. **Safety does not depend on remote compliance**: on **our** side a `holding-notice` is
    never ack/content/message-count-bearing and never carries model-authored text, **and it creates
    NO sender-side `A2ADeliveryTracker` awaiting-ack record** — a holding-notice is not a tracked
    send, so it can never inflate `pendingCount` or pollute the G3 honest-ack signal. An upgraded
    peer treats `kind` likewise; an un-upgraded peer simply renders the `text` plainly (a harmless
    one-liner) and may, at worst, count it in its *own* UI/history — which carries no authority and
    cannot create a binding, so no safety property rests on the peer honoring `kind`. The
    integration test simulates a legacy receive path to confirm our own ack/pending state does not
    advance, and asserts no pending-delivery record is created for the notice on the sender side.

## Alternatives considered (why lease-on-send)

- **Actor/mailbox per thread (single consumer goroutine):** would give one voice by construction,
  but requires a long-lived per-thread process and a routing rewrite — disproportionate for Phase 1
  and at odds with the existing spawn-per-message model. The lease reuses the existing CAS store
  and adds no processes.
- **Lightweight in-process queue (single-writer per thread, no long-lived actor):** a fair
  comparison given the lease now recreates ownership/fencing/TTL/notices/alerts. The reason the
  lease still wins for Phase 1: the agent's sessions are separate tmux processes (not in one process
  sharing a queue), so an in-process queue would not actually serialize them — cross-process
  serialization needs a durable shared record, which is exactly what the CAS lease over the existing
  store provides without new infrastructure.
- **Central per-agent session router:** a single arbiter deciding which session may speak. Stronger,
  but a new always-on component and a new single point of failure; Phase 1 prefers extending the
  durable store already on the path.
- **Distributed lock service for cross-machine ownership:** unnecessary given the existing
  single-holder model (FD-2) — a conversation is already served by one machine, so a cross-machine
  lock would duplicate that guarantee. Revisit only if F2 (logical identity across machines)
  introduces genuinely concurrent multi-machine conversations (Phase 3).
- **Durable workflow engine / append-only event log / message-broker partition ownership:** these
  are the right shape for a *durable conversation authority model* (consumer-group/partition
  ownership is essentially a distributed negotiator lease). Phase 1 deliberately does NOT adopt one:
  it would be a large new dependency and is premature while conversations are per-machine and
  binding already lives in the anchored-artifact control plane. The CAS lease is honestly a
  **tactical local mutex over the voice**, not a durable cross-machine authority model — the durable
  model is exactly what Phase 2 (canonical, symmetric, append-only history; F3/F5) is for, and the
  event-log/broker option should be weighed there.

## Implementation surface (files the build touches)

- `src/threadline/ConversationStore.ts` — add optional `negotiatorLease` + holding-notice fields;
  `acquireOrRenewLease(threadId, owner)` + lease helpers over `mutate()`.
- `src/threadline/ThreadlineMCPServer.ts` — insert the lease/voice gate before `deps.sendMessage`;
  emit `holding-notice` on the holding path.
- `src/threadline/ThreadlineEndpoints.ts` — D-E ack funnel on `POST /threadline/messages/receive`;
  add `GET /threadline/negotiator`.
- `src/threadline/ContentClassifier.ts` — add the advisory `commitment-class` signal (nudge only).
- `src/core/ConfigDefaults.ts` + `PostUpdateMigrator.ts` — config knobs + migrations (FD-8).
- `src/scaffold/templates.ts` (`generateClaudeMd`) — Agent Awareness paragraph.
- **Positive authorization boundary** (D-C): thread the anchored-artifact type through the
  irreversible-action gates in reach (cutover-readiness, external-operation gate, approval/automation
  paths) so authorization input is *typed*, plus a type/import-boundary test that fails if any such
  gate accepts a non-anchored input (string/transcript/summary/classifier output) — and a negative
  scan over current call sites.
- **Holder-singularity invariant test** (FD-2): asserts at most one machine is the live holder of a
  given conversation.
- Tests in `tests/unit`, `tests/integration`, `tests/e2e` (below).

## Test plan (all three tiers — Testing Integrity Standard)

- **Unit** (`tests/unit/`): lease acquire/renew/expire/epoch-fence over `ConversationStore.mutate`,
  incl. the CAS race (two sessions acquire concurrently → exactly one wins; loser sees the live
  foreign lease) and CAS-budget-exhaustion → holding/withheld; backward-compat (a conversation with
  no `negotiatorLease` loads + acquires cleanly); send-gate matrix {own / foreign live /
  expired-foreign / dead-owner / store-error} → {allow / holding / allow(fail-open, logged+counted)};
  holding-notice durable per-epoch limit AND global min-interval floor AND epoch-cycling-flood
  bounded AND fixed-template/no-model-text invariant AND exact envelope shape (FD-11); classifier
  nudge is advisory (a "go ahead" prose send still `allow`s and produces NO commitment record —
  proving G2 does not depend on the classifier).
- **Integration** (`tests/integration/`): full HTTP — a send through the gate returns the right
  verdict with the feature enabled; `GET /threadline/negotiator` returns 200, bearer-gated,
  paginated, own-data-only; **F4 regression**: a message on `POST /threadline/messages/receive`
  clears the matching pending entry and `GET /threadline/peers/health` no longer reports it stale;
  **wiring-integrity**: every inbound-receive route goes through the `recordInboundAck` funnel (a
  bypassing route fails); **legacy peer downgrade**: a `holding-notice` received by a simulated
  un-upgraded peer parses as plain text and does NOT advance ack/pending/message-count state.
- **E2E** (`tests/e2e/`): "feature is alive" — production init wires the gate + route returns 200
  (not 503) when enabled; **the incident reproduced** — a warm session and a proposing session both
  routed to one thread: the warm (non-owner) session's content send yields `holding` (only the
  fixed notice reaches the peer), the proposing (lease-holding) session is the only voice, and a
  prose "locked W1 for Fri 10:00, see you at the gate" from EITHER session produces **no
  authoritative commitment record** (G2). **G2 positive-boundary test** (D-C): the type/import-
  boundary check that an irreversible-action gate accepts only a typed anchored-artifact, never
  Threadline prose/transcript/summary/classifier output. **Holder-singularity invariant** (FD-2).
  Together these are the proof the 2026-06-11 incident is structurally impossible on our side
  (under the single-holder invariant, which the holder-singularity test guards).

## Open questions

*(none)*
