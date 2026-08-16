---
title: "Routing Spend — an operator surface for the money-layer master switch"
slug: "money-layer-operator-enable-surface"
author: "echo"
status: "draft"
parent-principle: "Mobile-Complete Operator Actions — A PIN-Gated Route With No Human Surface Is An Incomplete Feature"
approved: true
approved-by: "operator (Justin), conversational approval in topic 46473, 2026-08-16 14:26 PDT"
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

#### The bootstrap exemption (without it, this spec reproduces the bug it fixes)

Every `/routing-spend/*` route is currently gated on `moneyOn()`. If the enable plan is
rendered by a route behind that gate, then enabling requires the layer to already be
enabled — the fix would be exactly as unreachable as the thing it fixes. A first-round
cross-model review caught this; it is the single most important correction in this spec.

So a **narrow, enumerated exemption** is part of the design, not an afterthought:

- `POST /routing-spend/plan` runs **pre-gate for exactly two action values** (the allowlist of MLE-2):
  `money-layer-enable` and `money-layer-disable`. Every other action stays gated.
- The matching commit route and a read-only `GET /routing-spend/enable-status` are
  likewise pre-gate.
- **Nothing else is exempt.** Caps adjust, arming, the ledger, the metered gate and the
  spend summary all remain behind `servingReady` (see MLE-2).

The exemption is an **allowlist keyed on the action value**, expressed as a single
enumerated constant so the exempt set is greppable and testable, never a
"skip the gate when the body looks like an enable" condition. A required test asserts
that a non-exempt action presented to the pre-gate path is refused with the normal 503 —
the exemption must not become a hole through which the rest of the money surface is
reachable while the layer is off.

The exemption is safe precisely because these two actions **cannot move money**: they
render text and, on PIN commit, flip a permission flag that leaves every door disarmed.
The PIN requirement is unchanged; what is relaxed is only "the layer must already be on."

The enable state must live **outside** `.instar/config.json`'s patchable surface. Two
candidates were considered:

1. **In the existing `RoutingSpendCapsStore`** — already outside `PATCHABLE_CONFIG_KEYS`,
   already PIN-authored, already audited by `caps/log`. `intentEnabled` becomes
   "config says true **or** the store's operator-enabled flag is set".
2. **A dedicated store.** Cleaner separation, one more file to keep coherent.

**DECIDED: Option 1.** It reuses a store whose write-discipline is already money-grade,
and it keeps the whole money authority answerable from one audit log. The config key
remains honored so no existing install changes behavior.

**Why two sources rather than migrating to one authoritative source.** Cross-model review
asked this directly, and it deserves a real answer rather than an appeal to
backwards-compatibility. A hard migration — read the config key once, write it into the
store, stop honoring the config key — is genuinely cleaner and was seriously considered.
It is rejected for one reason: **the migration step would itself have to write or
invalidate a money-bearing config key, which is authority this spec is explicitly
refusing to take.** An agent-held Bearer token must never reach money config; a migration
that "helpfully" rewrites it on boot is exactly that reach, arriving through the back
door. The OR is the smaller authority: it *reads* both, *writes* only the store, and can
never disable what the operator set by hand.

The cost is honestly stated: two inputs to one question, mitigated by MLE-1's enumerated
states and by the fact that only one of the four needs operator attention. The
`config-enabled` prompt is offered as a **one-tap operator action**, never an automatic
rewrite.

**It is a mirror, not a migration, and calling it a migration was wrong.** Since no route
here may write `.instar/config.json`, the one-tap action can only copy the config value
into the store — producing `both-enabled`, not a move off config. Review caught the
overclaim. So the action is named **"mirror into store"** in the UI and the plan text, and
it is explicit that the config key remains set and remains the reason disable cannot fully
disable. Genuinely reaching a single source requires the operator to remove the config key
by hand; the surface tells them so, and does not pretend a tap achieved it.

### The construction problem — an enable that only pretends

`moneyOn()` gates the routes, but the money layer's components (the booking ledger, the
O(1) fail-closed gate, the caps store) are **constructed at server start** and only when
the layer was already enabled. So flipping the flag alone yields a surface that reports
`enabled: true` over machinery that is not running — every route behind it still refuses.
An enable button that ignores this is a button that lies.

The commit path therefore MUST, in order:

1. Persist the operator-enabled flag (PIN-committed, plan-bound, audited).
2. **Verify the money layer is genuinely constructed and serving** — not that the flag
   reads true, but that the layer's own components answer, including the **enforcing
   gate** (see the probe contract below).
3. If it is not up, bring it up.
4. Report the honest end state.

#### The restart contract — a request cannot report on its own server's restart

Step 3 is where this design could quietly become a lie. An HTTP request that restarts the
process serving it cannot then report the post-restart result: the connection dies with
the server. Cross-model review flagged the original wording ("restart, re-verify, report")
as unimplementable-as-written. The mechanism is therefore pinned, in preference order:

