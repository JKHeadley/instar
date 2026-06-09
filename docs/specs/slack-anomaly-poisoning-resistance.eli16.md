# Slack Anomaly Baseline-Poisoning Resistance — Plain-English Overview

> The one-line version: we make it much harder for a bad actor to slowly "train" a person's behavior profile so that a later out-of-character request (like an urgent money transfer at 3am) sneaks past as normal.

## The problem in one breath

Instar's Slack permission system learns what each person *normally* does — what kinds of requests, at what hours, how long their messages are — and quietly notices when a new request feels off (this only watches and logs today; it never blocks). But a learned profile is itself a target: a patient attacker, or someone whose Slack account got compromised, could feed the system lots of normal-looking activity (or one big burst) to reshape that profile, so the suspicious request that comes later no longer looks suspicious. This change closes three ways that "training the profile" attack could work.

## What already exists

- **The behavioral baseline** — a small, privacy-respecting record per person of the *shape* of their requests (which action, which sensitivity tier, what hour, how long the message, whether it sounded urgent). It never stores the actual message text. It is fed only from real, directed requests, and it ships off by default.
- **The anomaly scorer** — reads that baseline and produces a 0-to-1 "this feels out of character" score with plain reasons, across five signals (out-of-character action, tier escalation, odd hour, sudden urgency, unusual message length). It is a *detector*: it raises a flag, it does not block anything.
- **The permission gate** — the one place that actually decides allow / refuse / step-up. The anomaly score can only ever ask it to *raise* the bar on a request that would otherwise be allowed; it can never lower a bar. The whole thing is observe-only right now (decisions are logged, not enforced) so we can measure how often it false-alarms before it's ever turned on.
- **The first poisoning fix (already shipped)** — the out-of-character signal now fires when an action is *rare* for a person, not only when it's literally never been seen — so seeding a single fake prior request can't switch that signal off.

## What this adds

Three more defenses, all additive and all still observe-only. The headline one: the scorer now looks at a person's history through **two lenses at once** — their whole-relationship history AND a recency-weighted "lately" view — and treats a request as anomalous if it looks off through *either* lens. This is deliberately a "can only add suspicion, never remove it" rule, so the new logic can never accidentally make a previously-flagged request look safe.

- **Recency weighting** so a recent flood of attacker activity can't permanently dominate the profile — and once the attacker stops and real activity resumes, the flood fades and the genuine profile re-asserts.
- **A minimum profile age** so a profile that was built up in a fast burst (lots of activity, but only over the last day or two) is *not* trusted as "established" yet.
- **A recording rate cap** so one session can't hammer thousands of fake observations into a profile to shift it.

## The new pieces

- **Time-bucketed history (in the baseline store)** — alongside the running totals it already kept, the store now also keeps the same counts sliced into rolling day-windows. This is what lets the scorer weight recent vs. old behavior, and lets the store enforce a per-day recording limit. It's an optional extra field: a profile saved by an older version (with no buckets) is read and scored exactly as before.
- **The decayed view (in the scorer)** — at scoring time, the scorer fades older day-buckets with a half-life (default ~30 days) and keeps any pre-existing "legacy" history at full weight, then compares the request against both this faded view and the full-history view, taking whichever is more suspicious.
- **The minimum-age check (in the scorer)** — a profile only counts as "established" when it has both enough interactions *and* enough calendar age behind it. A young-but-busy profile stays low-confidence, and the strongest signals stay switched off for it.
- **The rate cap (in the store)** — observations beyond the per-window limit are dropped and logged, never recorded. The dropped ones touch neither the totals nor the buckets, so the two always stay in lock-step.

## The safeguards

**Prevents a single big burst from re-shaping a profile.** The rate cap limits how many observations land per person per day-window; excess is dropped and logged. A counter-test in the suite proves the earlier "rare action" defense is actually defeated by an uncapped 100-observation burst, and that the cap is what keeps that burst small enough for the defense to keep working.

**Prevents a fast-built profile from being trusted.** The minimum-age requirement means an attacker can't manufacture a deep-looking profile in a day or two and then ride it; the high-value signals (out-of-character action, tier escalation, message-style) stay suppressed and confidence stays "low" until the profile has real calendar age.

**Prevents a recent flood from permanently winning.** Recency decay means a one-time poisoning burst is temporary: as it ages and genuine activity continues, its weight collapses and the real baseline comes back. And because every signal is judged on the more-suspicious of the full-history and recent views, a flood can't quietly erase the fact that an action is rare across the whole relationship.

**Keeps every existing guarantee.** Still shape-only (never message content), still observe-only/dark by default, still "anomaly can only raise the bar, never lower it." Existing saved profiles keep working unchanged, and nothing here can break the message path (recording is best-effort and swallows its own errors).

## What ships when

One change, one commit, behind the existing dark flag. There are no phases: the store changes, the scorer changes, the config wiring, the spec section (§7.7), and the tests all land together. The feature stays off (the anomaly scorer defaults to the no-op Null scorer) until an operator explicitly enables Pillar 3, and even then it only logs would-be step-ups until the false-positive rate is measured good. All three knobs (minimum age, rate cap, decay half-life) are config-overridable with conservative defaults, and each can be turned off individually for a clean fallback to the prior behavior.
