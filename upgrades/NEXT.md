# Upgrade Guide — tunable topic-intent decay horizons

<!-- bump: minor -->
<!-- minor = new features, new APIs, new capabilities (backwards-compatible) -->

## What Changed

**You can now tune how fast each kind of memory fades, from config.**

Rung 1 gave topic-intent memories different "shelf lives" — a method ("we're
testing over Telegram") fades in about a week, an audience in about a month,
facts and decisions over months. Those numbers were code constants. This ships
the tracked `cwa-decay-profile-config` follow-up: they're now overridable via
config, so we can tune them from real data without a code change.

`topicIntent.capture.decayProfiles` takes any subset of refkinds
(method/audience/goal/fact/decision) and any subset of `{graceDays, halfLifeDays}`;
anything you don't specify keeps the built-in default. Invalid values (zero,
negative, non-finite) are ignored — a bad config can never break decay; it just
falls back to the default. Set nothing and behavior is exactly as before.

Example: slow down how fast a "method" frame fades —
`{"topicIntent":{"capture":{"decayProfiles":{"method":{"halfLifeDays":21}}}}}`.

**Evidence**: 6 unit tests (defaults, partial override, invalid-ignored,
idempotent, reset, and that an override actually changes projected decay). The
rung-0/rung-1 decay math is unchanged when no override is set (existing
projection tests green). `tsc` + lint clean.

Spec: `docs/specs/topic-intent-task-context-capture.md` §3 (the
`cwa-decay-profile-config` tracked deferral, now shipped). Side-effects:
`upgrades/side-effects/cwa-decay-profile-config.md`.

## What to Tell Your User

- **Tune memory shelf-lives**: "How fast I forget different kinds of context is
  now adjustable in config — if a 'how we're working' note fades too fast or
  sticks too long, we can dial it without changing code."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Override topic-intent decay horizons | `topicIntent.capture.decayProfiles.<kind>.{graceDays,halfLifeDays}` in `.instar/config.json` (optional; omitted → defaults) |

## Evidence

Not a bug fix — a tuning knob over the rung-1 decay model. Verified by 6 unit
tests including one that confirms an override actually changes projected decay
(a method ref barely decays by day 8 under a long-horizon override vs. ~halving
under the default). No-override behavior is byte-for-byte the prior defaults.
`tsc` + lint clean.