**PHASE 1 SHIPS `enable-pending-restart`. Hot construction is Phase 2.** An earlier draft
made in-process construction the target path and the pending state a fallback. Review
pushed back: hot construction is, in effect, a small lifecycle manager — phased publish,
ordered rollback, idempotent cleanup of timers, watchers, clients and metrics — and the
industry-standard alternative is far simpler: *persist the intent, let restart converge,
expose honest pending status.* That is the right first build, and the reasoning is
decisive here because **the operator's actual complaint is "there is no way to turn it
on", not "turning it on takes a restart."** Phase 1 solves the reported problem end to
end; Phase 2 removes a restart. Shipping the lifecycle manager first would risk the
correctness of a money control to save the operator one restart.

1. **`enable-pending-restart` — PHASE 1, what this build delivers.** The commit does
   **NOT** restart anything synchronously. It persists the flag and returns
   `{ lifecycleState: "enable-pending-restart", enforcementReady: false }` with plain
   text: *"enabled — the money layer comes up on the next server restart; it is not
   enforcing yet."* The readiness probe runs at construction, so the state that appears
   after the restart is verified, not assumed.

   **The restart must itself be completable from the phone, or Phase 1 fails the very
   standard this spec cites.** Review caught that "the Spend tab offers the restart" was a
   hand-wave: an unspecified restart leaves a remote operator holding a switch they cannot
   finish flipping — the original complaint in a new costume. So the restart is specified
   end to end, as part of Phase 1:

   - **`POST /routing-spend/money-layer/restart`** — pre-gate (allowlisted), Bearer **plus**
     PIN, same rate-limit and audit discipline as the commit route. It accepts only when
     `lifecycleState === "enable-pending-restart"`, so it is not a general-purpose restart
     button bolted onto the money surface.
   - **Mechanism:** it uses the server's existing supervised-restart path (the same one the
     auto-updater uses, under launchd keepalive) — no new restart machinery.
   - **Failure contract:** if the restart cannot be initiated, it returns `503` naming the
     reason and the state stays `enable-pending-restart`; it never reports success it
     cannot observe. Because the response may be lost with the connection, the operator's
     source of truth is the poll, not this response.
   - **UI flow:** the Spend tab shows *enabled — not enforcing yet*, a **Restart now**
     button, then a waiting state that polls `GET /routing-spend/enable-status` until it
     reports `ready`/`enforcementReady: true`, or surfaces `repair-failed` with its failing
     component. If the poll does not flip within a bounded window, the tab says so plainly
     and offers a retry rather than spinning forever.
   - **Audit, ordered against the handoff:** `restart requested` is appended and **flushed
     BEFORE the supervisor handoff**, so a process that exits mid-restart still leaves
     evidence that the operator asked. `initiated` is explicitly **best-effort** — the
     process may die before writing it, and its absence must never be read as "the operator
     never tried". `observed-ready` is written by the NEW process after its probe, and is
     the only durable proof the restart achieved anything.
   - **After connection loss:** the tab polls `GET /routing-spend/enable-status` on an
     interval with a bounded overall window. `enable-pending-restart` persisting past the
     window is reported as *"the restart does not appear to have completed"* with a retry —
     never an indefinite spinner, and never an assumed success.

   With that, the whole path — enable, restart, confirm enforcing — is completable from a
   phone, which is the standard being claimed. Phase 2 removes the restart step; it does
   not rescue Phase 1 from being incomplete.

2. **In-process construction — PHASE 2, a later enhancement.** The lifecycle container
   (`prepare/start/probe/commit/rollback`) below specifies it, and it is deliberately NOT
   in this build's scope. It is written down now so Phase 2 does not have to rediscover
   the rollback and registration ordering, and so a future implementer does not mistake
   "construct it hot" for a small change.

**What is forbidden:** returning `ready: true` on the strength of the flag alone, or on a
restart whose outcome this request cannot observe. The response's `ready` field means
"probed and answering", never "should be working now". A pending state that is honestly
labelled is a good outcome; a success claim that outruns its evidence is the failure this
whole spec exists to prevent.

#### What Phase 1 must build, and what is Phase 2 design notes

Review found Phase 1 and Phase 2 interleaved to the point where an implementer could not
tell which behaviour was required now. The split is therefore explicit, and the
lifecycle-container material below is **Phase 2 design notes, not Phase 1 requirements**:

| Behaviour | Phase 1 (build now) | Phase 2 (later) |
|---|---|---|
| `disabled` / `enable-pending-restart` / `ready` / `repair-failed` states | **yes** — all four arise at boot/probe time | — |
| `enabling` state, `423` response | no — cannot arise without hot construction | yes |
| `500` construction error at commit | no — commit does not construct | yes |
| process-local construction lock | no | yes |
| `prepare/start/probe/commit/rollback` container + cleanup hooks | no | yes |
| readiness probe (cap-gate) | **yes** — runs at boot construction | yes |
| boot recovery rule | **yes** | yes |
| restart route + poll flow | **yes** | removed/optional |

**Phase 1 tests assert only Phase 1 behaviour.** A Phase 1 test suite that required
`enabling` or the rollback hooks would be testing unbuilt machinery, and its passing would
mean nothing.

**Phase 2 must plug into the existing server lifecycle, not invent a parallel one.**
Review's point stands: prepare/start/probe/commit/rollback is a reinvention unless it is
named as an adapter over what the server already does at construction. Phase 2's first
task is therefore to identify and extend the existing component-construction path in
`server.ts` rather than to add a second lifecycle system beside it. If that turns out to be
infeasible, Phase 2 needs its own spec — it does not get to grow out of this one.

