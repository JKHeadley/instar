# Upgrade Guide — task-context capture (rung 1 of continuous-working-awareness)

<!-- bump: minor -->
<!-- minor = new features, new APIs, new capabilities (backwards-compatible) -->

## What Changed

**I now remember *how we're working*, not just *what we said*.**

Rung 0 (shipped in v1.2.62) taught the topic-intent loop to remember the facts
and decisions a conversation establishes. But the failure that started this whole
project wasn't a forgotten fact — it was a forgotten **task frame**: losing track
that *"we're testing this over Telegram"* mid-campaign. That's not a fact the
conversation states; it's the setup the work is operating inside, and rung 0
structurally couldn't catch it.

Rung 1 generalizes capture to **task contexts** — `method` (how we're working),
`audience` (who it's for), and `goal` (what this task is trying to do) — written
into the *same* store, captured by the *same* per-turn read (no extra LLM cost),
and surfaced at the *same* places:

- **Per-kind decay horizons** make the short/medium/long "shelf life" idea real.
  A method ("testing over Telegram") fades in about a week; an audience persists
  about a month; facts and decisions keep their long (180-day) horizon **exactly
  unchanged**. Decay is demotion, not deletion — a faded frame re-warms the moment
  it's referenced again.
- **An "Active task frame" briefing block** so a fresh session opens already
  knowing the working frame without anyone re-stating it.
- **An ArcCheck frame-drift signal** (`contradicts-frame`): if a pre-send draft
  drifts from the active method/audience/goal, ArcCheck surfaces a gentle "this
  seems to move off how we said we're working — confirm?" It fires even when the
  frame is only tentative (frames are exactly the thing worth catching early) and
  it is a **signal, never a block**.
- **Per-kind observability** in `capture-metrics` (`refkind_created`) so frame
  capture is measurable and the decay horizons are tunable from real data.

ON by default with the same kill-switch as rung 0 (`topicIntent.capture.enabled`).

**Evidence**: 17 new tests across all three tiers (10 unit, 3 integration, 4 e2e)
— 271 topic-intent + capability/config/route tests green; `tsc` + lint clean. The
Tier-3 e2e **reproduces the founding methodology-drift incident**: a turn sets the
frame ("testing over Telegram"), the loop files it as a `method` ref, the briefing
carries it, and ArcCheck signals when a later draft drifts to "verify by reading
the code locally." A regression test pins fact/decision confidence math as
byte-for-byte unchanged. Notably, that e2e *caught a real gap during the build* —
frame contradictions needed to fire at tentative tier, which the original
authoritative-only rule missed — which is precisely why the founding-incident e2e
exists.

Spec: `docs/specs/topic-intent-task-context-capture.md` (approved; Claude-authored
+ manual review — full multi-model convergence tooling absent on the build host,
caveat ratified explicitly). ELI16:
`docs/specs/topic-intent-task-context-capture.eli16.md`. Side-effects review:
`upgrades/side-effects/topic-intent-task-context-capture.md`.

## What to Tell Your User

- **Working-frame memory**: "I now hold onto *how* we're working on something —
  like 'we're testing this over Telegram' — not just the facts we agree on. So if
  I start to drift off the way we set things up, I'll catch it and check with you
  instead of quietly wandering off."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Task-context capture (method/audience/goal) | Automatic (same loop as rung 0; kill-switch `topicIntent.capture.enabled`) |
| Per-kind decay horizons | Automatic — frames fade faster than facts |
| Active-task-frame briefing block | Automatic at session start |
| ArcCheck frame-drift signal | `POST /topic-intent/:topicId/arccheck` (signal, never blocks) |
| Per-kind capture breakdown | `GET /topic-intent/:topicId/capture-metrics` → `funnel.refkind_created` |

## Evidence

Not a bug fix — a new capability built on rung 0. Verified end-to-end (not
unit-mocked) by the Tier-3 e2e that reproduces and catches the founding
methodology-drift incident: frame set → `method` ref filed → briefing carries the
"ACTIVE TASK FRAME" block → ArcCheck signals on a drifting draft. Rung-0
confidence math is pinned unchanged by a dedicated regression test. 271 tests
green; `tsc` + lint clean.
