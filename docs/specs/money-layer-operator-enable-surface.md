---
title: "Routing Spend — an operator surface for the money-layer master switch"
slug: "money-layer-operator-enable-surface"
author: "echo"
status: "draft"
parent-principle: "Mobile-Complete Operator Actions — A PIN-Gated Route With No Human Surface Is An Incomplete Feature"
approved: false
---

# Routing Spend — an operator surface for the money-layer master switch

## Problem statement

Increment B of the Routing Control Room shipped the full paid-door arming flow: a caps
form, a canonical server-rendered plan, a PIN commit, a freeze control, and a change
log (`POST /routing-spend/plan`, `/routing-spend/caps/adjust`, `/routing-spend/freeze`,
`GET /routing-spend/caps/log`), with a dashboard Spend tab rendering them.

Every one of those routes is gated on `routingSpend.money.enabled === true`
(`routes.ts`, `moneyOn()`), which per **FD-16** is a documented `DARK_GATE_EXCLUSIONS`
action-bearing case — an explicit operator enable that deliberately does **not** ride
the dev-agent gate.

There is no way for the operator to perform that explicit enable.

- The dashboard has no control for it — the Spend tab's arming UI sits *behind* the
  switch, so the operator only ever sees the disabled state.
- `PATCH /config` cannot set it: `routingSpend` is not in `PATCHABLE_CONFIG_KEYS`, and
  that exclusion is deliberate and load-bearing (`RoutingSpendCapsStore.ts` documents
  it: a Bearer token must never reach money state).
- No CLI command sets it.

So the only path is hand-editing `.instar/config.json` on the machine, at a
filesystem the operator may not have in front of them. The operator's report was
exactly this: *"still has no path/mechanism to enable any options."*

This is a direct violation of the **Mobile-Complete Operator Actions** standard, which
the routing-spend spec itself invokes elsewhere: *a PIN-gated or approval-class route
with no human surface is an incomplete feature, not a finished API.* The arming screen
is reachable-but-unreachable — correct, signed, audited, and unusable.

### Why this is not simply "add routingSpend to PATCHABLE_CONFIG_KEYS"

That would be the smallest diff and it is the wrong fix. `PATCHABLE_CONFIG_KEYS` is
Bearer-authorized, and the Bearer token is held by the agent. Adding `routingSpend`
there would let the agent switch on its own spending authority — collapsing exactly
the requester ≠ authorizer separation the money layer exists to preserve. The
exclusion is a safety property, not an oversight, and this spec must not weaken it.

## What this proposes

A PIN-gated enable/disable action for the money layer, reusing the plan-then-commit
machinery Increment B already ships, plus the dashboard control that makes it
reachable from a phone.

### The action

Two new plan actions on the existing endpoints, not new endpoints:

- `POST /routing-spend/plan` accepts `action: "money-layer-enable"` and
  `action: "money-layer-disable"`, rendering the canonical plan text the operator
  reads before approving.
- A commit route applies it **only** from a rendered plan id + nonce, PIN-gated,
  exactly as `caps/adjust` does today. A field the operator never saw rendered cannot
  land.

The enable state must live **outside** `.instar/config.json`'s patchable surface. Two
candidates, and this spec must pick one before build:

1. **In the existing `RoutingSpendCapsStore`** — already outside `PATCHABLE_CONFIG_KEYS`,
   already PIN-authored, already audited by `caps/log`. `moneyOn()` becomes
   "config says true **or** the store's operator-enabled flag is set".
2. **A dedicated store.** Cleaner separation, one more file to keep coherent.

Option 1 is the current recommendation: it reuses a store whose write-discipline is
already money-grade, and it keeps the whole money authority answerable from one audit
log. The config key remains honored so no existing install changes behavior.

### The surface

The Spend tab renders the switch as its own block, above the per-door arming UI, in the
disabled state — so an operator who opens the tab sees *the thing they came to do*
rather than an explanation of why the page is empty. Enabling reveals the existing
arming flow unchanged. Disabling is the quieter, secondary action.

### What it deliberately does NOT do

- **It does not arm any door.** Enabling the layer changes no door's `goLiveState`;
  every door stays `not-live` with `$0` committed until separately armed with the PIN.
  The enable is permission to *use* the arming flow, never a grant of spend.
- **It does not give the agent authority.** The Bearer token can render a plan; only
  the PIN can commit one. `POST /routing-spend/freeze` stays Bearer, because halting
  money must always be cheap — that asymmetry is preserved exactly.
- **It does not change `PATCHABLE_CONFIG_KEYS`.**

## Open decision — the operator's monthly intent

Separately reported by the operator: they want "$100/month". The cap model has a
**lifetime total** and a **daily rate**, and no calendar-month concept. The three
honest options, none of which is free:

1. **Daily-rate approximation** (~$3.30/day): no code change; does not stop a heavy
   fortnight followed by a quiet one, and never sums to a month.
2. **Lifetime as a pot** ($100, topped up): a genuine hard ceiling; requires the
   operator to remember to refill, and a forgotten refill is a silent outage.
3. **A real monthly cap**: a new cap dimension through the ledger, the gate, the plan
   renderer and the caps view. Correct, and the largest change of the three.

This spec does not decide it — the choice is the operator's and it is tracked
separately (CMT-2024). Option 3, if chosen, is its own spec.

## Decision points touched

- **Adds** two plan actions and one PIN-gated commit route to the existing money
  authority; the state lands OUTSIDE `PATCHABLE_CONFIG_KEYS`, in a store whose only
  writer is a PIN-committed rendered plan.
- **Modifies** `moneyOn()` to read the operator-set flag in addition to the config key
  — additive, so an install that sets the config key today is unaffected.
- **Does not touch** the metered call gate, the ledger, per-door arming, or the freeze
  asymmetry.

## Risks

- **The obvious one: this makes real spending easier to switch on.** Mitigated by
  keeping the enable PIN-gated and plan-bound, by leaving every door disarmed on
  enable, and by leaving freeze Bearer-cheap. The alternative — leaving it unreachable
  — has its own failure mode, which is the operator hand-editing a JSON file on a
  money-bearing config while reading instructions off a phone.
- **Two sources of truth for one flag** (config key + store) if option 1 is taken.
  Mitigated by making the store authoritative when present and the config key a
  documented legacy input, and by surfacing both in `GET /routing-spend/caps`.

## Status

Draft, authored 2026-08-16 against live state on the operator's laptop
(`routingSpend.money` absent from config; `/routing-spend/plan` returning 503;
`routingSpend` verified absent from `PATCHABLE_CONFIG_KEYS`). Not converged, not
approved — this is a proposal for the operator, and the money layer's own rules mean
no code lands against it until it is both.