#### Lifecycle state machine and concurrency *(Phase 2 design notes except where marked)*

In-process construction is where an under-specified design fails in practice, so the
lifecycle is pinned rather than left to the implementation:

```
disabled ──enable commit──▶ enabling ──probe ok──▶ ready
                              │  │
                              │  └──construction impossible──▶ enable-pending-restart
                              └──probe fails / partial──▶ repair-failed

disable commit ──▶ clears store flag, then RE-DERIVES from resolved intent:
    intentEnabled now false ──▶ disabled
    intentEnabled still true (config key set) ──▶ stays ready / repair-failed,
                                                  with storeCleared: true
```

**Disable does not transition to `disabled` by fiat.** An earlier diagram said "(any
state) → disabled", which contradicted the rule that `lifecycleState` answers *can money
move right now*. Disable clears the store flag and the state is then **re-derived**: it
reaches `disabled` only when resolved intent has actually become false. When the config
key still holds the layer on, the honest result is that the state does **not** change to
disabled — and the operator is told so.

- **`enabling` is serialized by a process-local lock.** Construction is once-only:
  a second concurrent enable observes `enabling` and waits on the same outcome rather than
  building a second set of components.

  **Machine-local is not the same as process-local**, and the earlier draft conflated
  them — a review round correctly refused the hand-wave. Two server processes on one
  machine would share the store flag while holding independent construction state. This
  design does **not** invent a new interprocess lock: instar already enforces **one server
  process per agent home** via its existing per-agent single-instance lock (the same lock
  that removed the duplicate-server multiplier from the fork-bomb work).

  **That dependency is asserted here, and asserting it is not proving it** — review was
  right to withhold trust, since a reviewer reading this document cannot see the lock's
  source. A dependency this load-bearing must be checked at runtime, not cited:

  - **Phase 1 (required now):** the money layer verifies at startup that the single-instance
    lock is genuinely **held by this process**, and records the result. If it is absent,
    unverifiable, or held elsewhere, the layer refuses to construct and reports
    `repair-failed` naming the reason — fail closed, because the alternative is two
    processes racing on money state. A test asserts the refusal.
  - The same check runs on the commit and status paths, so a lock that is lost while
    running surfaces rather than being assumed to persist from boot.
  - **If that invariant is ever relaxed**, this lifecycle must move to an interprocess lock;
    this paragraph and the startup check are the markers saying so, and the check will fail
    loudly rather than silently degrade.
- **Partial construction rolls back — and "discarded" is not good enough for real server
  components.** Review was right that dropping a reference does not stop a timer, close a
  file watcher, unregister an event handler or metric, release a ledger handle, or shut
  down a provider client. A "discarded" half-built layer that still holds those is a leak
  at best and a phantom second layer at worst. Construction therefore runs through an
  explicit **lifecycle container** with ordered phases:

  | Phase | What may happen | Global visibility |
  |---|---|---|
  | `prepare` | allocate components; acquire handles | none — nothing registered globally |
  | `start` | start internal machinery | still none |
  | `probe` | cap-gate readiness probe | still none |
  | `commit` | publish the layer; register metrics, timers, watchers, handlers | **only here** |
  | `rollback` | idempotent cleanup of everything prepared/started | — |

  **Global registration happens only after a successful probe.** Nothing outside the
  container can observe a layer that has not proven itself, so a failed enable cannot
  leave partially-registered machinery behind.

  **Every prepared component exposes an idempotent cleanup hook**, and `rollback` invokes
  them in reverse order; a cleanup that throws is logged and the remaining cleanups still
  run. Rollback is safe to call twice. Only then does the state become `repair-failed`,
  carrying the failing component; it is re-enterable — pressing enable again retries from a
  genuinely clean base rather than on top of leftovers.
- **`GET /routing-spend/enable-status` observes this state machine directly**, so a status
  read during construction returns `enabling`, never a stale `disabled` or an optimistic
  `ready`.
- **What persists, and what does not** — declared explicitly, because an under-specified
  answer here lets a crash launder a failure into a benign-looking pending state:

  | Field | Persisted? | Why |
  |---|---|---|
  | operator-enabled flag | **yes** (caps store) | the operator's decision must survive a crash |
  | `lifecycleState` | **no** — derived at boot | a stored `enabling` would be a lie after the process that was enabling died |
  | `lastTransitionAt` | **yes** | needed to age a stuck state |
  | last `repair-failed` + failing component | **yes** | see the recovery rule below |

  **Recovery rule at boot:** flag set + components constructed ⇒ probe ⇒ `ready` or
  `repair-failed`. Flag set + components absent ⇒ `enable-pending-restart` — **unless** a
  `repair-failed` record is stored and no successful enable has happened since, in which
  case the state is `repair-failed`, carrying the stored failing component. Without that
  exception a crashed repair would present as an innocuous "just needs a restart" and the
  operator would restart into the same failure with no idea why. A failure must not be
  forgotten by the act of crashing.

#### Route contract

