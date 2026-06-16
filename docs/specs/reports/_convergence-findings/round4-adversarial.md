# Round 4 — Adversarial lens, FINAL convergence check (NEW material only)

Scope: verify the round-3 edits adversarially against the **actual code**, not the prose.
(1) Did §4.5's switch to `Promise.race` actually resolve the A1 crash hazard?
(2) Does §4.6's live-read + layering introduce a NEW adversarial failure mode — e.g. a
malicious/buggy *runtime* mutation of `componentFrameworks` the layering would now honor
dangerously?
(3) Any other NEW failure mode from the round-3 edits.

Grounding read (live code, this worktree):
`IntelligenceRouter.ts:100-219` (resolveFramework precedence + the unpatched swap loop),
`InputGuard.ts:305-345` (the cited `Promise.race` precedent), `server.ts` (`src/commands/server.ts`)
`:4674-4729` (router construction site — the real path is `src/commands/server.ts`, not a
top-level `server.ts`; the spec's `server.ts:4687`/`:11266` line refs are the correct *region* in
the correct file), `server.ts:11251-11271` (the CartographerSweep `overrides.CartographerSweep`
inject), `CartographerSweepEngine.ts:53-78` (`resolveSweepFrameworkRouting`),
`componentCategories.ts:109-112` (`categoryForComponent` default), `routes.ts:1401-1411` +
`:19058-19116` (the `PATCH /config` allowlist + its one-level merge).

---

## A1 verification — RESOLVED. The `Promise.race` form is crash-safe; round-3 fix landed correctly. (confirms, no change)

§4.5 now mandates **`Promise.race([tp.evaluate(), timeoutPromise])`** and explicitly drops the
round-2 `.catch()`/`unref()`/AbortSignal prescription. Verified against the exact precedent the
spec cites:

- `InputGuard.ts:320` ships **`await Promise.race([this.intelligence.evaluate({...gating:true...}),
  <reject-after-timeout>])`** with **no `.catch` on the abandoned `evaluate()`**, and is not a
  documented crash hazard. Node attaches a settlement reaction to *each* input of `Promise.race`,
  so when the loser (`tp.evaluate()`) rejects *after* the timeout won, that rejection is **already
  handled** → no `unhandledRejection` → no crash. The round-3 synthesis premise is correct and the
  spec now matches a real, shipped, safe pattern.
- The AbortSignal clause is correctly dropped: `IntelligenceOptions` (`types.ts`) still has **no
  `signal` field** and both CLI providers `execFile` with only `timeout:`, so the round-2 language
  had no receiver. §4.5 now relies on the providers' **existing `timeoutMs → SIGTERM`** for
  subprocess kill — grounded: this is the same bound A3 (round-3) verified, and it bounds the
  subprocess independently of the router race. **No new engine API is introduced.** Correct.

**A1 is resolved.** The crash hazard is genuinely gone for the prescribed implementation, and the
prescribed implementation is the one the codebase already proves safe.

One residual precision note (NOT a blocker, NOT new-severity): §4.5 says "the only rule is **use
`Promise.race`, never a detached/awaited handle**." That is the correct rule, but the spec never
states the **timer-leak hygiene** that the InputGuard precedent itself omits and gets away with
only because its timeout is short-lived: the loser-side `setTimeout` in the timeout promise is NOT
cleared when `tp.evaluate()` wins the race, so a fast primary leaves a pending 5s timer per
attempt. At 5s × low call volume this is harmless (the InputGuard 8s floor proves it benign), so
this is a micro-nit, not a convergence blocker — but the §7 regression test should assert the
timer does not keep the event loop alive / is acceptable to leave pending, so a future builder
doesn't "fix" it by switching to a detached handle (Pattern C — the one shape that DOES crash).

## A6 — §4.6 live-read + layering DOES open a new runtime-mutation honoring surface, and the spec under-states it. (NEW — adversarial MEDIUM)

This is the round-4 question (2), and the answer is **yes, a new surface exists** — though the
realized blast radius is small. The mechanism:

`PATCH /config` (`routes.ts:19060`) is a **Bearer-authed runtime mutator**, and **`sessions` is in
`PATCHABLE_CONFIG_KEYS`** (`routes.ts:1404`). Its merge is **one level deep**: for `key='sessions'`
it does `ctx.config.sessions = { ...ctx.config.sessions, ...patch.sessions }` (`routes.ts:19098-19103`)
— i.e. a `PATCH /config {"sessions":{"componentFrameworks":{…}}}` **replaces the whole
`componentFrameworks` sub-object** on the very same in-memory `config` the router reads live
(`resolveConfig: () => config.sessions?.componentFrameworks`, `server.ts:4693`).

Now apply §4.6. §4.4 says the **boot snapshot** decides default-vs-operator *once*, and §4.6 says
in the **default branch** the resolver "returns the computed default layered UNDER any live
in-memory `componentFrameworks` … let a live override that another feature injected at runtime WIN
for its slot." So on an agent where `componentFrameworks` was **absent at boot** (snapshot ⇒
default branch), a *later* `PATCH`-injected `componentFrameworks` is **honored on every subsequent
call** and **wins for its slot** — even though, by §4.4's own intent, the operator-authority
decision was supposed to be frozen at boot (when the block did not exist).

**The adversarial consequence:** the layering means a runtime injection of `componentFrameworks`
(by `PATCH /config`, or by any *future* feature that mutates the block the way CartographerSweep
does) can now **override the safety-gating routing** — e.g. inject
`overrides.MessagingToneGate: 'some-broken-or-slow-framework'`, or inject an empty
`failureSwap: []` that **silently disables the swap-to-fallback for the very gating callers this
spec exists to protect**, with no restart and no operator-set re-detection. §4.6's design *chose*
to honor live mutation (correctly, to preserve CartographerSweep), but the spec frames the only
runtime mutator as CartographerSweep's benign `overrides.CartographerSweep` inject and never
reckons with the **generic, authenticated `PATCH /config` writer that can reach the same object**.
The boot-snapshot's "mutation-proof" framing (§4.4) is therefore **half-true**: the snapshot
protects the *default-vs-operator branch decision*, but the layering deliberately re-opens the
*contents* to live mutation in the default branch — so "operator authority is frozen at boot" and
"runtime mutations win for their slot" are **both true and in tension**, and the spec does not name
that tension.

