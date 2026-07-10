---
title: "Notification Selectivity — Quiet by Default: logs-first automated messaging with category-level push opt-in"
slug: "notification-selectivity"
status: "approved — converged r3 + fresh operator sign-off 2026-07-10"
tier: 2
created: "2026-07-10"
author: "echo"
parent-principle: "Near-Silent Notifications"
eli16-overview: "notification-selectivity.eli16.md"
provenance:
  - "Design approved by operator 2026-06-13 13:59 PDT (topic 11960, verbatim: 'Approved') after three review rounds — recorded here as DESIGN provenance only. The converged spec artifact was LOST: the build session was reaped at max runtime the same day and the spec file died with its worktree; only the design conversation survives."
  - "Reconstructed 2026-07-10 against canonical main (v1.3.802) after operator reaffirmation (topic 11960, 2026-07-10, verbatim): 'we need to be VERY selective about what gets actually sent to the user (most should be internal logs)'."
  - "FRESH operator sign-off RECEIVED 2026-07-10 13:17 PDT (topic 11960, verbatim: 'Approved with your recommendations') — approving this reconstructed document with the recommended defaults on both named decision points: the significant-lane emergency floor stays (ELI16 item 1), and the rollout lever exists through the staged rollout with full removal as the final cleanup increment (DEV-1)."
extends:
  - "docs/specs/attention-single-topic-routing.eli16.md (PR #1417 — the urgent slice that already shipped)"
  - "docs/specs/notification-ux-coherence.md (the Agent Health lane)"
  - "docs/specs/attention-topic-flood-guard.md (P17 machinery)"
  - "docs/specs/notification-emission-gate-brief.md (the #73 emission-authority brief — see Prior Art §PA-9)"
  - "docs/specs/mature-update-announcements.md (silent-by-default update announcements)"
lessons-engaged:
  - "Near-Silent Notifications — this spec IS that standard's enforcement machinery: push only action-required/usable-result; routine goes to a pull surface (parent principle)"
  - "Structure beats Willpower — the default flips from 'each feature remembers to be quiet' to 'the delivery funnel is quiet unless provenance proves otherwise' (grandparent principle; the June-13 root-cause admission)"
  - "Conservative Outbound: Act, Don't Notify — the still-unratified disposition standard; this spec builds the enforcement it names (engaged, §PA-8, §D-1)"
  - "Bounded Notification Surface (P17) — volume bounds unchanged and still load-bearing beneath this gate; the #1417 per-source hub MESSAGE stream gap is surfaced and closed here (engaged, §5.2, §8.1)"
  - "Notices Route to the Alerts Topic, Never a New One (P23) — every push this gate permits lands in the hub or an existing conversation; never a new topic (engaged, §5, §8)"
  - "Self-Heal Before Notify (P22) — heal-exhausted escalations land on the attention queue; this gate governs whether that queue PUSHES; §6 carries its own Standard-B declaration (engaged, §5.4, §6)"
  - "The Agent Carries the Loop — ratified 2026-06-14, ONE DAY AFTER the June-13 design; the temporal collision on decision-request notices is named for fresh operator sign-off (engaged, §DEV-6, FD-14)"
  - "Distrust Temporary Success — the four-flood recurrence class is closed at the disposition layer, and the opt-in door is bounded so it cannot become flood round five (engaged, §5.2)"
  - "No Unbounded Loops (P19) — the failure ladder, the push budgets, and the store coalescing all carry declared brakes (engaged, §5.2, §6)"
  - "Intelligence Infers, Keywords Only Guard — the gate never text-matches; it keys on structural provenance only (engaged, §2)"
  - "Signal vs. Authority — the gate holds routing authority because its key is structural provenance (the P17 origin-typed ceiling precedent), never brittle content interpretation; content authority stays with the tone gate (engaged, §8)"
  - "The Operator Channel Is Sacred — inbound-scoped; its outbound corollary honored here: a VERIFIED reply fails toward delivery on any gate malfunction, including the relay-skew path (engaged, §2.4, §6)"
  - "The Agent Is Always Reachable — corollary-2 resource-rejection notices are conversation-serving floors this gate must never eat (engaged, §3.2)"
  - "A Refusal Stays a Refusal / silent-loss conservation — quiet-routing is recorded routing, never loss; store failure is counted + surfaced, never silent (engaged, §6)"
  - "Truthful Provenance — Speak Only as Yourself — session-context surfacing of quiet items speaks as infrastructure, inside an untrusted-data envelope, never as the user (engaged, §4.3)"
  - "Observable Intelligence / Observability — every gate decision writes a ledger row; dryRun counterfactuals are measurable before enforcement (engaged, §7)"
  - "Migration Parity — config defaults via ConfigDefaults + PostUpdateMigrator; legacy default-true levers snapshot-migrated; CLAUDE.md template awareness block (engaged, §Migration)"
  - "Testing Integrity — all three tiers + the zero-stray burst invariant + the opted-in bounded-push arm (engaged, §9)"
  - "Maturation Path — ships enabled-in-dryRun on development agents, dark on the fleet (engaged, §Rollout)"
  - "Mobile-Complete Operator Actions — category opt-in is conversational + a dashboard toggle through ONE sole-writer surface; never a hand-built curl (engaged, §4.4)"
  - "Close the Loop — the opt-in digest + unread-aging counters + agent-facing re-surfacing + tracked deferrals keep quiet items from rotting unseen (engaged, §4.3, §4.5)"
  - "Cross-Machine Coherence — every new surface declares its posture; the opt-in surface is unified via a durable sole-writer fan-out (engaged, §Multi-machine)"
review-convergence: "2026-07-10T20:02:56.648Z"
approved: true
approved-at: "2026-07-10T20:17:00Z"
approved-by: "operator conversational approval, topic 11960, 2026-07-10 13:17 PDT, 'Approved with your recommendations' (post ELI16 + convergence-report handoff via signed private views)"
review-iterations: 3
review-completed-at: "2026-07-10T20:02:56.648Z"
review-report: "docs/specs/reports/notification-selectivity-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
single-run-completable: true
frontloaded-decisions: 15
cheap-to-change-tags: 2
contested-then-cleared: 3
---

# Notification Selectivity — Quiet by Default

Small glossary for readers outside the project lexicon: **P17** = Bounded
Notification Surface (topic/volume budgets); **P19** = No Unbounded Loops
(every repeating behavior carries backoff/breaker/cap); **P22** = Self-Heal
Before Notify; **P23** = single-alerts-topic routing; **ELI16** = the
plain-English companion document; **the hub** = the "🔔 Attention" Telegram
topic created by PR #1417; **Standard B** = the spec-review check that an
operator-notifying watcher declares its self-heal + brakes; **WS2 / WS4.1** =
the multi-machine replicated-store hardening (type-clamped, untrusted-data
enveloped) and the durable cross-machine ack (queued intent, revalidated at
apply time); **the lifeline** = the always-alive guaranteed-reachable session;
**working-set carrier** = the mechanism that moves a topic's files between
machines; **guardian-pulse** = the daily meta-monitor digest job.

How it fits together, in five lines: (1) a code-defined **registry** names
every automated-message category and its default (quiet); (2) every outbound
send carries a provenance **envelope** stamped at its origin; (3) a
deterministic **gate** at the delivery funnel routes each send — replies
deliver, automated messages record unless opted-in or genuinely significant,
and every push is volume-budgeted; (4) recorded items land in a **quiet
store** + dashboard Notifications tab + logs, and route into the owning
project's session context; (5) the whole thing rolls out dark → observe →
operator-flipped enforcement, with a zero-stray CI test holding it forever.

## Problem statement

Four topic-spam floods (2026-05-22 sentinels, 2026-05-28 collaboration-redrive,
2026-06-05 worktree detector, 2026-06-13 stranded-work detector) each shipped a
patch, and each patch bounded VOLUME or ROUTING — never the DISPOSITION. The
operator's June-13 directive flipped the polarity ("We should have an extremely
high requirement before sending ANY automated messages to the user … By default
these should be logs only"), the design converged and was approved the same day
— and then the build session was reaped at max runtime and the converged spec
was lost with its worktree. On 2026-07-10 the operator reaffirmed: "we need to
be VERY selective about what gets actually sent to the user (most should be
internal logs)."

Since June 13, real slices shipped (see Prior Art). The residual gap this spec
owns, verified against main v1.3.802:

1. **Every attention item still PUSHES a Telegram message.** In the #1417
   default (`attentionRouting.mode: 'single-topic'`),
   `TelegramAdapter.createAttentionItem` (src/messaging/TelegramAdapter.ts:3840)
   → `routeToAttentionHub` (:4224) posts each item into the "🔔 Attention" hub
   **immediately** via `sendToTopic`. One topic now — but still one push per
   event, with no logs-only default and no opt-in. Worse (foundation gap this
   spec surfaces, §8.1): in single-topic mode the hub branch returns BEFORE
   `AttentionTopicGuard` runs (:3877–3884), and `topicCreationBudget` bounds
   topic CREATION only — so the per-source hub MESSAGE stream is unbounded
   today.
2. **No category-level logs-vs-push surface exists.** Individual features carry
   scattered booleans (`monitoring.sentinelTelegramEscalation`,
   `monitoring.reapNotify.enabled`, growth-digest delivery mode…), but there is
   no registry of automated-message categories, no uniform default, and no
   single place the operator opts a category into push.
3. **No dashboard pull surface for suppressed/quiet items.**
   `state/attention-suppressed.jsonl` (written by
   `writeSuppressedAttentionLog`, TelegramAdapter.ts:4116) has no HTTP route
   and no dashboard tab; there is no unread count, no "what did the agent keep
   quiet?" view.
4. **No last-hop automated-vs-reply classification.** The one funnel every
   send passes — `TelegramAdapter.sendToTopic` (TelegramAdapter.ts:1300) — is
   origin-blind. Provenance exists only in fragments that never combine into a
   delivery decision: `messageKind` (tone/advisory), `origin` (topic creation
   only), `lane` (attention), `recipientClass` (tone gate). The tone gate
   (`checkOutboundMessage`, src/server/routes.ts:2252) is route-scoped and
   bypassed by every in-process automated caller. And `messageKind` DEFAULTS
   to `'reply'` when stamps are absent — the exact "disguise an automated
   message as a reply" hole the June-13 review round 2 found, still open.