- `POST /routing-spend/plan` — body `{ action: "money-layer-enable" | "money-layer-disable" }`. Bearer. Pre-gate (allowlisted action). Returns `{ planId, nonce, renderedText, machineId, machineNickname, expiresAt }`.
- `POST /routing-spend/money-layer/commit` — body `{ pin, planId, nonce }`. Pre-gate (allowlisted). **Before any effect, the route loads the stored plan and rejects it unless its SIGNED action is `money-layer-enable` or `money-layer-disable`.** The action is not in the request body, so without this check the pre-gate commit route would accept *any* valid plan id — including a caps-adjust plan — and apply it while the money layer is off, which would turn the bootstrap exemption into a hole around the whole gate. Refusal is `409`, and a test presents a caps-adjust plan to this route and asserts it is refused. **Requires the Bearer/session boundary IN ADDITION to the PIN** — the PIN is the authority, never the sole online secret. Dropping Bearer here would make a leaked-or-guessed six-digit PIN sufficient on its own, which is a weaker posture than the caps routes it copies. Failed PIN commits are rate-limited per machine and audited to `caps/log` (attempt count and machine, never the submitted value); repeated failures lock the commit path for a cooldown and raise one deduped attention item. Returns `{ lifecycleState, enforcementReady, enableSources, probe, message }`.
- `GET /routing-spend/enable-status` — Bearer, pre-gate (allowlisted). Returns `{ lifecycleState, enforcementReady, enableSources, machineId, lastTransitionAt, failingComponent? }`.

**The field is `enforcementReady`, never a bare `ready`.** A bare `ready` invites the
ordinary reading "spending works", which it does not mean (see MLE-2). UI copy says
"spending controls are up and enforcing" and never the word "ready" on its own.

**Two distinct state axes, never merged into one field.** `lifecycleState` is one of the
five construction states (`disabled` / `enabling` / `ready` / `enable-pending-restart` /
`repair-failed`); `enableSources.state` is one of MLE-1's four source states
(`disabled` / `operator-enabled` / `config-enabled` / `both-enabled`).

**`lifecycleState` is derived from RESOLVED enablement, never from the store flag alone.**
An earlier draft had a disable-with-config-true return `lifecycleState: "disabled"`
alongside `enableSources.state: "config-enabled"`, and review correctly refused it: since
`intentEnabled` is `store || config`, the layer in that state is still *enabled and spending*,
so `disabled` is simply false. A field that reads "disabled" while money can move is the
precise failure this spec was written to eliminate — and I reintroduced it while fixing
something else. The rule is therefore:

> `lifecycleState` answers **"can money move right now?"** — it is computed from
> resolved intent, never from `store` alone. `storeCleared` is a separate boolean reporting
> what the operator's action actually did.

So a disable while config is true returns `lifecycleState: "ready"` (money can still
move), `enableSources.state: "config-enabled"`, `storeCleared: true`, and a message
saying plainly that the store flag was cleared but the config file still holds the layer
on. The operator is told their disable did not disable. That is the whole point.
- **Errors:** `400` malformed; `401` bad/absent PIN; `409` plan id unknown, expired, already consumed, or **submitted to a different machine than it was rendered on**; `423` an enable is already `enabling`; `500` construction error (state becomes `repair-failed`, and the response says so).

**Plan rendering is audited and rate-limited.** Plan creation is Bearer-authorized and now
sits pre-gate, so the agent can render money plans before the layer is on. The PIN still
holds all commit authority — but an unaudited, unlimited render lets an agent spam
operator-visible money prompts, which is both a nuisance surface and a way to fatigue an
operator into tapping. So every render is audited with its action and machine, and
pre-gate renders are rate-limited per machine; exceeding the limit returns `429` and
raises one deduped attention item rather than a stream.

**Audit-only appends are a separate channel from authority writes.** This spec leans
repeatedly on the claim that `RoutingSpendCapsStore` is written only by a PIN-committed
rendered plan — so letting Bearer-authorized plan *renders* append to the same `caps/log`
would quietly falsify it, as review noted. Two channels, distinguished by schema and
writer, not by convention:

- **Authority writes** (the enable flag, caps, arm/freeze state): PIN-committed,
  plan-bound. Unchanged.
- **Audit-only appends** (plan rendered, PIN attempt failed, probe result, state
  transition): append-only, strict schema, carry **no** authority fields, and are rejected
  by the store if they attempt to set one.

**Append-only is enforced at the storage API boundary, not by schema validation alone.**
Review flagged that mixing mutable authority state and append-only history behind one
store is a known footgun, and schema checks are the weakest form of that guarantee — they
constrain what a caller *sends*, not what the store *permits*. So the audit channel is a
distinct handle whose interface offers only `append` and `read`: no update, no delete, no
rewrite, structurally absent from the type rather than refused at runtime. The authority
handle cannot append audit rows and the audit handle cannot touch authority state; a
caller holding one cannot reach the other. They share a file for operator convenience —
one readable history — and share nothing else.

`GET /routing-spend/caps/log` continues to present a merged, time-ordered view — the
operator sees one history — but each entry is tagged with its channel, so "what changed
money state" and "what merely happened" are never confused when reading it back.

