# Keystone dormancy — plain-English overview

## What this is

The apprenticeship program watches a recursive chain of mentorships: Echo
oversees Codey, Codey mentors Gemini. The *deepest* layer — the mentor actually
driving the mentee (the "keystone") — is the one that matters most, and the one
most likely to go quiet while the upper layers stay busy reviewing each other.

A signal shipped last change (`keystoneBalance`, PR #893) made that imbalance a
queryable fact. It reports `starved: true` when the program keeps *reviewing /
overseeing* but stops *driving the mentee*. That catches one failure shape: the
program is active but pointed at the wrong layer.

## The gap this closes

`starved` only fires when oversight cycles **pile up** without a mentee drive. If
the deepest layer simply goes **silent** — no cycles of any kind — nothing piles
up, so `oversightSinceKeystone` stays 0 and the signal reads **"healthy."**

That is exactly backwards. A keystone layer that hasn't driven the mentee in 24
hours is the *most* unhealthy state, and the old signal called it fine. We hit
this live: the registered `codey-to-gemini` instance reported healthy while its
last real mentee drive was about a day old.

## What's new

`keystoneBalance` gains a second, independent dimension: **dormancy**.

- `dormant: true` when the keystone fired before but its last drive is older than
  a threshold (default 6 hours, tunable per call).
- `lastKeystoneAgeMs` — how long since the last drive, in milliseconds.
- `dormancyThresholdMs` — the threshold actually applied.

`dormant` is **orthogonal** to `starved`. A layer can be:
- healthy (recent drive, little oversight since),
- starved (oversight piling up since the last drive),
- dormant (gone wall-clock silent),
- or both starved and dormant at once.

A future-dated timestamp (clock skew) clamps the age to 0, so it can never
manufacture false dormancy.

## What already exists vs. what changed

- **Already exists:** the `keystoneBalance` block, the `role-coverage` route, the
  `starved` signal, the `?oversightStarvationThreshold` tuning knob. None of that
  behavior changed.
- **New:** the three fields above, plus a `?keystoneDormancyMs` query knob to tune
  the dormancy threshold, plus the agent-awareness line in the CLAUDE.md template
  and the migration that carries it to already-installed agents.

## Safeguards, in plain terms

- **Observe-only.** This never blocks, gates, or changes any agent action. It only
  answers a question. If it is wrong, nothing breaks — a reader just sees a flag.
- **No data migration.** The only "migration" is one idempotent CLAUDE.md
  documentation line so existing agents know the `dormant` field exists.
- **Fully covered.** Unit tests pin both sides of the dormancy boundary, the
  orthogonality with `starved`, the never-fired and clock-skew edge cases; an
  integration test proves the route surfaces the fields and honors the new query
  knob; an e2e test exercises the dormant path through the real server.

## What you actually need to decide

Nothing is required of you to make this safe — it is observe-only and on by
default like the rest of `keystoneBalance`. The one judgment call worth a glance
is the **default dormancy threshold of 6 hours**: long enough not to fire during
a normal gap between mentee drives, short enough to catch a real stall. If you'd
prefer it tighter or looser fleet-wide, say so and I'll adjust the default;
per-call tuning via `?keystoneDormancyMs=N` already works regardless.
