# Phase 5c — Cost-Aware Routing, in plain English

**Companion to:** `11-cost-aware-routing.md`
**Audience:** Justin (and any future reader who wants the shape before the details)
**Length target:** 5 minutes

---

## The one-line version

When Instar runs Anthropic work, this layer decides whether to spend prepaid SDK credit (cheap, drains a pot) or your subscription (always available, slower-but-unbounded). It picks for you. No prompts.

---

## Why this exists separately from Phase 5b

Phase 5b is the asking part — "about to run with X, OK?" Phase 5c is the math under it — "given the current credit pot state, which adapter should we actually call?"

Splitting them means the math is testable in isolation (pure inputs → pure outputs, no Telegram) and the UX can swap without rewriting the routing.

---

## The decision rule

Two Anthropic adapters can do most of the work:

- **The SDK adapter** uses your prepaid $200/month credit pot (introduced 2026-06-15). Cheap-feeling because it's already paid for. Once the pot runs out, it stops.
- **The subscription adapter** uses your Max subscription via a long-running Claude Code session. Always available. Subject to per-session limits, but never bills extra.

The rule is simple:

> While the SDK pot has more than 10% of the month's total left, route work through the SDK adapter. Once it drops to 10% or less, switch routine work to the subscription adapter and preserve the rest of the pot for cases that genuinely need it.

The 10% is the **safety margin**. It's tunable but defaults to 10% per the path-constraints spec.

---

## What happens in the edge cases

- **Both adapters available, pot healthy** → SDK adapter (drain-first).
- **Both available, pot near empty (≤ 10%)** → subscription adapter (preserve headroom).
- **Both available, pot state unknown** (the API call failed, or just booted) → subscription adapter (conservative — don't bet against unknown state).
- **Only one adapter in the running** → use it.
- **Neither Anthropic adapter applies** (the task is for Codex or another non-Anthropic provider) → defer to the next layer of routing.

There's no scenario in which Phase 5c picks the raw Anthropic API. That's banned by Rule 2 of the path constraints.

---

## What "material shift" means

Phase 5b needs to know: "since the user last said 'yes, use X for this kind of task,' has anything changed enough that we should re-ask?" Phase 5c answers that via the **CostStateTracker**.

A shift counts as material when ONE of these is true:

1. **The pot crossed the safety margin.** Cached pick assumed plenty of credit; now we're below the line. Or the reverse — pot reset to a new billing period.
2. **The pot dropped by more than 25% of the month's total since the cached pick.** Even if both sides of the comparison stay above the 10% margin, a 25% drop is big enough that the user should know.
3. **The observability state itself changed.** We had data, now we don't (provider went away). Or we didn't, now we do (state newly available).

Smaller drift while staying above margin is NOT material. The whole point is to keep prompts rare — false positives are how you train someone to ignore real ones.

---

## What changes for you

Until Phase 5b is implemented, nothing. The routing math lands now (so it's testable and stable), but the UX that consumes it is the next phase.

Once Phase 5b is implemented:

- The routing decision is invisible to you most of the time — Instar just picks correctly.
- The first time Instar picks for a new task pattern, you'll get a single Telegram message asking. After that it remembers.
- If the pot crosses the safety margin or drops a lot, Instar re-asks for tasks that hit it. This is the surface that protects you from silent drift.

---

## What I need from you

Nothing. Phase 5c builds in isolation. Locked default behavior:

- Safety margin: 10% of monthly pot (per path-constraints spec).
- Material drift threshold: 25% of monthly pot (new, this spec).
- Unknown-state fallback: subscription adapter (conservative).

If you want different defaults later, they're constructor options — easy to flip without rewriting the policy.