**Plans are machine-bound.** The rendered plan text names the machine, and `machineId` is
part of the signed plan material — a plan rendered on one machine is refused on another
with `409`. Without this, a plan rendered on the laptop could be committed against the
Mini, enabling spend on a machine whose operator never saw the plan. The UI shows the
target machine so the operator is never approving an action for a machine they did not
mean.

**Re-pressing enable when the flag already reads true must NOT be a no-op.** "Switch says
on, machinery is down" is precisely the broken state this control exists to rescue the
operator from; a no-op would leave them with a switch reading on, nothing working, and a
button that politely does nothing. Enable is therefore idempotent in *intent* (it never
double-enables) but always re-verifies and re-repairs.

**Disable is not symmetric.** It clears the store flag immediately, and
does **not** restart the server: a restart is a heavy, disruptive action to leave behind a
credential the agent holds, and halting money must stay cheap. Doors shut instantly; the
machinery is torn down on the next natural restart.

**What makes disable real rather than hopeful.** Leaving the components constructed after
a disable is only safe if the paid path itself re-checks. So:

> **The one-line truth, which every other disable claim in this document is qualified by:**
> *disable stops new spending immediately **only when the store flag is the active enable
> source**. If the config key is also set, spend remains enabled and **freeze is the
> emergency stop**.*

Review flagged that earlier drafts said "doors shut instantly" unqualified while also
admitting the config-enabled exception — the reassuring sentence and the true one sat in
different sections. The qualification now travels with the claim everywhere it appears,
including in the plan text the operator reads before committing a disable.

- **The metered-call path performs a synchronous enable check on every paid call**,
  reading the live enable state — not a value captured at construction. A constructed-but-
  disabled layer therefore refuses at the point of spend, which is the only place the
  check matters. Without this the disable would be cosmetic, closing routes while the
  spend path carried on; a third review round flagged exactly that gap.
- **Disable is verified the same way enable is**, by its own synthetic probe: after a
  disable, a dry-run call on the real metered path must refuse with the specific
  *money-layer-disabled* reason. `ready: false` is asserted, not assumed, and a disable
  whose probe does not confirm refusal reports `repair-failed` rather than success.

**In-flight work at the moment of disable.** "Instantly" is a claim about new calls, and
saying only that would leave the operator's actual question unanswered: what about the
call already running? Declared, because a disable whose scope is vague is a disable nobody
can rely on in an emergency:

- **A call that has not yet passed the enable check is refused.** This is the common case
  and the one "instantly" refers to.
- **A call already in flight with the provider is allowed to finish, and its spend IS
  booked.** Killing it mid-flight would spend the money without recording it — the worst
  of both outcomes, since the provider has already been asked to do the work. The ledger
  must record what was actually incurred.
- **Queued-but-unstarted work is dropped** at the enable check, like any new call.
- **Reservation/commit flows** that reserved before the disable settle their reservation
  normally; no new reservation is granted.
- The disable response reports the count of in-flight calls still settling, so "disabled"
  never silently means "and a few more charges are still landing."

The honest summary given to the operator: *when the store flag is the active source,
disable stops new spending immediately; a call already sent to a provider finishes and is
billed. If the config key is also set, disable does NOT stop spending — freeze does.* For
any harder or faster stop, freeze is the existing instrument and remains Bearer-cheap.

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

## Resolved decision — the operator's monthly intent

Separately reported by the operator: they want "$100/month". The cap model has a
**lifetime total** and a **daily rate**, and no calendar-month concept. The three
honest options, none of which is free:

1. **Daily-rate approximation** (~$3.30/day): no code change; does not stop a heavy
   fortnight followed by a quiet one, and never sums to a month.
2. **Lifetime as a pot** ($100, topped up): a genuine hard ceiling; requires the
   operator to remember to refill, and a forgotten refill is a silent outage.
3. **A real monthly cap**: a new cap dimension through the ledger, the gate, the plan
   renderer and the caps view. Correct, and the largest change of the three.

**DECIDED: Option 1 (daily-rate approximation), operator, 2026-08-16 14:26 PDT — "daily
is fine for now".** This keeps the present build to the enable surface only; the cap
model is untouched.

**The honesty obligation this creates.** A daily rate is not a monthly cap and the surface
must not imply otherwise. The plan text the operator reads before committing a daily cap
must state plainly what it does and does not guarantee: a $3.30/day cap bounds any single
day, and over a 30-day month bounds the worst case near $100 — but it does **not** cap a
calendar month, and it does not prevent a heavy fortnight. The operator explicitly chose
this shape "for now"; option 3 remains available as its own spec, and choosing it later
changes only the cap dimension, not this enable surface. Nothing here forecloses it.

## Decision points touched

- **Adds** two plan actions and one PIN-gated commit route to the existing money
  authority; the state lands OUTSIDE `PATCHABLE_CONFIG_KEYS`, in a store whose only
  writer is a PIN-committed rendered plan.
- **Replaces** `moneyOn()` with the two predicates of MLE-2 (`intentEnabled` /
  `servingReady`), migrating every existing callsite to whichever it actually meant. The
  config key stays honored, so an install that sets it today is unaffected.
