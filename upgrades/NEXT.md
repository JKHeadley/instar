# Upgrade Guide — vNEXT

<!-- bump: minor -->

## What Changed

**Topic-Intent ArcCheck (Layer 3) is now wired.** The agent has a three-layer
"topical memory": Layer 1 *captures* what each conversation is about, Layer 2
*briefs* the agent at session start, and Layer 3 — **ArcCheck** — was meant to
scan an outbound draft against what the topic already decided and wave a flag
when the draft contradicts a settled fact, drifts from the active task frame,
or acts on something not yet confirmed. Layers 1 and 2 shipped and run live.
**Layer 3 was built but never connected** in two places: the
`/topic-intent/:topicId/arccheck` route was constructed without a classifier
(so it always returned a degrade-open no-fire verdict), and nothing on the
outbound path ever called it.

Live evidence the gap was real: `arccheck_fired = 0` on every topic, including
one with 258 turns and 81 tracked refs. The motivating incident — the agent
saying "we need a second machine" while a *settled* ref already recorded that
the machine was configured and reachable — is the exact `contradicts-settled`
verdict ArcCheck exists to emit, and it stayed silent.

This change builds the production classifier (`createArcCheckClassifyFn`,
mirroring the capture loop's `createLlmExtractFn` — degrade-safe, subscription
transport, queued), constructs one shared `ArcCheck` instance at server start,
and plugs its verdict into the existing `MessagingToneGate` outbound path as
one more upstream signal alongside junk/jargon/duplicate. The call is
in-process, concurrent-eligible, bounded by a 200ms hard timeout, and
**signal-only** — it never blocks a message; the tone gate keeps all block
authority and may fold ArcCheck's rewrite hint into its review. New config
kill switch `topicIntent.arccheck.enabled` (default true).

## What to Tell Your User

- A safety net that was built but unplugged is now connected: before I send a
  reply, I quietly check it against what we already settled in this
  conversation. If my draft would contradict a decided fact (e.g. I say "we
  need a machine" when we already agreed one is set up), the existing
  message-review step now sees a flag and can catch it — instead of nothing.
- Nothing you see changes by default and nothing gets blocked by this on its
  own — it's a signal into the review I already run, not a new gate. There's a
  config switch to turn it off if ever needed.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| ArcCheck pre-send classifier | Automatic — runs in-process on outbound messages when a topic has tracked refs; emits a signal to the tone gate, never blocks |
| `arccheck_fired` / `arccheck_signalled` metrics now live | `GET /topic-intent/:topicId/capture-metrics` — these counters finally become non-zero |
| Kill switch | `.instar/config.json` → `topicIntent.arccheck.enabled: false` (default true; route stays mounted, classifier goes dark) |

## Evidence

- **Regression pin (the founding incident as a test):** new e2e
  `tests/e2e/topic-intent-arccheck-lifecycle.test.ts` seeds a topic with a
  SETTLED "the mac-mini is already configured" ref, posts the "we need a
  second machine" draft, and asserts ArcCheck fires `contradicts-settled` with
  the right ref + rewrite hint, that `arccheck_fired`/`arccheck_signalled`
  both increment, and that delivery still completes (signal-only). Re-running
  it catches any future de-wiring.
- **Wiring-integrity source guards** assert server.ts constructs the ArcCheck
  instance (`__instarTopicIntentArcCheckWired`), AgentServer forwards it to the
  route, the route accepts an instance, and `checkOutboundMessage` reads
  `ctx.topicIntentArcCheck` into `signals.arcCheck`.
- **Degrade-safety units:** `createArcCheckClassifyFn` returns an empty
  classification (→ no fire) on no-intelligence and on provider throw, and uses
  the subscription transport (asserted attribution), never raw API.
- **Signal-only proof:** MessagingToneGate renders the ArcCheck block only when
  `fire === true` and gains no new block rule — verified by unit tests.
- **Side-effects review:** `upgrades/side-effects/topic-intent-arccheck-wiring.md`.