## Design decisions carried from the June-13 conversation (binding)

These are the operator's decisions, quoted from topic 11960, and this spec
implements them without re-litigating:

- **D-1 — Logs-only default, extremely high push bar.** "We should have an
  extremely high requirement before sending ANY automated messages to the
  user, unless the user requests to hear specific notifications. By default
  these should be logs only" (2026-06-13 11:30 PDT). Default for everything
  agent-generated that is not a reply to the user: internal logs + pull
  surface. Push is opt-in per category.
- **D-2 — Pull + opt-in, even for "I'm stuck."** "Even an 'I'm stuck, I need
  your call' goes to the logs until you choose to turn it on. You'd pull from
  the dashboard and opt into whatever you want pushed" (Echo's reflection,
  confirmed by the operator's 11:57 PDT reply that dissolved the emergency
  allowlist). See DEV-6/FD-14 for the collision with a standard ratified one
  day later.
- **D-3 — Sentinels/infra keep their real cases; this governs fall-through.**
  "We have built in infra/sentinels to handle these cases. What we're managing
  here are all the cases that fall through the cracks" (11:57 PDT). Recovery
  machinery is untouched; this spec governs what leaks to the USER.
- **D-4 — Quiet items log AND route to the relevant session/project.** "They
  should create logs and notify any relevant sessions/projects/etc, such that
  the issues can organically arise within those paths" (11:57 PDT).
- **D-5 — Significant → the ONE Alerts topic, never per-item surfaces.** "If
  something does come up that is very significant than there should be a
  single 'Alerts' topic that it can be posted in" (11:57 PDT). Today that
  topic exists: the #1417 "🔔 Attention" hub.
- **D-6 — The significance bar lives in source, never config.** From review
  round 2: the significant list "is hardcoded in source and reviewed at PR
  time — code can't add to it" (and by extension, config can't either).
- **D-7 — The gate is the LAST HOP and treats anything not a verified
  reply-to-the-user as automated.** From review round 2: closes the "disguise
  an automated message as a normal reply" hole.
- **D-8 — Conversational replies are unaffected.** "Your normal back-and-forth
  with me is untouched" — reflected and approved.
- **D-9 — No standing break-glass.** "Lets remove it" (11:30 PDT) — the old
  always-push behavior does not survive as a legacy mode in the end state.
  (See §Rollout and Deviation DEV-1 for how this composes with a staged
  rollout.)
- **D-10 — Zero-stray CI enforcement.** "The build now fails if 1,000
  automated signals produce even one stray message" (approved 13:59 PDT
  one-screen summary). Zero, not "a few."
- **D-11 — Opt-in Close-the-Loop digest.** From review round 2: "an OPT-IN
  daily digest so a genuinely important thing can't rot silently in the logs
  unseen."

## Prior art / already shipped — and this spec's residual scope

Everything below shipped after June 13 and overlaps materially. This spec
composes with each; it re-implements none.

- **PA-1 — #1417 single-alerts-topic routing (v1.3.800).**
  `attentionRouting.mode: 'single-topic'` default: every attention item posts
  into the ONE hub topic; per-item topics dead by default. **This spec keeps
  the hub as the sole push destination and changes WHETHER an item pushes at
  all** (quiet by default; significant or opted-in pushes) — and closes the
  per-source hub message-stream gap #1417 left open (§5.2, §8.1).
- **PA-2 — Bounded Notification Surface (P17).** `topicCreationBudget` inside
  `createForumTopic` (TelegramAdapter.ts:1450, `origin`-typed, auto-by-default),
  `AttentionTopicGuard`, the burst-invariant test, the funnel lint. Unchanged;
  still the volume backstop beneath this gate.
- **PA-3 — Outbound advisory layer.** `src/messaging/OutboundAdvisory.ts` +
  `POST /messaging/preflight` (routes.ts:12286): deterministic jargon/path/
  link/TIME_CLAIM checks on scheduler-stamped automated sends. Unchanged —
  it governs the CONTENT HONESTY of automated sends that will push; this spec
  governs whether they push. Its env-stamp trio (`INSTAR_MESSAGE_KIND`,
  `INSTAR_JOB_SLUG`, `INSTAR_SENDER_CLASS`; SessionManager.ts:2544/2835,
  JobScheduler.ts:981) is a load-bearing provenance input to §2.
- **PA-4 — The tone gate.** `MessagingToneGate` via `evaluateOutbound`
  (routes.ts:1855) / `checkOutboundMessage` (:2252): content/behavioral
  authority over route-delivered conversational sends. Unchanged; disjoint
  authority (see §8).
- **PA-5 — Maturity-tagged silent-by-default update announcements.** The
  post-update notifier already implements per-change `audience: user` opt-in.
  Unchanged; registered as its own category with its existing gating honored
  (§3.4).
- **PA-6 — Agent Health lane.** `lane: 'agent-health'` items route to the
  calm "🩺 Agent Health" topic (notification-ux-coherence.md). Under this
  spec the lane becomes a quiet-by-default category like any other (§3.3) —
  its separate DESTINATION survives for opted-in pushes.
- **PA-7 — Duplicate suppression + topic-flood guard + budget.** Unchanged,
  downstream backstops.
- **PA-8 — "Conservative Outbound: Act, Don't Notify" (registry PROPOSAL,
  2026-07-04, unratified).** Names the disposition this spec enforces. This
  spec is its enforcement machinery for the delivery layer; approving this
  spec is a strong signal the proposal should be ratified, but ratification
  remains the operator's separate constitutional act.
- **PA-9 — notification-emission-gate-brief.md (instar-codey, #73 lane).** A
  draft brief for an emission-authority gate over low-confidence STATUS
  claims (PresenceProxy "actively working", drop notices). Complementary,
  narrower concern (signal CONFIDENCE), same principle (signals don't get
  direct user-facing authority). This spec's category registry reserves the
  brief's sources; if that brief converges later it plugs in as category
  dispositions + confidence inputs, not a second gate at a second chokepoint.
- **PA-10 — SentinelNotifier.** `src/monitoring/SentinelNotifier.ts` — the
  proven "default log-only, opt-in consolidated push" template
  (`monitoring.sentinelTelegramEscalation`, default false,
  ConfigDefaults.ts:714). This spec generalizes exactly that shape to every
  automated category, and §3.5 defines how such existing per-feature levers
  map into the registry without double-gating — including the levers that
  default TRUE (e.g. `monitoring.reapNotify.enabled`, ConfigDefaults.ts:327),
  which are snapshot-migrated, not laundered (§3.5).

## §1 — The Notification Category Registry (code-defined)

A single source-code registry (`src/messaging/notificationCategories.ts`)
declaring every automated-message category. **Code-defined and PR-reviewed;
config can never add, remove, or re-class a category (D-6).**

Each entry:

```ts
interface NotificationCategory {
  id: string;                       // e.g. 'reap-notice'
  description: string;              // plain English, shown on the dashboard
  disposition: 'quiet'              // DEFAULT: store + logs + pull surface
             | 'conversation-serving'; // push into the live conversation (§3.2)
  emitterModules: string[];         // the source modules allowed to emit this
                                    // category — enforced by the §9 lint
                                    // (callsite→category fit, not just presence)
  significantClasses?: SignificantClass[]; // classes THIS category may raise (§5)
  legacyGate?: string;              // dotted config key of an existing per-feature
                                    // delivery lever this category honors (§3.5);
                                    // MUST default false (lint-enforced) — a
                                    // default-true lever is migrated, never OR'd
  defaultDestination: 'hub' | 'conversation' | 'agent-health';
}
```

v1 categories (grounded in real emitters; the registry ships with a
completeness lint — see §9). **FD-13 binds this table: operator approval of
this spec approves the table as printed.**

| id | disposition | notes |
|----|-------------|-------|
| `attention-item` | quiet | all `createAttentionItem` emissions not otherwise laned |
| `agent-health` | quiet | the PA-6 lane; opted-in pushes keep the 🩺 topic |
| `job-status` | quiet | JobScheduler summaries/alerts (JobScheduler.ts:1539+) |
| `sentinel-escalation` | quiet | legacyGate: `monitoring.sentinelTelegramEscalation` (defaults false — OR-safe) |
| `reap-notice` | quiet | lever `monitoring.reapNotify.enabled` defaults TRUE → snapshot-migrated at Increment D, never OR'd (§3.5) |
| `resume-queue-notice` | quiet | revival/paused notices |
| `commitment-deadletter` | quiet | PromiseBeacon dead-letters + agent-carried-loop surfacing — FD-14: disposition is an explicit operator decision at approval |
| `spend-alert` | quiet | SpendAlertResolver / burn alerts |
| `mesh-alert` | quiet | rope-health, machine-coherence; legacyGate where present + default-false |
| `tunnel-notice` | quiet | TunnelManager.ts:448 |
| `advisory-escalation` | quiet | OutboundAdvisory repeated-ignore raiser |
| `autonomous-heartbeat` | quiet | the liveness line (its local brakes remain) |
| `update-announcement` | quiet | legacyGate: the PA-5 audience/maturity gating |
| `selectivity-digest` | quiet | §4.5's own digest (push requires digest opt-in) |
| `presence-standby` | conversation-serving | 🔭 receipts answer a live unanswered inbound |
| `cold-start-fallback` | conversation-serving | Always-Reachable corollary-2 notices |
| `message-loss-notice` | conversation-serving | inbound-queue loss / sender-rejection notices |
| `command-response` | conversation-serving | replies to user-typed hub/topic commands (TelegramAdapter internal handlers) |
| `uncategorized` | quiet | ANY unstamped/unregistered automated send (§2.3) |

The registry is deliberately small and coarse in v1 (FD-4): categories map to
emitter FAMILIES, not individual features. A new feature that never heard of
the registry emits `uncategorized` → quiet. **Silence is what you get for
free; push is what you must justify in a PR** — the June-13 inversion.

## §2 — The last-hop selectivity gate

`NotificationSelectivityGate` — a deterministic, synchronous, LLM-free
classifier invoked inside the two delivery chokepoints:

- `TelegramAdapter.sendToTopic` (TelegramAdapter.ts:1300) — the funnel every
  send passes;
- `TelegramAdapter.createAttentionItem` (:3840) — upstream of
  `routeToAttentionHub`, so a quiet attention item is stored WITHOUT the hub
  send (the store write is unconditional, exactly as today).

**Single evaluation (no self-double-gating):** `routeToAttentionHub` delivers
via `sendToTopic`, so both chokepoints would otherwise classify one send
twice. A verdict rendered at `createAttentionItem` rides an internal
PRE-DECIDED envelope — an unforgeable in-process object (module-private class
instance, not a string field, so no caller can spoof it as a category) — and
the funnel honors it without re-classification. The same pass-through carries
the §6 failure notice and §5 significant pushes. A pre-decided envelope is
**single-use**: consumed on delivery (a unit test pins that a captured
instance cannot be replayed to skip §5.2 budget re-evaluation), and it
**never crosses the mesh** — a relayed send is always classified fresh by the
holder (§2.4).

**How emitters get stamping capability (runtime fit, honestly stated):** the
callsite→category fit is enforced at BUILD time by the §9 lint; at RUNTIME
there is no ambient "stamp any category" API to misuse — each emitter module
receives, at composition-root wiring time, a stamper handle bound to exactly
its registry-declared categories (the capability-object pattern), so stamping
outside your declaration requires changing the wiring, which is the lint's
and the PR review's jurisdiction. Stampers are narrow TYPED factories
exported only from the wiring module — the §9 lint forbids importing the
generic envelope constructor anywhere else, so a handle cannot drift into
general circulation. No reflection-based runtime module-identity check is
claimed (JavaScript offers none for free).

### 2.1 The provenance envelope

A new optional `envelope` on `sendToTopic`'s options (alongside the existing
`kindMetadata`), stamped at ORIGINATION chokepoints — never caller-supplied
free text:

```ts
interface OutboundEnvelope {
  origin: 'verified-reply' | 'automated';
  category: string;                  // registry id; absent → 'uncategorized'
  significantClass?: SignificantClass; // honored only per the §5 code table
  inboundMessageId?: string;         // conversation-serving corroboration (§3.2)
  sourceContext: string;             // for dedup/audit, mirrors attention items
  relayedOrigin?: boolean;           // true when the envelope crossed the mesh (§2.4)
}
```

Stamping points (each is an existing chokepoint, not new surface):

- **The reply route** (`POST /telegram/reply/:topicId`, routes.ts:12379)
  stamps `verified-reply` ONLY when the §2.2 verification passes; otherwise
  `automated` with the category derived from the scheduler stamps.
- **The scheduler env-stamp trio** (PA-3) already positively marks job
  sessions; the reply route maps `INSTAR_MESSAGE_KIND=automated` +
  `INSTAR_JOB_SLUG` → `automated`/`job-status` (or the job's declared
  category).
- **In-process emitters** (sentinels, schedulers, attention, tunnel, mesh…)
  stamp their registry category at their existing send callsites. The sweep
  of ~40 `sendToTopic` callsites is enumerated in the build plan; the §9
  funnel lint enforces BOTH envelope presence AND callsite→category fit
  (an emitter module may only stamp categories whose registry entry names it
  in `emitterModules`).
- **TelegramAdapter internal command handlers** (the ~40 sites at
  TelegramAdapter.ts:921–3225 responding to user-typed commands) stamp
  `command-response` (conversation-serving — a user typed the command), each
  carrying the triggering command message id as `inboundMessageId`.
- **Raw `apiCall('sendMessage')` bypass closure:** roughly nine callsites
  today reach the Telegram API without passing `sendToTopic` — including
  **`TelegramAdapter.send()` (:1235, apiCall :1249/:1256)**, the generic
  adapter-interface method with a LIVE automated caller
  (`TelegramConfirmationTransport.ts:114`, ux-confirm prompts), plus leaf
  sites at :741, :1613, :2399, :3961, :4098, :4204, and both branches of the
  prompt sender (:5115/:5125). The census in this paragraph is
  reconstruction-time; **the build re-enumerates by grep at lint-baseline
  time** (a stale count must never become the lint's blind spot — that was
  round 2's own finding against this spec's first census). `send()` is an
  entry point, not a leaf: it is routed through the funnel (or stamps
  envelopes itself) — ux-confirm prompts classify conversation-serving,
  bound to the triggering inbound like any §3.2 category. Leaf sites get
  funnel routing or an in-code justification comment the lint recognizes
  (e.g. hub-post internals already carrying a pre-decided envelope); the §9
  lint FORBIDS new raw `sendMessage` callsites. Without this, the gate
  repeats the historical "guard at the wrong layer" dodge.

### 2.2 Verified-reply classification (D-7 — closing the disguise hole)

Today `messageKind` DEFAULTS to `'reply'` when stamps are absent — automated
by omission is treated as conversational. **This spec inverts the default at
the delivery layer.** A send is `verified-reply` iff ALL of:

1. It arrived via `POST /telegram/reply/:topicId` (or an equivalent
   adapter-external reply route);
2. It carries NO automation stamp (`INSTAR_MESSAGE_KIND` unset or `reply`,
   `INSTAR_SENDER_CLASS` not `script`/`llm-session`-with-job);
3. The route's existing session-resolution breadcrumbs
   (`resolveTopicSession`, routes.ts:12461–12503 — today log-only:
   "kindless send mapping to job session", "class-spoof") corroborate: a send
   whose resolved topic session is a JOB session claiming replyhood is
   **demoted to `automated`** — the breadcrumbs are promoted from
   observability to classification input.