- **DOES touch, and the earlier draft was wrong to deny it.** The spec claimed it "does
  not touch the metered call gate or the ledger" while simultaneously requiring every paid
  call to re-check enable state and requiring a probe to traverse the real metered path.
  Review caught the contradiction. The honest scope:
  - **Metered call path / gate — MODIFIED.** A synchronous live enable check on every paid
    call, plus the internal probe entry point. This is the load-bearing change; without it
    disable is cosmetic.
  - **Caps store — MODIFIED.** Holds the operator-enabled flag, the `repair-failed` record,
    `lastTransitionAt`, and the probe sentinel fixture.
  - **Ledger — MODIFIED (dry-run path only).** The sentinel evaluation runs in dry-run and
    must be asserted to book nothing. Real booking behaviour is unchanged.
  - **Per-door arming and the freeze asymmetry — GENUINELY UNTOUCHED.** Enabling arms no
    door; freeze stays Bearer-cheap.

  Required tests follow this scope, not the old narrower claim: the metered path, caps
  store, and ledger dry-run each carry tests for the behaviour added here.

Classification (per **Judgment Within Floors**):

| Decision point | Class | Justification |
|---|---|---|
| "May this commit apply?" (PIN + plan-id + nonce valid) | `invariant` | Authorization on money. There are no competing signals to weigh: either the operator's PIN authorized this exact rendered plan or it did not. Judgment here would be a weakness, not a strength. |
| `intentEnabled` — did the operator ask for this on? | `invariant` | A pure OR over two declared sources (MLE-1). Deterministic by construction. |
| `servingReady` — may money actually move? | `invariant` | `intentEnabled && lifecycleState === "ready"` (MLE-2). Deterministic; fails closed when readiness is `unknown`. |
| "Is the money layer genuinely constructed and serving?" (the readiness probe) | `invariant` | A liveness check against the layer's own components, including the enforcing gate. Deterministic, and it fails CLOSED: unmeasurable ⇒ `unknown` ⇒ report not-ready and repair, never assume ready. |
| "Do the two enable sources agree?" | `invariant` | Equality of two booleans. Disagreement is surfaced, never silently resolved by a tiebreak heuristic. |

No judgment-candidate points. Every decision this spec adds is a deterministic
authorization or liveness check on money — the class where static rules are correct and
weighing competing signals would be a defect.

## Verify the state, not its symbol (P20)

The one detector this spec adds is the **cap-gate readiness probe**, declared per P20.

**Its name is its scope.** The probe enters the metered path after go-live and before the
cap check, so it proves *cap enforcement is wired and refusing* — it does not exercise the
full paid-call route end to end, and calling it an end-to-end probe would be the same
overclaim this spec keeps catching elsewhere. Review pushed on the wording and was right.
Full-path coverage is a separate, existing concern carried by the metered path's own
integration tests, which this spec extends with the live enable check; the readiness probe
deliberately does not duplicate them. What `ready` asserts is precisely: *the cap gate is
constructed, reachable from the metered path, and refuses an over-cap attempt for the
cap-exceeded reason.*

- **Symbol read:** the money-layer components resolve as constructed on the server object.
- **State claimed:** the money layer is genuinely running and will enforce caps.
- **Independent corroboration:** "the gate object exists and answers" is itself only a
  symbol — cross-model review pushed correctly on this. The probe's corroboration is a
  **synthetic refusal**: a dry-run spend evaluation on a sentinel key, deliberately over
  its cap, driven through the **real metered-call path** rather than by calling the gate
  directly. Ready means *the path that spends money demonstrably refused an over-cap
  attempt*. This proves the call path routes through the gate, which component-presence
  cannot. The sentinel evaluation books nothing: it runs in the ledger's existing
  dry-run mode and is asserted to leave committed spend unchanged.

  **A refusal is not evidence unless its CAUSE is checked.** A second review round caught
  that the metered path can refuse for many unrelated reasons — door not armed, unknown
  key, missing provider, auth failure, malformed request — and any of those would make the
  probe pass while proving nothing about cap enforcement. So the probe asserts on the
  refusal's *classification*, not merely its occurrence:

  - **Sentinel identity:** a reserved keyRef (`__probe_sentinel__`) that is never a real
    paid door and can never be armed for live spend.

    **How a never-live sentinel reaches the cap gate at all** — a review round caught the
    tension here, and it is worth stating precisely, because an implementer left to guess
    would build a probe that always fails for the wrong reason. The sentinel is a
    **probe-only fixture in dry-run mode**: it is registered in the caps store with a
    nominal cap and a `probe: true` marker, and the probe's evaluation deliberately
    enters the metered path at the point **after** the go-live check and **before** the
    cap check. It therefore traverses genuine cap enforcement without ever being live.
    That bypass is scoped to the `probe: true` fixture and to dry-run mode, asserted by
    test: a non-probe key presented on the probe path is refused, so the bypass cannot
    become a route around go-live for anything real.

    **A runtime check on a flag is too weak a boundary for a go-live bypass**, and review
    was right to push here — twice. "Non-exported and non-routable" is better than a flag
    check, but in a TypeScript codebase that boundary erodes quietly through barrel files,
    test-only exports, and dependency injection; nothing structurally prevents a future
    refactor from handing the bypass to route code. So the boundary is a **capability**,
    not a visibility convention:

    - The probe path accepts a **closure-scoped capability token** minted once, at
      money-layer construction, and handed only to the readiness prober. The token type is
      not constructible by route code — there is no exported constructor, and possession is
      the authorization.
    - No token ⇒ the probe path behaves exactly like the normal metered path, i.e. go-live
      is enforced. The bypass does not exist for a caller that cannot present the token.
    - **A negative integration test proves HTTP cannot reach it**: every route is exercised
      against the sentinel and must fail to obtain a bypassed evaluation. A lint (no route
      handler references the probe symbol) remains as a cheap early signal, but the test is
      the authority.

    The `probe: true` runtime check stays as defence in depth. The point of the change is
    that the bypass is now unreachable by construction rather than by convention.
  - **Preconditions asserted before the probe runs:** the sentinel resolves, its provider
    is present, and the request is well-formed — so those failure modes are excluded up
    front rather than being mistaken for enforcement.
  - **Expected result:** refusal with the specific cap-exceeded reason code. Any other
    refusal reason ⇒ `unknown` ⇒ NOT ready. A refusal for the wrong reason is treated as
    a probe failure, never as a pass.
  - **Post-assertion:** committed spend for the sentinel is unchanged.
