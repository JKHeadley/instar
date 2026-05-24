# Upgrade Guide — topic-intent auto-capture loop (rung 0)

<!-- bump: minor -->
<!-- minor = new backward-compatible capability -->

## What Changed

**The topic-intent "cabinet" now fills itself from live conversation.**

The Topic-Intent Layer shipped a while back — a per-topic store of the facts
and decisions a conversation establishes, a session-start briefing that reads
from it, and an ArcCheck that guards against acting on shaky ground. But its
defining capability was inert: nothing ever read a real conversation turn and
filed anything. The store stayed empty, so the briefing rendered blank and
ArcCheck had nothing to gate against. This is exactly why the original
methodology-drift incident found "topic-intent had no record for the topic" —
the drift-catching machine was shipped but asleep.

This wires the capture loop so each substantive turn gets a cheap, fast-tier
"anything worth filing here?" read, with **broader context** — the topic's
already-established refs plus a rolling summary — so the extractor judges
significance against what the conversation is actually about, not one line in
isolation.

Built in:

- **A deterministic, fail-open pre-filter** so trivial turns (empty, bare
  "ok"/"thanks", agent status/heartbeat lines) never reach the model. Registered
  as a state-detector with a canary (`docs/specs/06-state-detector-registry.md`)
  that guards against sentinel-format drift silently dropping real captures.
- **Cost controls**: every extraction is admitted through the shared LlmQueue on
  the background lane (yields to interactive work, shares the daily cap), runs on
  the subscription transport (never the raw paid API), is bounded by a per-topic
  rate ceiling, and backs off under quota pressure. Fire-and-forget, so capture
  latency can never slow a message reaching you.
- **Prompt-injection hardening**: prior notes and the rolling summary are fed
  back to the model only inside delimited untrusted-data blocks, truncated to
  hard caps.
- **Concurrency-safe writes**: the store's append path holds a per-topic lock so
  two sessions capturing the same topic can't drop each other's events.
- **Whole-loop observability** (`GET /topic-intent/:id/capture-metrics`): the
  funnel of captured → surfaced → used → corrected — turns seen, pre-filter
  skips, extractions, refs created, briefing served (and refs carried), ArcCheck
  fired/signalled, refs decayed. Paired with the human-as-detector heat map
  (what we MISSED), this is the read for tuning effectiveness over time.

ON by default (ratified), with a kill-switch: `topicIntent.capture.enabled:
false`. Existing agents get the default on update.

**Evidence**: 30 new tests across all three tiers (20 unit, 6 integration,
4 e2e) plus the pre-existing 13 — 138 topic-intent tests green. The e2e
wiring-integrity test fires a real inbound turn through the live
`onMessageLogged` callback and asserts a ref lands in the store and the briefing
goes non-empty (the anti-"shipped-but-asleep" guard), and that the extraction
went through the queue's background lane on the injected provider, never a raw
API client. `tsc` + lint clean.

Spec: `docs/specs/topic-intent-capture-loop.md` (converged iter 3, approved).
ELI16: `docs/specs/topic-intent-capture-loop.eli16.md`.
Side-effects review: `upgrades/side-effects/topic-intent-capture-loop.md`.

## What to Tell Your User

I now quietly remember the facts and decisions from our conversations, so when
we pick a topic back up I already know where we left off — instead of you having
to remind me.