4. *(Advisory in v1, with a CONCRETE promotion path — FD-9)* the topic has a
   recorded recent inbound user turn (§2.5's recency map). In v1 this is
   logged as the named ledger metric `replyWithoutRecentInbound`, NOT a
   demotion condition (a legitimate hours-late reply must never be eaten).
   **Promotion exit criteria (FD-9):** after Increment C has run ≥14 days
   with ≥200 reply-path sends observed AND `replyWithoutRecentInbound`
   incidents individually audited to zero false positives, a follow-up PR may
   promote the check to demotion authority. The audit is ledger-driven and
   bounded, not an open-ended manual chore: each incident row carries the
   topic, the send, and the map state needed to judge it, and the metric is
   expected to be rare — the review is a per-incident checklist over a small
   set, presented with the FD-12 evidence (automating the incident
   classification is named future work, after the manual pass establishes
   the ground truth). **The promotion mechanism is
   server-minted, zero client-contract change:** the route already tracks the
   topic's current inbound (`currentInboundByTopic`, routes.ts:12595) and the
   §2.5 map; promotion means the `verified-reply` stamp additionally requires
   that server-side binding — no caller ever supplies a nonce or changes
   telegram-reply.sh. Until then, the honest residual is stated: an unstamped
   in-repo caller POSTing to the reply route on an interactive topic
   classifies as a reply. To shrink that residual structurally, the §9 lint
   ALSO covers in-repo HTTP calls to `/telegram/reply` (the callsite pattern
   is lintable), so a feature cannot quietly adopt the route as a push path.

Anything that fails 1–3 is `automated`. An automated send cannot BECOME a
reply by claiming it: there is no caller-settable "I am a reply" field — the
stamp is minted inside the route handler, in-process, after the checks.

**Honest scope:** this closes the accidental/default hole (unstamped =
automated at the funnel), the job-session disguise, and — via the reply-route
lint — the lazy in-repo route adoption. A deliberately adversarial in-repo
feature is governed by PR review + the lints, not runtime — same trust model
as every other in-process funnel (safe-git, safe-fs, the P17 ceiling).

### 2.3 The decision function

```
decide(envelope, topicId) →
  'deliver'        // verified-reply, or conversation-serving with live-
                   // exchange corroboration (§3.2)
| 'deliver-push'   // automated + (significant per §5, or category opted-in
                   // per §4, or legacyGate enabled per §3.5), WITHIN the
                   // §5.2 per-category push budget → hub (or the category's
                   // declared destination)
| 'record'         // automated, no push entitlement (or budget-exceeded
                   // overflow, which coalesces per §5.2) → quiet store +
                   // ledger + logs + §4.3 session routing. NEVER delivered.
```

Deterministic, synchronous, no blocking I/O: config via `liveConfig.get`
(mtime-cached in-memory), the static registry, and the §2.5 in-memory recency
map. No LLM. No text inspection of any kind. No disk reads on the send path.

**Return contract (callers must not mis-read `record` as delivery):**
`sendToTopic` returns a discriminated result — `{delivered: true, messageId}`
vs `{delivered: false, recorded: true, quietId}` — and the build sweeps
callers that branch on a Telegram message id (delivery-retry, dedup
reservation, relay ACK paths) to handle `recorded` explicitly. A recorded
send is SUCCESS for the emitter (the notice reached its governed surface);
it must not trigger delivery retries, and it must not mark "user was
notified" state anywhere. §9 requires tests per caller class, and through
Increments A–C a transitional shim LOGS every caller observed consuming a
`recorded` result (the highest practical breakage risk is a caller silently
assuming Telegram delivery — the sweep is verified by observation, not
assumed complete).

### 2.4 Fail directions (explicit, per class)

- `verified-reply` + gate exception/malfunction → **deliver** (the
  conversational surface fails toward delivery — the outbound corollary of
  The Operator Channel Is Sacred; an eaten reply is the worst failure this
  design can produce).
- `automated` + gate exception → **record**; if recording itself fails → §6.
- `dryRun: true` → **always deliver**; the ledger records the counterfactual
  verdict (`wouldRecord: true`). **The quiet store is NOT written during
  dryRun** — a delivered message must never also sit as an unread quiet item
  (phantom badges); counterfactual measurement lives in the ledger + the
  status-route counters only.
- **Relayed sends** (tokenless standby → lease holder,
  TelegramAdapter.ts:1332–1343): the envelope rides the relay exactly like
  the existing `kindMetadata`, and the DELIVERING machine (the holder — it
  owns the config and the quiet store) classifies. Three hard rules:
  - **Trust model, stated:** peer machines are the SAME agent,
    mesh-authenticated; nonetheless EVERY relayed envelope field — `origin`,
    `category`, `significantClass` — is a peer-asserted field arriving over
    HTTP. The holder classifies a relayed send FRESH: it re-applies the
    §2.2.3 breadcrumb demotion against its own topic/session state, re-checks
    the (category, class) pair against ITS OWN §5 table, applies ITS OWN §5.2
    budgets, and stamps `relayedOrigin: true` on the ledger row. Pre-decided
    verdicts never cross the mesh (§2). Forged-origin incidence is measurable
    during dryRun, and the local "no HTTP caller can assert verified-reply"
    guarantee is honestly scoped to non-mesh callers.
  - **The relay carrier (how the holder KNOWS it is a relay):** the relay hop
    is a plain authed POST today, indistinguishable from a local script call
    — so new-version relays add `{relayed: true, machineId, protocolVersion}`
    to the relay body. Presence of the marker drives `relayedOrigin` tagging
    and per-peer version gating; **ABSENCE of the marker on a send the holder
    can identify as relay-shaped is itself the legacy-skew signal** that
    triggers the fallback below. (The pool machine registry's advertised
    versions are the coarse backstop when per-request data is absent.)
  - **Version-skew direction (an envelope-less relayed send):** an OLD-version
    standby relays without an envelope. Classifying that `uncategorized` →
    `record` would EAT a conversational reply — the unsafe direction. So an
    envelope-less relayed send falls back to the already-riding
    `kindMetadata.messageKind` (`reply` → deliver; `automated`/absent →
    record). **The fallback has a pinned closure condition:** it applies ONLY
    while an identified REGISTERED peer advertises a legacy protocol version,
    and it is DEAD the moment no such peer exists — so the relay entry can
    never linger as a standing reply-disguise for local Bearer-authed
    callers. The §9 lint additionally forbids any in-repo caller outside the
    sanctioned relay module from constructing the `{relayed: true}` marker
    (mesh-signing the marker is the tracked hardening
    <!-- tracked: CMT-1950 -->). Honesty note for the inverse skew: a
    NEW-version sender relaying to a LEGACY holder degrades toward push (the
    legacy holder has no gate) — harmless while the fleet is dark/dryRun,
    gone once Increment D lands, and stated here so nobody mistakes it for a
    guarantee.

### 2.5 The inbound recency map (no hot-path disk I/O)

`MessageStore` queries are disk-backed (readFileSync + directory scans) and
must never run inside `sendToTopic`. The gate reads only an in-memory
per-topic map maintained on the INBOUND path: for each topic, the last N=20
inbound user message ids with timestamps (and the current unanswered-message
id, which the reply route already tracks — `currentInboundByTopic`,
routes.ts:12595). Memory-bounded: topics idle >7 days are LRU-evicted and the
map caps at ~1,000 tracked topics. Rebuilt lazily after restart from the
reply route's existing state; when the map is cold/unavailable,
conversation-serving corroboration FAILS OPEN TO DELIVER for the floor
categories (`cold-start-fallback`, `message-loss-notice` — their trigger IS
an inbound) and fails CLOSED to record for
`command-response`/`presence-standby` (their triggering id must be present),
each outcome ledger-tagged `mapCold: true`.

## §3 — Dispositions

### 3.1 `quiet` (THE default — D-1, D-2)

Store + ledger + log. No Telegram message. The item appears on the dashboard
pull surface (§4) with an unread badge, and routes to the relevant session
(§4.3). This includes "I'm stuck, I need your call" decision-request notices
(D-2 verbatim; see FD-14 for the named operator confirmation of that
disposition against The Agent Carries the Loop).

### 3.2 `conversation-serving` (the floor that keeps conversations whole)

Push into the live conversation topic — with structural corroboration of a
live exchange, defined concretely:

- The category is registry-declared conversation-serving AND the emitting
  module is in its `emitterModules` (lint + runtime check).
- The envelope carries `inboundMessageId` — the SPECIFIC inbound user message
  this send serves — and the gate verifies it against the §2.5 recency map.
  Per-category binding: `command-response` → the command message id,
  single-use, ≤15-minute window; `presence-standby` → the currently
  unanswered inbound id (multiple receipts may cite it while it remains
  unanswered — the standby tiers already brake volume); `cold-start-fallback`
  / `message-loss-notice` → the triggering inbound id, ≤15-minute window.
- A conversation-serving send whose corroboration fails is demoted to
  `record` + an audit row — EXCEPT the two Always-Reachable floor categories
  under a cold map (§2.5), which fail toward delivery.

These exist because the USER just acted; suppressing them would sever the
exchange (Always Reachable corollary 2; sender-rejection and loss notices are
constitutionally mandated). This is D-3's boundary drawn precisely: infra
serving a live exchange keeps flowing; agent-initiated narration does not.
An active topic is NOT a standing license: without the specific triggering
`inboundMessageId`, a conversation-serving claim records.

### 3.3 The Agent Health lane

`agent-health` items become quiet-by-default (they are the canonical
housekeeping class). When the category is opted in, pushes go to the 🩺 topic
as today. The lane's separate destination survives; its default delivery does
not.

### 3.4 Update announcements

PA-5's audience/maturity gating IS this category's legacyGate: an
announcement that passes the existing `audience: user` promotion pushes; all
else records. No second lever.

### 3.5 Legacy per-feature levers (no double-gating, no laundering)

Categories with an existing delivery flag declare it as `legacyGate`, under
one hard rule the §9 lint enforces: **a `legacyGate` key must DEFAULT FALSE.**
A default-false lever (e.g. `sentinelTelegramEscalation`) OR's with the new
category opt-in as the push entitlement — one lever, behavior-preserving, the
operator's existing choice honored. A DEFAULT-TRUE lever (e.g.
`monitoring.reapNotify.enabled`, ConfigDefaults.ts:327) would launder
push-by-default through the back door and hollow D-1; those are handled at
Increment D by a one-time `migrateConfig` SNAPSHOT — each agent's current
lever value is copied into `notifications.push.categories.<id>` (preserving
the operator's effective choice on that machine), and the lever's DELIVERY
role retires (its feature-behavior role, if any, is untouched). **This is
INTENTIONAL GRANDFATHERING, named for the operator:** an agent whose
reap-notice lever was effectively on keeps pushing reap notices after
Increment D until its operator turns the category off — the flip changes the
DEFAULT, never a standing effective choice (the ELI16 decision list carries
this). Increment D's "logs-only default everywhere" claim holds because the
snapshot preserves choices, not defaults. Full consolidation (retiring the
legacy keys entirely) remains tracked <!-- tracked: CMT-1941 -->. The dashboard
toggle is never dead: the §4.2 sole-writer route sets BOTH the category key
and (when declared) the category's legacyGate key, so one toggle is one
lever.

## §4 — The pull surface + opt-in

### 4.1 Config (top-level block, mirroring `outboundAdvisory` conventions)

```jsonc
"notifications": {
  "selectivity": {
    "enabled": false,          // omitted → resolveDevAgentGate (live on dev, dark fleet)
    "dryRun": true,            // classify + ledger only; deliver everything
    "push": {
      "categories": {          // category id → push opt-in (D-1's "unless the
        // "reap-notice": true // user requests to hear specific notifications")
      }
    },
    "digest": { "enabled": false, "cadence": "daily" },   // §4.5, D-11
    "quietStore": { "retentionDays": 30, "maxEntries": 20000 }
  }
}
```

Read via `liveConfig.get('notifications.selectivity...', default)` — hot-
applied, no restart (the block is top-level; `messaging` is an array and
unreachable for nested keys). Defaults registered in
`src/config/ConfigDefaults.ts` (`getMigrationDefaults`), migrated by
`PostUpdateMigrator.migrateConfig` (existence-checked, idempotent).

**Config keys can only opt categories INTO push. No config key can widen the
significant table (§5), reclass a category, or exempt a source from
classification (D-6).** `push.categories` is written ONLY by the §4.2
sole-writer route — never by generic `PATCH /config` (whose one-level-deep
merge is a documented hazard for nested keys).

### 4.2 The quiet store + routes

- Attention items already persist in the attention store; a quiet-routed item
  is marked `heldQuiet: true` and simply never generates the hub send. `GET
  /attention` and the dashboard tab keep working unchanged.
- Non-attention quiet sends land in a new `QuietNotificationStore`
  (`state/quiet-notifications.jsonl`), with storm discipline learned from the
  2026-07-09 EvolutionManager doom-loop and the 17.5k-requests day:
  - **Coalescing (pinned mechanics):** repeats within a rolling window keyed
    (category, sourceContext) ACCUMULATE IN MEMORY and flush **at most one
    row per key per window** (on window close, a flush timer, or clean
    shutdown) — so a 17.5k storm writes O(windows) physical rows, not 17.5k,
    and cannot evict everyone else's history via the `maxEntries` prune or
    inflate the boot index rebuild. A crash loses at most the open window's
    tail count — explicitly accepted; the flushed row carries
    `coalescedApprox: true` when a crash truncated its window.
  - **Durability semantics (pinned):** ONE writer (the server process's
    single appender); appends are line-atomic via O_APPEND; no per-row fsync
    (the accepted loss window is the crash tail, reconciled against the §7
    counters); the boot index build SKIPS-and-counts a torn final line;
    rotation is write-new-segment-then-rename (atomic), never in-place.
  - **Bounded by rotation:** prune enforces `retentionDays`/`maxEntries` by
    file ROTATION (write a fresh segment, archive the old), never a full-file
    rewrite on the write path.
  - **In-memory index:** built at boot, maintained incrementally; `GET
    /notifications/quiet` paging and unread counters NEVER scan the JSONL per
    request.
  - **Acks are appended rows** (event-sourced mark-read), resolved by the
    index — no row rewrites, no rewrite races.
- Routes:
  - `GET /notifications/quiet` — paged feed (`?category=`, `?unread=`,
    `?scope=pool` merged read; pool paging uses per-machine cursors with a
    bounded per-peer fetch);
  - `PATCH /notifications/quiet/:id` — mark read/acked (append ack row);
  - `GET /notifications/selectivity` — status: enabled/dryRun, per-category
    counters (delivered/pushed/recorded/coalesced/lost + unread-aging), the
    authoritative soak evidence (§7), opt-in inventory, store health;
  - `POST /notifications/categories/:id/push` — **the SOLE writer** for
    opt-ins (see FD-11): Bearer-authed, but every write REQUIRES a
    `confirmedBy` provenance field (`dashboard-pin` | `operator-conversational-
    confirm`), rejects ids absent from the registry, writes an audit row
    (actor, surface, old→new), and also sets the category's declared
    legacyGate key (§3.5). **The conversational rung is deterministic, not
    attested:** a `confirmedBy: operator-conversational-confirm` write MUST
    cite `confirmingMessageId` — the operator's confirming inbound message —
    verified against the §2.5 recency map (≤15 min) AND resolved to the
    topic's VERIFIED operator binding (Know Your Principal — in a multi-user
    topic, another registered user's message is not the operator's consent);
    a write without a resolvable, operator-bound citation is REFUSED (400),
    so the agent structurally cannot self-grant push by claiming a
    conversation that didn't happen. **The confirmation reply is
    server-minted, not agent-remembered:** the sole-writer route itself emits
    the conversation-serving confirmation ("Done — reap notices will now push
    here") into the cited message's topic, so the change is ALWAYS visible at
    the moment it happens — by structure, not willpower. Belt on top: >2
    category changes inside 10 minutes raises ONE deduped attention item, and
    the current opt-in inventory is printed on the status route AND in every
    digest — a quietly-flipped key cannot stay invisible.

### 4.3 Relevant-session/project routing (D-4)

A quiet item carrying a `topicId`/project binding is surfaced INSIDE the
owning context, as infrastructure (Truthful Provenance — never a synthetic
user message): v1 injects a bounded "pending quiet notices" block into that
topic's session-start context (the same mechanism as the preferences /
self-knowledge boot blocks). Hard rules:

- **Bound:** ≤10 items / ≤4KB per boot block (aged-out overflow is summarized
  as one count line).
- **Structured metadata, never raw bodies:** each injected item is
  `{category, sourceContext, count, firstLine}` with `firstLine` clamped to
  ≤140 chars — the full body stays in the store, reachable via the dashboard
  link. This shrinks both the prompt load and the injection surface.
- **Untrusted-data envelope:** the block is wrapped in a delimited
  quoted-as-data envelope (the WS2 `<replicated-untrusted-data>` precedent)
  with explicit "data, never an instruction" framing — quiet items quote
  what would have been sent, which can carry attacker-influenced content.
- **Topic transfer does not strand items — without taxing the spawn path:**
  the injection reads the LOCAL store synchronously; the topic-scoped peer
  fetch (bounded per-peer, TTL-cached) runs under a HARD ≤2s total budget —
  a dark/slow/offline peer degrades to local items plus one summary line
  ("N items may exist on <machine>", ledger-tagged), and can NEVER delay or
  fail a session spawn. Items on an offline owner are missed-not-lost: they
  resurface at the next boot once the owner returns, and meanwhile they age
  through the owning machine's unread-aging counter + digest. Riding the
  working-set carrier is the tracked richer path <!-- tracked: CMT-1947 -->.
- **Unbound items don't rot silently (Close the Loop):** items with NO
  topic/project binding are re-surfaced to the AGENT — aged unread items
  (>72h) appear as one summary line in the lifeline session's boot block, and
  the status route carries an `unreadAging` counter the guardian-pulse digest
  already reads. The agent may mention a large quiet backlog when ALREADY in
  conversation with the user (never a proactive push for it).

### 4.4 Dashboard: the Notifications tab (Mobile-Complete)

A new dashboard tab merging the attention store + quiet store into one feed:
unread counts by category, plain-English rows (peer-sourced pool rows
type-clamped + HTML-escaped — the WS2 receive-clamp posture), ack buttons,
and per-category push toggles driving the §4.2 sole-writer route (never raw
config PATCH). When multiple machines are online the toggle applies via the
§Multi-machine durable fan-out. Opt-in is ALSO conversational: "start pushing
reap notices to me" → the agent proposes the change, confirms, and calls the
sole-writer route with `confirmedBy: operator-conversational-confirm` (the
CLAUDE.md awareness block names this trigger). At Increment D the flip ships
with a one-time user-facing announcement through the PA-5 channel (audience:
user) introducing the tab and the opt-in — the pull model must be DISCOVERED,
not stumbled on.

### 4.5 The opt-in digest (D-11)