- **Symbol present, state absent:** components constructed from a stale pre-enable boot
  could exist while the gate is not enforcing — which is why the gate is probed directly
  rather than inferred from its siblings.
- **State present, symbol absent / unmeasurable:** the probe returns `unknown`, never a
  flattering default. `unknown` is treated as NOT-ready — the least-harmful action here is
  to attempt the repair and report honestly, because a false "ready" opens spending while
  a false "not ready" costs only a restart.

## Multi-machine posture

- **The operator-enabled flag + caps state** (`RoutingSpendCapsStore`): `machine-local`.
  `machine-local-justification: physical-credential-locality` — the state authorizes
  spending against provider credentials that physically live in one machine's config home,
  and the dashboard PIN that commits it is per-machine and does not cross the mesh (the
  same reason the existing money routes and the follow-me code-submit step are per-machine).
  Replicating an enable across machines would grant spend authority on a machine whose
  operator never approved it. Enabling is therefore a per-machine action, and the Spend
  tab says so plainly rather than implying a fleet-wide switch.
- **The Spend tab surface itself:** `proxied-on-read` — it renders whichever machine's
  server is fronting it, and the existing pool-link machinery already resolves the holder.
- **The enable/disable audit trail** (`caps/log`): `machine-local`, same justification —
  it is the audit of a machine-local authorization and belongs with the state it records.

## Frontloaded Decisions

Every decision that would otherwise stop the build mid-run is closed here:

1. **Build it at all** — YES (operator, 2026-08-16 14:26 PDT).
2. **Cap shape** — daily-rate approximation (operator, same message). The cap model is untouched.
3. **Where the enable state lives** — Option 1, `RoutingSpendCapsStore`.
4. **Handling of the two sources** — OR for resolution; the four states of MLE-1 are enumerated and only `config-enabled` is surfaced for action. **Disable clears the STORE flag only.** It never writes `.instar/config.json`. When the config key is true, disable reports *still enabled by config* with the remediation named, and is never presented as a successful disable. (MLE-1.)
5. **Enable when already enabled** — re-verify and repair, never a no-op.
6. **Disable** — clears the store flag; stops new spending **only when the config key is not also enabling it**. Never restarts the server.
7. **Freeze stays Bearer** — unchanged; halting money stays cheap.
8. **Does the agent gain any new authority?** — No. Bearer renders plans; only the PIN commits.

## Open questions

*(none)* — both previously-open decisions were resolved by the operator on 2026-08-16.

## Risks

- **The obvious one: this makes real spending easier to switch on.** Mitigated by
  keeping the enable PIN-gated and plan-bound, by leaving every door disarmed on
  enable, and by leaving freeze Bearer-cheap. The alternative — leaving it unreachable
  — has its own failure mode, which is the operator hand-editing a JSON file on a
  money-bearing config while reading instructions off a phone.
