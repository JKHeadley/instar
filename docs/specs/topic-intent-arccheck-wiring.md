---
slug: topic-intent-arccheck-wiring
title: Wire ArcCheck (Layer 3) — classifier + outbound integration
author: echo
project: continuous-working-awareness
review-convergence: "2026-05-28T04:01:05.103Z"
review-iterations: 2
review-completed-at: "2026-05-28T04:01:05.103Z"
review-report: "self-review + standards-conformance gate (22/22 clean)"
approved: true
approved-by: justin
approved-at: "2026-05-28T04:13:21Z"
eli16-overview: topic-intent-arccheck-wiring.eli16.md
---

# Wire ArcCheck — the dead surfacing layer

## Problem statement

The Topic-Intent Layer is shipped end-to-end through Layer 1 (capture, rung 0,
v1.2.62) and Layer 2 (briefing, mounted at session-start). The store fills with
real refs from live conversation: at the time of writing, topic 13481 holds **81
refs** (32 settled / 150 tentative shown in briefing), built from 258 turns.

But **Layer 3 (ArcCheck) is the dead surfacing layer**, in two places:

1. **The classifier is never wired.** `src/server/AgentServer.ts:552` constructs
   `createTopicIntentRoutes({ topicIntentStore })` — `arcCheckClassify` is not
   passed. The route at `src/server/topicIntentRoutes.ts:57` then does
   `const arcCheck = store && deps.arcCheckClassify ? new ArcCheck(...) : null;`
   and at `:240` returns
   `{ fire: false, reason: 'arccheck classifier not configured (degrade-open)' }`.
   So the endpoint exists but is permanently inert.
2. **No production caller invokes the endpoint.** A repo-wide grep for
   `arccheck` outside ArcCheck's own files, tests, and metering counters
   returns zero hits. Even if the classifier were wired, the outbound path
   never asks it anything.

**Live evidence.** Across every topic probed, `arccheck_fired = 0`. On topic
13481 that's 0 fires across 258 turns with 81 refs in the store. The
ArcCheckEffect column of `capture-metrics` is meterable but always zero
because the gate never runs.

**Why this matters — the founding drift incident.** In topic 13481 the agent
asked "what do you need from me?" and replied with "eventually a second
machine for the cross-machine seamlessness test." The briefing's SETTLED tier
already contained: *"The multi-machine Luna infrastructure is ready to proceed
— SSH connectivity to the mac-mini (192.168.87.38) is already configured…"*
and tentative refs about *"start on Justin's own machines (user's machine +
one mac-mini)"*. The data was present; nothing checked the draft against it.
That is the exact verdict ArcCheck's
`contradicts-settled` was designed to emit
(`src/core/TopicIntentArcCheck.ts:42-53`).

The capture-loop spec already shipped `arccheck_fired` / `arccheck_signalled`
counters in the `capture-metrics` funnel for this purpose — they exist on
disk, named, waiting for a real signal source. This spec is what makes them
non-zero.

This is the textbook *shipped-but-asleep* (`[[feedback_verify_component_actually_wired]]`)
pattern, one layer up from the capture-loop fix.

## Proposed design

### 1. Build the production `arcCheckClassify` function

- **`createArcCheckClassifyFn(intelligence, enqueue): ArcCheckClassifyFn`** —
  new export in `src/core/TopicIntentArcCheck.ts`. Mirrors
  `createLlmExtractFn` from the capture-loop build: builds the ArcCheck
  prompt via `buildArcCheckPrompt`, calls
  `intelligence.evaluate({ model: 'fast' })`, parses with
  `parseArcCheckResponse`. Unit-tested.
- **Degrade-safe.** No intelligence → return `{ actsOn: [], contradicts: [] }`
  (the route turns this into `fire: false`). Throws / timeouts → same. The
  classifier *never* propagates an error to its caller. ArcCheck failures
  must never block an outbound message.
- **Transport — NON-NEGOTIABLE.** The `intelligence` arg MUST resolve to the
  subscription / REPL-pool-backed provider, never raw Messages API. This
  is the second always-on per-turn LLM path (capture being the first); a
  raw-API regression here drains real money on every outbound draft.
  Acceptance includes a transport assertion test.
- **Queued.** Every classification is enqueued on `sharedLlmQueue` (background
  lane → yields to interactive work, respects the daily cap). On cap breach
  the classifier degrades silently (same shape as no-intelligence).

### 2. Construct one ArcCheck instance; share between route and in-process caller

In `src/commands/server.ts`, alongside the capture-loop construction block
(~`server.ts:5892-5943`), build a single `ArcCheck` instance:

```ts
const arcCheckClassify = createArcCheckClassifyFn(queuedIntelligence);
const topicIntentArcCheck = new ArcCheck(topicIntentStore, arcCheckClassify);
```