**Why this is MEDIUM, not HIGH:** (a) the writer is Bearer-authed (it is the operator's own token,
or the agent acting on the operator's behalf — not an unauthenticated attacker), so this is a
**buggy/foot-gun surface, not an external exploit**; (b) an injected *unknown* component name maps
to category `'other'` (`componentCategories.ts:112`, `?? 'other'`), which the default policy does
**not** route — so a typo'd component cannot accidentally land a gating caller off-Claude; the
hazard requires injecting a **real** gating component name; (c) the worst realized outcome is a
gating caller routed to a chosen framework or its swap disabled — which **still fail-opens at the
caller** (§6.4, A4) for a tone-gate/sentinel, so message delivery is not strangled. It is a
routing/observability hazard, not a fail-closed-safety hazard.

**Recommend (one paragraph, no design change required):** §4.6 should add a sentence owning that
**`PATCH /config {sessions.componentFrameworks}` (a patchable key) is, by the live-read+layer
design, honored at runtime in the default branch — the same as CartographerSweep's inject — and
that this is intentional** (an operator editing routing live should take effect, consistent with
"config is read live"). Optionally note that an operator who wants to *lock* routing should set
`componentFrameworks` **at boot** so the §4.4 snapshot puts them in the operator branch (where
§4.6 returns the live block unchanged anyway — so even the operator branch honors live edits to
contents; the snapshot only stops the *default* from being computed, it never freezes contents in
EITHER branch). Naming this explicitly closes the "frozen at boot vs honored live" tension that a
reader currently has to reconcile themselves. This is a **documentation/threat-model completeness**
gap, not a code-safety hole — every realized path still fail-opens.

## A7 — The layering's precedence is sound; CartographerSweep and the default never contend. (NEW — verification, confirms §4.6)

Adversarially checked the precise interaction the round-3 R3-1/R3-S2 fix depends on, since the
whole §4.6 layering exists to not break CartographerSweep:

- `resolveFramework` precedence (`IntelligenceRouter.ts:109-112`) is
  **`overrides[component]` → `categories[category]` → `default` → `defaultFramework`** — `overrides`
  is strictly higher precedence than `categories`.
- CartographerSweep injects **`overrides.CartographerSweep`** (`server.ts:11268`,
  `resolveSweepFrameworkRouting` source `'overrides.CartographerSweep'`) — the *highest-precedence*
  slot, keyed on a component name.
- The default policy writes **`categories.{sentinel,gate,reflector}` + `failureSwap`** — a
  *lower-precedence*, different-keyed slot.

So even when both are present, they **target different keys** and `overrides.CartographerSweep`
wins for the CartographerSweep component regardless of any `categories.*` default — they cannot
contend for the same resolution. The §4.6 "layer the computed default UNDER the live override"
description is mechanically faithful to how `resolveFramework` actually resolves. The §4.1 exclusion
of the `job` category (CartographerSweep maps to `job`) is belt-and-suspenders on top: the default
never writes the `job` slot, so the only thing routing CartographerSweep is its own
`overrides.CartographerSweep`. **R3-1/R3-S2 fix is correct and the regression it guards against is
genuinely closed.** No new issue here.

## A8 — `onDegrade` for the timed-out attempt fires INSIDE the catch handler, after the cap — confirm it cannot stack a second wait. (NEW — verification, confirms)

§4.5 / R3-4 adds `onDegrade({reason:'swap-attempt-timeout: <target>'})` for a capped attempt. The
existing swap loop only calls `onDegrade` on the **success** path (`IntelligenceRouter.ts:203`) and
re-throws silently when all targets fail. Adding a `swap-attempt-timeout` `onDegrade` on the
**timeout/failure** path is purely an emit; `DegradationReporter.report` is synchronous/non-LLM, so
it cannot itself stack another provider wait or re-enter the swap. Confirmed safe — no new latency
or re-entrancy introduced by the observability hook. (Minor: the builder must place the emit so a
timed-out attempt emits exactly once per attempt, not once per remaining target — a §7 test should
pin the emit count = number of timed-out attempts, not a multiple.)

---

## Verdict

**CONVERGED** — with one MEDIUM documentation-completeness gap (A6) recommended for a one-sentence
fix, not a blocker.

- **A1 (round-3's headline fix) is genuinely resolved**: §4.5's `Promise.race` form is the exact
  pattern `InputGuard.ts:320` ships crash-safe; AbortSignal is correctly dropped (no receiver); the
  subprocess-kill reuses the providers' real `timeoutMs→SIGTERM`. The crash hazard is gone and the
  prescription matches proven-safe live code.
- **A7/A8 confirm** the round-3 §4.6 layering is mechanically faithful (overrides > categories;
  CartographerSweep and the default never contend) and the new `onDegrade` emit is inert-safe.
- **A6 is the only NEW adversarial surface**, and it is a *threat-model completeness* gap, not a
  safety hole: the live-read+layer design (correctly chosen for CartographerSweep) also silently
  honors a runtime `PATCH /config {sessions.componentFrameworks}` mutation of gating routing, which
  the spec frames as if CartographerSweep were the only live mutator. Every realized path still
  fail-opens at the caller, the writer is Bearer-authed (foot-gun, not exploit), and an unknown
  injected component is inert (`'other'`). A one-sentence acknowledgement in §4.6 that
  patchable-key runtime mutation is honored-by-design (and how an operator locks routing) closes
  the "frozen-at-boot vs honored-live" tension. **It does not require a design change and does not
  block convergence** — the feature is safe as specified; the spec is one clause short of fully
  owning its own runtime-mutation surface.