- **Two sources of truth for one flag** (config key + store), which Option 1 makes real.
  Naming one "authoritative" and surfacing both is NOT sufficient — an unchecked pair of
  stores that answer the same question is precisely the drift the **Cross-Store Coherence
  Is an Invariant** standard exists to prevent, and the Standards-Conformance Gate flagged
  it on round 1. The invariant is therefore declared and checked, not merely documented:

  **Invariant MLE-1.** `intentEnabled` resolves to `store.operatorEnabled === true || config.routingSpend.money.enabled === true` — an OR, so neither source can silently *disable* what the other enabled, and no state exists in which the layer is live but both sources read false.

  **MLE-2 — intent is not permission to spend.** `moneyOn()` as a single predicate was
  doing two jobs and could therefore lie: after a persisted flag but a *failed*
  construction, it read `true` while money could not safely move. Rounds 5 and 6 both
  surfaced symptoms of this before the cause was named. It is split:

  | Predicate | Means | Composed of |
  |---|---|---|
  | `intentEnabled` | the operator asked for the layer to be on | store flag OR config key (MLE-1) |
  | `servingReady` | the enforcement layer is up, so paid calls may be attempted | `intentEnabled && lifecycleState === "ready"` |

  **What `ready` does and does not promise.** `ready` means **enforcement-ready**: the cap
  gate is constructed, reachable from the metered path, and refusing over-cap attempts. It
  does **not** promise provider-ready — credentials, booking commit, and downstream
  execution are separate concerns with their own failure modes, and a cap-gate probe
  cannot speak for them. Review flagged that an operator-facing `ready` naturally reads as
  "everything works", so the surface states the narrower meaning in words rather than
  relying on the reader to infer it: *"spending controls are up and enforcing"* — never
  *"payments are working"*. A provider that is broken while the gate is healthy shows up
  as a failed call with its own reason, not as a false `ready`.

  - **Paid spend is gated on `servingReady`** — never on `intentEnabled` — in addition to
    the existing freeze and cap checks. A persisted intent with a failed construction
    therefore spends nothing.
  - **`servingReady` includes the single-instance-lock check on every paid call.** If that
    lock is load-bearing against two processes racing money state, then checking it only at
    startup/commit/status leaves the spend path — the one that actually moves money —
    trusting a fact that may have expired. A lost lock fails closed: spend refuses.
  - **Freeze is NOT subject to `servingReady`.** Freeze is Bearer-authorized and available
    whenever intent or constructed spend machinery exists, explicitly including
    `repair-failed` and `config-enabled`. Gating the emergency stop on the healthy state
    would remove the brake exactly when it is most needed — and since a config-enabled
    disable cannot stop spend, freeze is the operator's real stop in that case. It is named
    as an explicit exception to the route-visibility rule, not left to "every other route".
  - **Route visibility is gated on an explicit allowlist**, not on either predicate
    doubling as an authorization: the two enable actions and the status read are the
    pre-gate allowlist; every other `/routing-spend/*` route requires `servingReady`.
  - **`moneyOn()` is removed rather than redefined.** Leaving the old name in place would
    invite exactly the accidental reuse that caused this — a future callsite reaching for
    the familiar predicate and getting intent when it needed permission. Its callsites are
    migrated explicitly to whichever of the two they actually meant, and a lint fails the
    build if the name reappears.

  **Four named states, not a boolean "do they agree".** An earlier draft said both
  "surface every difference" and "store-true + config-false is not worth surfacing",
  which cannot both hold; cross-model review flagged the contradiction. The state is
  therefore enumerated, and each state's operator-visibility is declared:

  | store | config | State | Surfaced? |
  |---|---|---|---|
  | false | false | `disabled` | Normal. The Spend tab shows the enable control. |
  | true | false | `operator-enabled` | Normal post-build state. Not a warning. |
  | false | true | `config-enabled` (legacy) | **Yes** — labelled as set by config file, with a one-tap migration to store-set offered. |
  | true | true | `both-enabled` | Informational only; shown in the detail view, not as a warning. |

  `GET /routing-spend/caps` reports `enableSources: { store, config, state }` carrying
  that state name. There is no `agree` boolean, because "disagree" was the wrong frame:
  only `config-enabled` needs the operator's attention, and it needs it as a migration
  prompt rather than an alarm.

  **Checked, on a cadence, not on hope.** The state is recomputed at (a) money-layer
  construction, (b) every `GET /routing-spend/caps` read, and (c) each enable/disable
  commit's post-verify step. Entering `config-enabled` is audited to `caps/log`.

  **Disable clears what it can, and says what it cannot.** The config key is deliberately
  NOT writable by this path — `PATCHABLE_CONFIG_KEYS` stays untouched and no PIN commit
  writes `.instar/config.json`, because a route that can edit the money config file is a
  larger authority than the one being added. Therefore:

  - Disable **always** clears the store flag, immediately.
  - If the config key is true, the layer is still on, and the disable response and the
    Spend tab say exactly that: *"the layer is still enabled by a setting in the config
    file on this machine; clearing the store flag alone will not turn it off"* — plus the
    named remediation. It reports the true end state, never a success it did not achieve.
  - The plan text rendered **before** the operator commits a disable already warns of this
    when the config key is set, so the limitation is known at decision time rather than
    discovered afterwards.
  - **When config is true, the disable plan requires an explicit acknowledgement** — the
    operator must confirm they understand this action will NOT stop spending — and the
    surface routes them to **freeze** as the immediate stop, presented as the primary
    action with disable demoted to secondary. A button labelled "disable" that leaves money
    flowing is a genuine operator hazard however well documented, so in that state the UI
    leads with the control that actually works.

  This is a real, stated limitation of the daily-shape build, not a hidden one. It affects
  only installs that set the legacy config key by hand — for which the migration prompt is
  the honest fix.

## Status

Authored 2026-08-16 against live state on the operator's laptop (`routingSpend.money`
absent from config; `/routing-spend/plan` returning 503; `routingSpend` verified absent
from `PATCHABLE_CONFIG_KEYS`).

**Approved by the operator 2026-08-16 14:26 PDT** (topic 46473): build it, with the
daily-rate cap shape. Both previously-open decisions are now closed — storage is Option 1
(`RoutingSpendCapsStore`), cap shape is the daily-rate approximation.

Convergence review still outstanding; per the money layer's own rules no code lands
against this spec until it carries the `review-convergence` tag as well as this approval.