Gated on `sharedIntelligence && (config.topicIntent?.arccheck?.enabled ?? true)`.
Reuses the same `queuedIntelligence` the capture loop already built, so we
inherit the LlmQueue lane and daily cap behaviour for free.

Pass `topicIntentArcCheck` through `AgentServer` so both surfaces use the
same instance:

- **HTTP route** — extend `AgentServerOptions` with
  `topicIntentArcCheck?: ArcCheck | null`. `createTopicIntentRoutes` is
  reshaped to accept the instance directly:
  `createTopicIntentRoutes({ topicIntentStore, arcCheck })`. (Today it
  takes a classifier function; this is a small refactor since the function
  was only used to construct an `ArcCheck` inside the route — the route
  doesn't care which side built the instance.)
- **In-process caller** — expose the same instance on the routes `ctx` so
  `checkOutboundMessage` can call it directly (see §3).

### 3. Plug into the outbound path via `MessagingToneGate` — in-process

`src/core/MessagingToneGate.ts` is the existing single authority for
outbound user messages and already accepts upstream `ToneReviewSignals` from
detectors (e.g. `JargonDetector`, the outbound-dedup detector via
`signals.duplicate`). The ArcCheck header at
`src/core/TopicIntentArcCheck.ts:20-22` explicitly names this gate as its
integration point.

**Integration seam (verified).** The single fan-in is
`checkOutboundMessage` in `src/server/routes.ts:934-1007`. It already
receives `options.topicId`, builds a `ToneReviewSignals` object from
upstream detectors (junk, jargon, duplicate), and passes it to
`messagingToneGate.review(text, { signals, ... })`. ArcCheck plugs in here
as one more signal collector, exactly mirroring the dedup pattern at
`routes.ts:987-998`.

Design:

- **New signal channel** on `ToneReviewSignals`:
  `arcCheck?: { fire: boolean; kind?: 'acting-on-tentative' | 'contradicts-settled'; refText?: string; suggestedRewriteHint?: string }`.
- **In-process invocation — not HTTP self-call.** The tone-gate runs
  in-process at `routes.ts:1001`. We pass an `ArcCheck` instance on `ctx`
  (e.g. `ctx.topicIntentArcCheck: ArcCheck | null`) and call
  `ctx.topicIntentArcCheck?.check({ topicId, draftText: text })` directly.
  An HTTP self-call would serialize/deserialize the payload, double the
  latency budget, and add a fail path; in-process is the obvious right
  shape now that we know the seam. The HTTP `/topic-intent/:topicId/arccheck`
  endpoint stays — same `ArcCheck` instance behind it — for tests and
  out-of-process callers, but production goes direct.
- **Caller orchestration.** Wrap the in-process call in a hard timeout
  (200ms; tunable via config). Run **concurrent with** the rest of the
  signal gathering — when the result lands in time, merge into
  `signals.arcCheck`; when it times out or throws, the gate proceeds
  without the signal (same shape as `try { ... } catch { /* skip */ }`
  around the dedup detector at `routes.ts:987-998`). `feedback_gate_latency_vs_client_timeout`
  is preserved: no serial extra LLM call on the hot path.
- **Authority.** ArcCheck is **signal only**. The tone gate consumes the
  signal and *may* fold ArcCheck's rewrite hint into its rewrite plan via
  `renderSignals`; it never converts a fire into a hard block. The
  two-layer split from `feedback_signal_vs_authority` is preserved
  verbatim: ArcCheck = brittle/low-context filter emitting a signal, the
  tone gate retains blocking authority.

### 4. Metering — bring `capture-metrics` to life

The route already increments `arccheck_fired` / `arccheck_signalled` on
every call (`src/server/topicIntentRoutes.ts:244-260`). Once §3 lands these
counters become non-zero and the `capture-metrics` funnel finally measures
the FULL surfacing pipeline (captured → surfaced → used → corrected). No
new counter work in this spec.

### 5. Config kill switch + migration parity

- Add `topicIntent.arccheck.enabled` (default `true`) via `migrateConfig`
  existence-check in `PostUpdateMigrator`. Existing agents pick it up on
  next update.
- All wiring is server-side. No `.claude/settings.json`, hook, template, or
  skill change. No agent-installed file touched.

## Lessons carried

From the capture-loop build: best-effort never-throws into the outbound
path; fire-and-forget/non-blocking; degrade-safe; **wiring-integrity test is
NON-NEGOTIABLE** (prove the classifier reaches the route, prove the route
runs, prove the tone gate consumes the signal). Signal-vs-authority is the
*defining* property here — ArcCheck must never block.

## Testing (all three tiers + wiring integrity + transport)

- **Tier 1 (unit):**
  - `createArcCheckClassifyFn` parses, degrades on throw, degrades on
    `intelligence: undefined`.
  - `buildArcCheckPrompt` renders refs as delimited untrusted-data blocks
    (re-uses the capture-loop hardening pattern — refs may contain user
    text → prompt-injection class).
  - The classifier respects the LlmQueue cap (degrade on `enqueue` throw).
- **Tier 2 (integration):**
  - With the classifier wired, `POST /topic-intent/:topicId/arccheck` on
    a draft + a topic that has matching refs returns `fire: true` with
    the right verdict and rewrite hint.
  - `arccheck_fired` increments; `arccheck_signalled` increments when
    `fire: true`.
  - The tone gate consumes the merged `signals.arcCheck` and includes the
    rewrite hint in its review prompt (verifiable by `renderSignals`
    output).
  - In-process path: posting an outbound message through the route at
    `checkOutboundMessage` invokes `ctx.topicIntentArcCheck.check` (spy)
    when `topicId` and `topicIntentArcCheck` are both present, skips
    cleanly when either is missing.
  - Timeout path: when ArcCheck takes longer than the hard timeout, the
    gate proceeds without the signal — same behaviour as a thrown detector.
- **Tier 3 (e2e — the founding-drift fixture):**
  - Boot the real init path. Seed a topic with one SETTLED ref:
    *"The mac-mini (192.168.87.38) is already configured and SSH-reachable."*
  - Submit an outbound draft: *"We need a second machine for the
    cross-machine seamlessness test."*
  - Assert: the ArcCheck endpoint returns
    `{ fire: true, kind: 'contradicts-settled', refId: ..., suggestedRewriteHint: ... }`.
  - Assert: the tone-gate review receives the signal (renderSignals
    output contains the ArcCheck block).
  - Assert: message delivery still completes (signal-only — no block).
  - This is the regression pin against the original drift. Re-rerunning
    this test catches any future de-wiring of ArcCheck.
- **Wiring integrity:**
  - Boot path constructs `arcCheckClassify` when
    `sharedIntelligence && topicIntent.arccheck.enabled`.
  - AgentServer receives it and passes it to `createTopicIntentRoutes`.
  - Route's `arcCheck` is non-null. (Anti-shipped-but-asleep guard.)
- **Transport:**
  - The classification's `intelligence` is the subscription/REPL-pool
    path, not raw API (asserted on the live wiring).

## Acceptance criteria

1. After this ships, `arccheck_fired` is non-zero on any topic that gets
   outbound traffic with refs in the store.
2. The mac-mini-drift e2e fires `contradicts-settled` deterministically.
3. ArcCheck never blocks an outbound message. The tone gate retains all
   authority.
4. With no intelligence provider OR the kill switch off, ArcCheck is a
   silent no-op (no errors, no extra latency).
5. ArcCheck calls go through subscription/REPL-pool transport (asserted),
   never raw API.
6. The tone gate's `signals.arcCheck` is folded into its review prompt
   when set, omitted when not — verifiable in `renderSignals`.
7. All three test tiers + wiring-integrity + transport tests green;
   `tsc` + `lint` clean.

## Risk and rollback

Medium-low. Additive (a classifier function + one route arg + one signal
channel on an existing review pipeline). The hardest property to preserve
is the never-block guarantee on the outbound path — addressed in §3
(fire-and-forget, hard timeout, signal-only). Worst case on a logic bug:
extra/missing signals into the tone gate (a diagnostic surface), never a
delivery failure. Rollback: flip
`topicIntent.arccheck.enabled = false`; classifier construction is gated.
Code rollback: remove the AgentServer wire, the classifier creator, and
the signal channel; everything else is dead code as today.

## Migration parity

Server-side only (every agent picks it up on next update). One new config
default (`topicIntent.arccheck.enabled = true`) added via `migrateConfig`
existence-check. No hook/template/skill change. No PostUpdateMigrator
surgery beyond the config default.

## Scope — outbound-tone seam first, deliberate

v1 plugs ArcCheck into the existing `MessagingToneGate` outbound seam
(the single authority documented in the capture-loop spec and in
`feedback_signal_vs_authority`). Wiring ArcCheck into the
session-start briefing refresh, into mid-task re-injection, or into the
response-review stop-hook pipeline are tracked refinements
<!-- tracked: arccheck-additional-seams -->, not v1. They share the
classifier built here and add zero new LLM load if not wired.

## Out of scope (and why)

- **Mid-session briefing refresh.** The briefing today is fetched at
  session-start only (`briefing_served = 3` against 258 turns on topic
  13481). Adding mid-session refresh is its own design problem (when to
  refresh, against what budget, how to merge with existing context).
  Tracked as `cwa-mid-session-briefing-refresh`. ArcCheck is the
  higher-leverage move first — it catches drift at the moment of the
  draft, regardless of whether the briefing has aged.
- **Extraction failure rate (47% `cap_or_error` on topic 13481).** Side
  finding from the audit; tracked as `cwa-extraction-failure-rate-audit`.
  Affects how *much* gets into the store but doesn't change the wiring
  shape ArcCheck needs.