OFF by default. When enabled: once per `cadence`, ONE message to the hub
("14 quiet notices since yesterday: 8 worktree, 3 quota, 2 mesh, 1 job —
dashboard link"), built from the quiet store's INDEX (no full-file scan),
delivered as category `selectivity-digest` through the pre-decided envelope
path. **Digest content is pinned to counts + category names + the dashboard
link + the opt-in inventory + the unread-aging counter — never raw item
titles/text** (no smuggling surface). Calm-empty periods send nothing
(GrowthDigestPublisher's `sendOnCalmWeeks:false` precedent). A digest-build
failure is logged + counted on the status route; it never retries more than
once per cadence tick (P19).

## §5 — The significant lane (D-5, D-6)

A small **code table** (`SIGNIFICANT_TABLE` in the registry module) maps
(category, significantClass) → hub-push-without-opt-in:

```ts
type SignificantClass = 'security-incident' | 'data-loss' | 'agent-cannot-operate';
```

Class definitions with examples (FD-1; erosion-resistant by example, not
vibes):

- `security-incident` — evidence of compromise or credential exposure
  (mandate-audit chain broken, forged mesh identity, secret found in a public
  surface). NOT: a failed login, a blocked operation, a suspicious-but-handled
  input.
- `data-loss` — user data or agent state has been lost or is imminently being
  lost (store corruption confirmed, quiet-store double failure §6, tombstone
  divergence destroying records). NOT: a retryable write failure, a pruned-
  by-policy record, a rotated log.
- `agent-cannot-operate` — the agent as a whole cannot serve (no session can
  spawn AND the lifeline floor is failing). NOT: one wedged session, one
  rate-limited account, one dark peer — those have owners (sentinels, floors,
  reconcilers) per D-3. This class is deliberately the narrowest; it is the
  historical "urgent" escape-hatch shape, so its registry binding is expected
  to name at most one or two emitter modules.

Rules:

- An emitter self-labeling `significantClass` outside its registry-declared
  set is **ignored** (recorded quiet + an audit row naming the mislabel) —
  crying wolf buys nothing; the June-13 round-1 trapdoor fix, applied to
  classes. Because classes bind to (category, module) pairs and category
  stamping itself is module-bound (§2.1 lint), a feature cannot borrow a
  privileged category to borrow its classes.
- **Episode dedup, defined:** episode key = (category, significantClass,
  sourceContext), re-raise no sooner than every 6h while the condition
  persists; a NEW sourceContext is a new episode (and P17/§5.2 budgets bound
  the aggregate).
- Extension is a PR to the code table, reviewed like any constitution-adjacent
  change. No config path exists (D-6).

### 5.2 Per-category push budget (the opt-in door is bounded — P17/P19)

Every `deliver-push` — opted-in OR significant — passes a rolling budget at
the gate (FD-15). Pinned semantics:

- **Per-category:** default **3 pushes per category per 10 minutes**;
  overflow COALESCES into one summary push per window. The summary does NOT
  consume the budget (it is the window's overflow representative, at most one
  per category per window, so summaries themselves cannot flood).
- **Significant classes ride their OWN lane:** significant pushes are
  budgeted per (category, class) separately from routine opted-in pushes, so
  an opted-in routine storm can never crowd out or hide a significant push —
  and a significant-class overflow summary NAMES the class ("security-
  incident: 4 more episodes in 10m"), never dressed as routine volume (the
  P17 criticals-stay-visible precedent).
- **Global ceiling:** at most **10 pushes per 10 minutes across ALL
  categories** (the cross-category analog of the P17 global topic ceiling);
  overflow folds into ONE cross-category summary. The global ceiling applies
  to ROUTINE (opted-in) pushes; significant-lane pushes are bounded by their
  own lanes and are never displaced or folded by routine volume — routine
  storms across many categories cannot consume the headroom a significant
  push rides on.
- **Summary content is pinned** like the digest (§4.5): count + category/
  class name + the dashboard link — never `sourceContext`, titles, or item
  text.
- **Scope honesty:** budgets are per-machine and in-memory (a restart resets
  the window; pool-wide worst case is budget × machines) — accepted and
  stated, with P17's delivery-layer bounds as the backstop. The status route
  reports the pool-wide theoretical maximum (budget × online machines); a
  lease-holder-coordinated global budget is a tracked follow-up
  <!-- tracked: CMT-1951 -->.
- **Key-space bounds (the unique-sourceContext storm — the 2026-06-05 dodge
  shape):** the §4.2 coalescing accumulator and the §5 episode-dedup map are
  both keyed on emitter-supplied `sourceContext`, so both carry a TTL + a
  per-category key cap (the §2.5 recency-map precedent); when a category
  exceeds its key cap inside a window, further keys coalesce at CATEGORY
  level (one row/summary for "N distinct sources") — a storm of unique labels
  buys category-level coalescing, never O(storm) rows or pushes.
- Everything coalesced or over-budget is individually recorded in the quiet
  store — a budget never loses an item, it only bounds pushes.

This closes the foundation gap §8.1 names (#1417's unbounded per-source hub
message stream) and keeps an opted-in category or a storming significant
emitter from becoming flood round five: opting in entitles the category to
push, never to push UNBOUNDED. The budgets are code defaults (tunable down,
never off, via config — same posture as the P17 budgets); the D-10 burst
test gains an opted-in arm asserting the bounded push count.

### 5.4 Composition with Self-Heal Before Notify (P22)

Heal-exhausted escalations raise attention items exactly as today; whether
that item PUSHES is this gate's call — critical-class exhaustions (data-loss
/ security / cannot-operate) push via the significant lane; routine
exhaustions are quiet (dashboard + digest + §4.3 routing). P22's "operator
hears only when self-healing fails" becomes "…and hears it on the surface the
operator chose."

## §6 — Failure honesty (the log surface is down)

Quiet-routing is only legitimate while recording works. Failure ladder, with
its Standard-B declaration (this ladder is a notify-on-failure path, so it
declares its own brakes):

1. Quiet-store write fails → bounded in-line retry (max-attempts: 3, backoff
   1s/5s/30s, idempotent append — a duplicate row is harmless and reconciled
   by the index) → on exhaustion, fallback append to
   `logs/quiet-notifications-fallback.jsonl` (plain JSONL, 2MB rotation).
2. Fallback also fails (disk full / FS error) → increment an in-memory loss
   counter; raise ONE deduped `data-loss`-class significant notice ("my quiet
   notification store is failing — N automated notices could not be recorded
   since <t>; check disk/dashboard") through the pre-decided envelope path.
   Brakes: dedupe-key = the §5 episode key (category `attention-item`,
   sourceContext `selectivity-store-failure`); max-notification-latency:
   ≤120s from the first double-failure (the notice is raised on the failing
   tick, not batched); re-raise per the 6h episode rule while failing;
   breaker: after 3 episodes in 24h the notice states "persistent — manual
   attention needed" and stops re-raising until recovery; audit-location: the
   decision ledger + console (metadata only, never message bodies).
3. Recovery detection = the next successful quiet-store write; a
   reconciliation ledger row records the total lost count; the counter
   resets.
4. **Recursion safety (tested, §9):** the step-2 notice classifies via the
   hardcoded §5 table to `deliver-push` and writes NO quiet-store entry — it
   can never re-enter the failure it reports. A unit test pins "the §6 notice
   can never classify `record`".
5. The DECISION LEDGER (§7) failing never blocks delivery or recording — it
   degrades to console + a status flag on `GET /notifications/selectivity`.
6. While the significant lane itself cannot deliver (Telegram down), the
   existing PendingRelayStore durability owns retry — unchanged.

## §7 — Observability

- **Decision ledger:** `logs/notification-selectivity.jsonl` — one row per
  gate decision: `{ts, origin, category, significantClass?, decision, reason,
  dryRun, wouldRecord?, relayedOrigin?, mapCold?, kindDivergence?, topicId,
  sourceContext, machineId}`. Bounded rotation (2MB pattern).
  `kindDivergence` names the case where the tone gate's `messageKind` and
  this gate's `origin` disagree about one send (dual provenance made visible,
  never implicit).
- **dryRun counterfactuals:** while `dryRun: true`, `wouldRecord: true` rows
  measure exactly what enforcement WILL suppress. Named canary metrics the
  Increment-C flip is gated on (FD-12): `eatenReplyCounterfactual` (a
  verified-reply-adjacent send that would demote) and
  `demotedConversationServing` (a floor category that would record) — both
  driven to zero; plus `replyWithoutRecentInbound` (FD-9's promotion
  evidence).
- **Counters are the authoritative soak evidence** (the rotating ledger is
  the sample, the per-category counters on `GET /notifications/selectivity`
  are the record): delivered/pushed/recorded/coalesced/lost/unreadAging per
  category, plus the canary metrics above.
- No LLM calls anywhere on the path → no token-audit surface needed
  (Token-Audit Completeness: zero-spend by construction).

## §8 — Composition (one pipeline, disjoint authorities — no double-gating)

Order of layers for a Telegram-bound emission:

```
1. ORIGINATION      envelope stamped (reply route / scheduler stamps /
                    emitter callsites)                                [this spec]
2. CONTENT layers   tone gate (conversational, route-scoped, unchanged)
                    outbound advisory preflight (automated job sends,
                    unchanged)                                        [PA-3/PA-4]
3. LAST HOP         NotificationSelectivityGate: deliver | deliver-push
                    | record — evaluated ONCE per send (pre-decided
                    envelopes pass through, §2)                       [this spec]
4. DELIVERY         hub routing (#1417) · duplicate suppression ·
                    AttentionTopicGuard · topicCreationBudget ·
                    PendingRelayStore                                 [unchanged]
```

Authority boundaries, explicitly:

- The **tone gate** judges CONTENT of conversational turns. It never decides
  logs-vs-push. This gate never reads content. A message can be tone-gated
  AND quiet-routed without conflict (tone verdicts apply to what would be
  delivered; a recorded message skips delivery, and its stored text is the
  post-advisory text as-emitted). Where the two layers' provenance fields
  disagree, the ledger's `kindDivergence` row makes it visible (§7).
- The **advisory layer** informs automated SENDERS about content. Its
  NOT-SENT advisory happens at preflight, before this gate; a send that
  passes advisory but lacks push entitlement records quietly. No conflict:
  advisory shapes text, selectivity routes it.
- **P17/P23 machinery** bounds and routes whatever this gate permits to push.
  This gate reduces their load; it never relaxes them.
- **Signal vs. Authority:** this gate holds blocking-equivalent ROUTING
  authority while being deterministic — legitimate because its key is
  structural provenance (who/where a message came from), the same class of
  key as the P17 origin-typed ceiling, not brittle content interpretation.
  Everything content-interpretive on the path remains signal-only or
  LLM-judged exactly as today.

### 8.1 Foundation gap surfaced (not silently inherited)

#1417's single-topic mode routes EVERY attention item to the hub BEFORE
`AttentionTopicGuard` runs (TelegramAdapter.ts:3877–3884), and
`topicCreationBudget` bounds topic creation only — so per-source hub MESSAGE
volume is unbounded on main today. This spec closes it structurally via §5.2
(quiet default + bounded push budget). Named here per the lessons-aware
foundation-audit rule: a spec must surface a foundation flaw, not build
around it silently. Should this spec be rejected, that gap still needs an
independent fix.

## Decision points touched

- NEW routing decision at `sendToTopic`/`createAttentionItem`: deliver /
  deliver-push / record (this spec's core), evaluated once per send.
- NEW bounded-push decision: the §5.2 per-category budget (coalesce on
  overflow).
- PROMOTED: the reply route's class-spoof breadcrumbs (routes.ts:12461–12503)
  from log-only to classification input (§2.2.3), locally and on the
  relay-receive hop (§2.4).
- INVERTED: absence-of-stamps no longer defaults to `'reply'` for delivery
  purposes (the tone gate's `messageKind` default is untouched for its own
  content review; divergence is ledger-visible).
- UNCHANGED: tone gate verdicts, advisory verdicts, P17/P23 budgets, hub
  find-or-create self-heal, PendingRelayStore retry.

## Frontloaded Decisions

Every open question is resolved here with a default; the ELI16 restates each
in plain English for operator confirmation at approval time. None require a
mid-build stop.

- **FD-1 — Significant set ships as `{security-incident, data-loss,
  agent-cannot-operate}`**, with the §5 positive/negative example definitions.
  Nothing else pushes without opt-in — including "I need your decision" (D-2,
  FD-14). Extension is PR-only (D-6).
- **FD-2 — Conversation-serving floors:** `presence-standby`,
  `cold-start-fallback`, `message-loss-notice`, `command-response` — each
  bound to a specific triggering inbound (§3.2). The set is cheap to change
  ONLY while dryRun holds; from Increment C it is a user-visible interface
  change, so the flip gate includes the `demotedConversationServing` canary
  at zero (§7) and any post-enforcement change to the set is operator-
  confirmed like FD-13.
- **FD-3 — Digest defaults OFF, daily, to the hub** (D-11); content pinned to
  counts + inventory, never item text (§4.5).
- **FD-4 — Opt-in granularity is per-category** in v1; per-source/per-topic
  granularity deferred <!-- tracked: CMT-1943 -->.
- **FD-5 — Opted-in pushes land at the category's declared destination**
  (hub, or 🩺 for agent-health; conversation for conversation-serving).
  Never a new topic (P23).
- **FD-6 — Retention 30 days / 20k entries**, enforced by rotation with
  storm-coalescing (§4.2), prune counts on the status route.
  Cheap-to-change-after (config, hot-applied, internal store).
- **FD-7 — Multi-machine opt-in is UNIFIED via the sole-writer durable
  fan-out:** a toggle applies to every machine — online peers immediately,
  offline peers via a durably queued write replayed on their return (the
  WS4.1 durable-ack precedent, INCLUDING its load-bearing half:
  **apply-time revalidation**). Every write carries a per-key monotonic
  version stamped by the sole-writer, machine-qualified (version +
  machineId tiebreak) so two machines' concurrent writes can never mint
  colliding versions; a queued replay applies ONLY-IF-NEWER,
  so a stale queued opt-in can never resurrect a since-reverted choice. The
  queue is bounded (per-peer cap; entries expire after 7 days — a
  permanently-dark peer cannot accumulate forever). Per-machine application
  state is shown on the status route; the LEASE-HOLDER runs the divergence
  comparison, and divergence persisting >24h raises ONE deduped attention
  item (loud, not a silent footnote). Durable REPLICATION of the whole
  preferences block remains tracked <!-- tracked: CMT-1945 -->.
- **FD-8 — Rollout keeps a lever until the cleanup increment** (see DEV-1):
  `enabled`/`dryRun` exist through the maturation ladder; the June-13 "no
  break-glass" (D-9) is honored as the END state — a tracked final increment
  removes the legacy always-push path after fleet soak
  <!-- tracked: CMT-1948 -->. Flipping `enabled: false` post-Increment-D emits
  an operator-visible warning naming the blast radius ("push-everything
  behavior restored"); `dryRun: true` is the preferred lever short of
  emergencies.
- **FD-9 — The recent-inbound reply corroboration (§2.2.4) is advisory-only
  in v1**, with concrete promotion exit criteria: ≥14 days of Increment-C
  enforcement, ≥200 observed reply-path sends, and every
  `replyWithoutRecentInbound` incident audited to zero false positives. (An
  eaten late reply is strictly worse than a leaked automated push.)
- **FD-10 — The gate is Telegram-first.** Slack/WhatsApp/iMessage adapters
  gain the same gate at their send funnels in a follow-up; the envelope type
  and registry are adapter-agnostic by construction
  <!-- tracked: CMT-1944 -->.
- **FD-11 — Opt-in write authority:** the §4.2 route is the SOLE writer;
  every write carries `confirmedBy` (`dashboard-pin` |
  `operator-conversational-confirm`) + an audit row; unregistered ids are
  rejected; >2 category changes in 10 minutes raise one attention item; the
  inventory prints on status + digest. The agent NEVER opts categories in
  without a recorded operator confirmation — self-granted push would reopen
  the exact inversion D-1 closes. (Honest scope: `operator-conversational-
  confirm` is agent-attested; the PIN path is the strong rung, and the audit
  + inventory + attention item make a false attestation visible, which is
  proportionate for a notification preference.)
- **FD-12 — Enforcement flips are OPERATOR actions:** the Increment-C dev
  flip (`dryRun: false`) and the Increment-D fleet default flip both require
  explicit operator confirmation, gated on: 14 clean days, ≥200 reply-path
  sends observed (an idle window proves nothing), `eatenReplyCounterfactual`
  = 0, `demotedConversationServing` = 0. The agent PRESENTS the evidence; the
  operator flips.
- **FD-13 — The §1 v1 registry table ships as printed;** operator approval of
  this spec binds the table (18 categories + dispositions + the
  `uncategorized` default). The dashboard tab is named **Notifications**.
- **FD-14 — `commitment-deadletter` defaults QUIET (D-2), and this is a named
  operator decision** because The Agent Carries the Loop (ratified 2026-06-14,
  one day AFTER the June-13 conversation) expects a genuinely-stuck
  agent-owned obligation to surface ONCE. Under this spec that surfacing is:
  the quiet store + unread badge + §4.3 lifeline aging (+ the digest ONLY if
  the operator has enabled it — it defaults OFF, so the honest default path
  is the dashboard badge + boot-context aging) — not a Telegram push — unless
  the operator opts `commitment-deadletter` in. The ELI16 puts this collision
  in front of the operator explicitly (DEV-6).
- **FD-15 — The push budgets ship as printed (§5.2):** 3 per category per 10
  minutes + a separate significant lane per (category, class) + a global
  ceiling of 10 per 10 minutes, overflow always coalescing to one pinned
  summary. Tunable down via config, never off. These cap what an opted-in
  operator actually receives, so approval binds them like FD-13 binds the
  table.

## Deviations from / extensions to the June-13 design (flagged honestly)

- **DEV-1 (deviation, D-9):** June-13 removed the break-glass entirely. This
  reconstruction ships with `enabled`/`dryRun` levers because the graduated
  rollout ladder (dark → dev-dryRun → dev-enforce → fleet) is itself a
  post-June-13 constitutional norm (Maturation Path), and an UNLEVERED flip
  of every agent's messaging disposition would be reckless. D-9 is honored as
  the end state (FD-8). **Operator confirmation requested.**
- **DEV-2 (extension):** the category registry + legacyGate mapping (§3.5)
  did not exist in the June-13 conversation (the per-feature levers it
  reconciles mostly shipped after June 13 — #1417, reapNotify, ropeHealth).
- **DEV-3 (extension):** conversation-serving corroboration (§3.2) — the
  June-13 conversation established "replies unaffected" (D-8); the explicit
  structural floor for standby/cold-start/loss notices is drawn here because
  those notices now exist as constitutional floors (Always Reachable, shipped
  post-June-13).
- **DEV-4 (extension):** FD-9's advisory-first stance on inbound
  corroboration; June-13 round 2 specified the last-hop inversion but not
  this check's authority level.
- **DEV-5 (reconciliation):** June-13's "single Alerts topic" is realized as
  the existing #1417 "🔔 Attention" hub rather than a new topic.
- **DEV-6 (temporal collision, named for sign-off):** The Agent Carries the
  Loop was ratified 2026-06-14 — one day after D-2. Its "surface a stuck
  obligation once" expectation and D-2's "even I'm-stuck goes to logs" pull
  in opposite directions for decision-request notices. This spec resolves per
  D-2 + the reaffirmed 2026-07-10 directive (quiet default, FD-14's named
  surfacing path), and puts the collision in front of the operator in the
  ELI16 rather than silently picking. **Operator confirmation requested.**
- **DEV-7 (extension):** the §5.2 per-category push budget — June-13 bounded
  nothing on the push side because pushes were to be rare; the budget is the
  Distrust-Temporary-Success hardening that keeps the opt-in door from
  becoming flood round five, and it also closes the #1417 foundation gap
  (§8.1).

## Multi-machine posture (Cross-Machine Coherence)

- **Decision ledger + quiet store:** machine-local WRITE (each machine
  records what IT suppressed), **proxied-on-read** — `GET
  /notifications/quiet?scope=pool` merges every online machine with
  per-machine cursors and bounded per-peer fetches, following the
  `GET /attention?scope=pool` merged-read precedent (its own TTL-cached
  fan-out, routes.ts:13762/:13852 — NOT the dark-gated PoolPollCache, so the
  read works wherever attention's pool read works). Peer rows are
  type-clamped + length-bounded on receive and HTML-escaped in the dashboard
  (the WS2 receive-clamp posture).
- **Category opt-in config: UNIFIED** via the FD-7 sole-writer durable
  fan-out (online peers immediate, offline peers durably queued + replayed,
  >24h divergence raises one attention item). No machine-local surface is
  declared here; no `machine-local-justification` marker is required — the
  per-machine FILE is an implementation detail beneath a unified operator
  surface with loud divergence detection.
- **The hub topic id:** machine-shared agent state as shipped by #1417 (boot
  state key `agent-attention-topic`); unchanged here.
- **Relayed sends:** envelope rides the relay; the DELIVERING machine
  classifies, re-applies breadcrumb demotion, and tags `relayedOrigin` (§2.4)
  — so a topic's quiet items land on its owning machine's store, and §4.3's
  topic-scoped pool read keeps them visible after a transfer.

## Security posture

- The envelope is minted at in-process chokepoints; no NON-MESH HTTP caller
  can assert `verified-reply` (the route computes it; request fields cannot
  set it). On the mesh relay hop the origin is peer-asserted by the same
  agent's other machine (mesh-authenticated), re-checked by the holder's
  breadcrumb demotion, and ledger-tagged `relayedOrigin` (§2.4) — stated
  honestly rather than over-claimed.
- The internal pre-decided envelope is an unforgeable in-process object
  (module-private class), so already-decided pushes (§5, §6) cannot be
  spoofed by stamping a lookalike category (§2).
- No new push surface: everything this gate can PUSH already existed; the
  gate only ever narrows delivery. The one new outbound content class (the
  digest) is pinned to counts + category names (§4.5) — no smuggling surface.
- The quiet store may contain paths/jargon (it holds exactly what would have
  been sent); it is served only on Bearer-authed routes + the PIN-gated
  dashboard — same exposure class as `GET /attention`. Session-start
  injection wraps every item in the untrusted-data envelope (§4.3).
- The opt-in write route changes notification preferences only; it cannot
  touch the significant table, the registry, or any safety gate (D-6); its
  writes are provenance-stamped, audited, inventory-surfaced, and
  mass-change-alarmed (FD-11).
- No LLM on the path: nothing to prompt-inject at the gate; ledger rows quote
  `sourceContext` as data.

## §9 — Testing (Testing Integrity — all three tiers)

- **Unit:** classification matrix (every origin × category × opt-in ×
  significant combination; both sides of every boundary); envelope-absent →
  quiet; class-mislabel ignored + audited; category stamped by a module not
  in `emitterModules` → recorded + audited; §5.2 budgets both sides per lane
  (routine under → push, over → one pinned coalesced summary that does NOT
  consume budget; significant lane isolated from routine storms; global
  ceiling folds to one cross-category summary); the pre-decided envelope is
  single-use (a captured instance cannot replay past the budget); fail
  directions (§2.4 — gate-throw on reply delivers, on automated records;
  dryRun never writes the quiet store); relay handling (envelope-less
  relayed reply delivers via kindMetadata; envelope-less relayed automated
  records; a relayed pre-decided claim is classified FRESH by the holder);
  §6 ladder incl. loss counter, single deduped notice, breaker after 3
  episodes, and the recursion pin ("the §6 notice can never classify
  `record`"); recency-map cold behavior per category (§2.5) + LRU bounds;
  coalescing mechanics (storm → ≤1 flushed row per key per window;
  crash-tail marked `coalescedApprox`); torn-final-line skip at boot;
  event-sourced acks; the opt-in write refusals (missing/unresolvable
  `confirmingMessageId` → 400; unregistered id → 400); registry completeness
  lint (unique ids, valid dispositions, legacyGates resolve AND default
  false, emitterModules non-empty).
- **Integration (the D-10 burst invariant, extended):** with enforcement on +
  shipped defaults, fire 1,000 automated emissions through the REAL pipeline
  (mixed categories, unique source labels, unstamped raw `sendToTopic` calls,
  attention items at every priority) → **ZERO Telegram sends**; all 1,000
  recorded (coalesced rows count); significant-class emissions → exactly the
  deduped, budget-bounded hub messages; a verified reply → delivered
  untouched. **Opted-in arm (DEV-7):** opt one category in, fire 500 → at
  most the §5.2 budget of pushes + one coalesced summary per window, all 500
  recorded. Build fails on ONE stray (D-10 verbatim: zero, not "a few").
- **Integration (HTTP + relay):** the §4.2 routes; pool-scope merged read
  with a dark peer; opt-in sole-writer round-trip (confirmedBy required,
  unregistered id rejected, legacyGate key co-written, mass-change attention
  item); a relayed send classified on the holder (both skew directions);
  dryRun counterfactual rows without quiet-store writes.
- **E2E lifecycle:** production init path — gate wired non-null into the real
  adapter, routes 200 when enabled (503 dark), dryRun verdicts appear in the
  ledger for a real automated emission, a real reply flows untouched.
- **Funnel lints** (`scripts/lint-notification-selectivity.js`, the safe-git/
  safe-fs pattern):
  1. every `sendToTopic` callsite carries an envelope (or a recognized
     pre-decided pass-through);
  2. callsite→category fit: a module may stamp only categories naming it in
     `emitterModules`;
  3. NO new raw `apiCall('sendMessage')` callsites (the existing
     grep-enumerated set — ~nine at reconstruction time, re-enumerated at
     lint-baseline per §2.1 — carries in-code justifications);
  4. NO new in-repo `POST /telegram/reply` callers outside the sanctioned
     relay scripts;
  5. every `legacyGate` key defaults false in ConfigDefaults.

## Migration Parity

- Config defaults: `ConfigDefaults.getMigrationDefaults` +
  `PostUpdateMigrator.migrateConfig` (existence-checked, idempotent).
- **Increment-D legacy-lever snapshot:** a one-time migration copies each
  default-TRUE legacy lever's CURRENT per-agent value into
  `push.categories.<id>` (§3.5) — operators' effective choices survive
  (intentional grandfathering, named in the ELI16); the fleet default still
  flips to quiet. **Idempotency pinned:** the snapshot writes a key ONLY IF
  ABSENT (an operator's Increment-B/C sole-writer choice always beats the
  legacy lever value) and records a one-time durable migration marker (the
  `_instar_migrations` precedent), so re-runs are no-ops. The Increment-D
  announcement (§4.4) explicitly LISTS any grandfathered push categories the
  agent carried over, with a one-tap disable-all in the dashboard tab — a
  never-knowingly-chosen default-true lever must not survive invisibly.
- CLAUDE.md template (`generateClaudeMd`) gains a "Quiet by Default
  notifications" awareness block (the pull surface, the opt-in trigger
  phrases, the status route) + `migrateClaudeMd` content-sniffed patch.
- No hook or skill migrations expected.
- The `uncategorized` default makes the migration order-safe WITHIN a machine
  (emitters and gate swap atomically in one dist). The cross-machine skew
  case is §2.4's relay fallback; enforcement on relayed sends gates on peer
  protocol version.

## Agent Awareness (template block, summary)

"Automated notices are quiet by default: they land in your dashboard
Notifications tab + logs, not Telegram. When the user asks 'why didn't you
ping me about X?' → check `GET /notifications/selectivity` and the quiet
feed; offer the per-category push opt-in ('want me to push reap notices?' —
confirmed opt-ins go through the sole-writer route with `confirmedBy`).
When the user says 'stop pushing X' → clear the category key. NEVER promise
to push a category that isn't opted in; NEVER opt a category in without the
user's explicit confirmation."

## Rollout (graduated; the rollback lever is FD-8/DEV-1)

1. **Increment A (dark):** registry + envelope stamping + gate in
   OBSERVE (`dryRun: true`) + decision ledger + lints. Dev agents live-dryRun
   (`enabled` omitted → `resolveDevAgentGate`), fleet dark. Zero behavior
   change anywhere.
2. **Increment B:** quiet store + routes + dashboard Notifications tab +
   opt-in surface (read/write, still no suppression).
3. **Increment C (dev enforcement — OPERATOR flip, FD-12):** `dryRun: false`
   on dev agents after the FD-12 evidence bar (14 clean days, ≥200 reply
   sends, both canaries at zero). Quiet categories stop pushing on dev.
4. **Increment D (fleet — OPERATOR flip, FD-12):** default flips fleet-wide
   (logs-only default everywhere) + the legacy-lever snapshot migration + the
   one-time user-facing announcement (§4.4) + awareness block. Rollback at
   every stage: `dryRun: true` preferred; `enabled: false` restores
   push-everything instantly (live-config, no restart) and emits the FD-8
   blast-radius warning.
5. **Increment E (end-state, D-9):** after fleet soak, remove the legacy
   always-push path so quiet-by-default is structural, not configured
   <!-- tracked: CMT-1948 -->. Operator-ratified at that increment, not before.

## Alternatives considered

- **Per-feature opt-outs (status quo):** rejected — four floods proved
  feature-by-feature willpower fails; the June-13 root-cause admission.
- **LLM significance judgment on the delivery path:** rejected — adds a
  fail-closed/fail-open dilemma to every automated send, spends tokens on
  housekeeping, and violates the deterministic-last-hop requirement
  (emission-gate brief PA-9 reached the same conclusion).
- **Priority-keyed gating (HIGH/URGENT always push):** rejected in the
  June-13 round 1 — the trapdoor: features mark everything critical. Classes
  are registry-bound per (category, module) instead (§5).
- **SQLite / an embedded event store for the quiet store:** considered — the
  repo already runs SQLite for `PendingRelayStore`, and the quiet store is
  admittedly a small event log (append rows + ack rows + an index). JSONL is
  chosen for v1 because it matches the file-based-state doctrine, the write
  path is single-process append-only (no concurrent-writer problem SQLite
  would solve), and the read path is index-only; the store sits behind an
  interface, so migrating to SQLite if concurrency or indexing outgrows JSONL
  is an implementation swap, not a spec change.
- **A second gate at the attention layer only:** rejected — attention is one
  emitter family; the disguise hole, the ~40 direct `sendToTopic` callers,
  and the grep-enumerated raw `sendMessage` callsites (§2.1) require the
  funnel-level last hop plus lint closure of the bypasses.
- **Blocking at the tone gate:** rejected — route-scoped (in-process callers
  bypass it), content-judging (wrong key), and its fail-closed direction is
  wrong for replies.

## Deferred / declined — tracked, not dropped (Close the Loop)

At build start, each deferral below is minted its own commitment (CMT id)
with follow-through cadence; the topic marker is the reconstruction-time
anchor, not the final tracking grain.

- Legacy-lever full consolidation into `notifications.push.categories`
  <!-- tracked: CMT-1941 -->
- Live-turn quiet-notice injection into running sessions (v1 is session-start
  only) <!-- tracked: CMT-1942 -->
- Per-source / per-topic opt-in granularity <!-- tracked: CMT-1943 -->
- Slack/WhatsApp/iMessage adapter parity for the gate
  <!-- tracked: CMT-1944 -->
- Durable cross-machine replication of the notification-preferences block
  (FD-7's fan-out is the unified surface meanwhile) <!-- tracked: CMT-1945 -->
- Promotion of the recent-inbound reply corroboration to demotion authority
  (FD-9 exit criteria) <!-- tracked: CMT-1946 -->
- Working-set-carrier transport for quiet items on topic transfer (§4.3's
  pool read is the v1 path) <!-- tracked: CMT-1947 -->
- Increment E legacy-path removal (D-9 end state) <!-- tracked: CMT-1948 -->
- Emission-authority confidence gating for status claims (the PA-9 brief's
  lane — converges separately, plugs into the registry)
  <!-- tracked: CMT-1949 -->
- Mesh-signed relayed-marker hardening (§9 relay-marker lint)
  <!-- tracked: CMT-1950 -->
- Lease-holder-coordinated pool-global push budget (§5.2)
  <!-- tracked: CMT-1951 -->

## Resolution note (why Open questions is empty)

All operator decisions are resolved into Frontloaded Decisions above
(FD-1 … FD-15), each restated in plain English in the ELI16 companion for
the operator to confirm or override at approval time. The items that
genuinely bend or postdate a June-13 decision are flagged as DEV-1 (rollout
lever vs "no break-glass"), DEV-6/FD-14 (The Agent Carries the Loop
collision), and FD-9 (advisory-first reply corroboration).

## Open questions

*(none)*

## History

| Date | Event |
|------|-------|
| 2026-06-13 | Design converged (3 rounds, 6 internal angles + GPT-5.5 + Gemini external passes) and operator-approved 13:59 PDT (topic 11960, "Approved"). |
| 2026-06-13 | Build session `Topic spam` reaped at max runtime (~16:02 PDT); worktree + converged spec artifact lost. Only the conversation survived. |
| 2026-07-09/10 | Operator returns to topic 11960 (fresh spam screenshot); urgent slice ships as PR #1417 (single-alerts-topic routing). Operator reaffirms the selectivity direction verbatim. |
| 2026-07-10 | This reconstruction authored against main v1.3.802 and committed to a branch at authoring time (the artifact-loss lesson applied); round-1 convergence findings folded (9 reviewers). |
| 2026-07-10 | Round-2 findings folded (8 reviewers + conformance gate): corrected raw-send census incl. `TelegramAdapter.send()`, deterministic opt-in confirmation citation, relay carrier + fresh holder classification, pinned coalesce/durability mechanics, split significant/routine push lanes + global ceiling, FD-7 apply-time revalidation, FD-15. |
| 2026-07-10 | Round 3 (confirmation): every round-2 fold verified genuine by all six internal reviewers + codex gpt-5.5 + gemini; ZERO material new findings — CONVERGED at iteration 3. Round-3 one-clause minors folded editorially (operator-bound confirmation citations, server-minted confirmation reply, relay-fallback closure condition + marker lint, significant-lane reservation in the global ceiling, sourceContext key caps + category-level coalesce, machine-qualified opt-in versions, grandfathered-category listing + disable-all, record-contract transitional shim, typed stamper factories, SQLite alternative recorded, census-echo fixes, ELI16 item 16). Awaiting fresh operator approval. |
