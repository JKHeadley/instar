# Round 3 — Adversarial lens (NEW material only)

Scope: verify the three round-2 prescriptions adversarially against the **actual code**, not the prose.
(1) N1 orphan-safety; (2) N3 §6.4 "caller-handled"; (3) NEW failure modes the round-2 edits introduced.

Grounding read: `IntelligenceRouter.ts:152-219` (the unpatched swap loop — no timeout yet),
`uncaughtExceptionPolicy.ts` (full), `MessagingToneGate.ts` (full), `InputGuard.ts:315-345`,
`MessageSentinel.ts:555-599`, `CodexCliIntelligenceProvider.ts:297-360`,
`ClaudeCliIntelligenceProvider.ts:35-90`, `types.ts:847-934` (IntelligenceOptions),
+ two Node repros of `Promise.race` rejection semantics.

---

## A1 — N1's crash premise is PATTERN-DEPENDENT and, for the obvious implementation, FALSE. (NEW — adversarial HIGH)

N1 states as a **non-negotiable HARD REQUIREMENT** that the abandoned `tp.evaluate()` promise
MUST get `.catch(() => {})` because otherwise "the provider's eventual rejection … hits the
fail-toward-crash `unhandledRejection` policy … and **crashes the server mid-outage**."

Adversarially verified the actual rejection semantics with Node repros. The crash claim is
**true in exactly ONE implementation shape and false in the others**:

- **Pattern A — `await Promise.race([tp.evaluate(), timeout])`** (the obvious §4.5 implementation,
  and the EXACT pattern already shipped at `InputGuard.ts:319-332`): the loser of `Promise.race`
  is considered **handled by the race itself** — Node attaches a reaction to every input promise.
  Repro: a `tp.evaluate()` that rejects 80ms *after* the timeout won the race emits **NO
  `unhandledRejection`**. **No crash. The `.catch(()=>{})` N1 mandates as non-negotiable defends
  against a non-hazard here.**
- **Pattern B — any `.then`/`.catch` reaction attached to the attempt** (e.g. a `settled`-flag
  wrapper): also marks it handled → no `unhandledRejection`, no crash.
- **Pattern C — a *fully detached* `tp.evaluate()`** (promise started, stored to a handle for
  later abandon, but NEVER passed to `Promise.race` and given NO reaction): the late rejection
  **DOES** fire `unhandledRejection`. Repro confirms `UNHANDLED FIRED: Codex CLI exited code 1`.

So N1's crash hazard is real **only for Pattern C**, which is precisely the shape a build might
reach for if it tries to satisfy N1's *other* clause — "keep a handle so an AbortSignal can cancel
the orphan." The prescription's framing ("attach `.catch` … without this, … crashes the server")
is imprecise: it presents a crash as the **default** outcome of racing a timeout, when racing a
timeout (Pattern A) is the one design that **cannot** crash this way. The genuinely load-bearing
rule is narrower and should be stated as: *if the build keeps a detached handle to the abandoned
attempt (Pattern C, required for cancellation), it MUST attach `.catch(()=>{})` to that handle;*
the `Promise.race` form needs no extra catch. As written, N1 risks a builder either (a) adding a
redundant catch and believing they closed a hazard that the race already closed, or (b) — worse —
trusting N1's "race ⇒ crash" mental model, switching to a detached handle for cancellation, and
**then** being the one shape that actually crashes.

**Corroborating evidence this is not theoretical:** `InputGuard.ts:319` already ships
`Promise.race([this.intelligence.evaluate(...), <timeout>])` with **no `.catch` on the abandoned
evaluate** and is not a documented crash hazard — because Pattern A is safe. The spec's own N1
premise, applied literally, would flag this shipped, reviewed callsite as a latent server-crash
bug. It is not one. That inconsistency is the tell that N1 over-generalizes.

**Recommend:** restate N1 to scope the mandatory `.catch` to the *cancellation/detached-handle*
implementation, and explicitly bless the `Promise.race` form (with InputGuard cited as the live
precedent) as crash-safe without an extra catch. The regression test in §7 should assert the
chosen implementation's actual shape, and — if Pattern C is chosen — assert no `unhandledRejection`
under a post-cap rejection.

## A2 — The AbortSignal clause is non-executable against the current providers (no receiver exists). (NEW — adversarial MEDIUM/integration)

N1 prescribes: "**Propagate cancellation where supported** — pass an `AbortSignal` into
`tp.evaluate()` so a timed-out CLI attempt is actually killed." Verified against the code:

- `IntelligenceOptions` (`types.ts:847-934`) has **no `signal`/`abortSignal` field** at all.
- `evaluate()` on every provider takes `(prompt, options?: IntelligenceOptions)` — there is no
  parameter to receive a signal, and `ClaudeCliIntelligenceProvider.evaluate` /
  `CodexCliIntelligenceProvider.evaluatePlain` both `execFile(...)` with **only** a `timeout:`
  option wired (`timeoutMs`), no `signal:` passed to `execFile`.

So "pass an AbortSignal into `tp.evaluate()`" is not a small wiring step — it requires (a) adding
`signal?: AbortSignal` to the shared `IntelligenceOptions` contract, (b) threading it through
`CircuitBreakingIntelligenceProvider.evaluate` (which constructs `innerOptions`) and
`AnthropicSubscriptionRouter`, and (c) wiring `execFile`'s `signal` option in BOTH CLI providers.
That is a **cross-cutting provider-contract change**, not the "ONE engine touch" §4.5 claims this
change to be. The spec hedges with "where supported" and "document which providers support
cancellation," but as it stands **zero** providers support it, so the honest current answer is
"cancellation is unsupported on every provider; every timed-out CLI attempt orphans to completion."
N1 should either (a) drop the AbortSignal clause to a tracked follow-up and state plainly that the
orphan-runs-to-completion path is the v1 behavior for ALL providers (the `execFile` `timeout:`
already bounds the subprocess's own lifetime independently — see A3), or (b) own that adding the
`signal` field to `IntelligenceOptions` + both CLI providers is in-scope, contradicting the
"ONE engine touch" claim. Today it reads as if a per-provider capability exists; none does.

## A3 — The subprocess-orphan worry is double-bounded; §4.5's framing overstates the residual. (NEW — adversarial LOW, precision)

N1 frames the racing timeout as leaving "a CLI **subprocess running** (quota/CPU/late-logs)" that
only an AbortSignal can kill. But both CLI providers already pass `timeout:` to `execFile`
(`ClaudeCli` = `options.timeoutMs ?? DEFAULT_TIMEOUT_MS`; `CodexCli` via its own exec path). The
subprocess is therefore **independently bounded by the provider's own execFile timeout**, which is
unaffected by the router's race. The true residual is: between the router's 5s cap firing and the
provider's (larger) execFile timeout firing, **one** extra CLI may keep running — bounded, per
swap attempt, breaker-capped, exactly as §4.5's last bullet already concedes. The "AbortSignal so
the subprocess is actually killed" clause is therefore an **optimization** (kill at 5s instead of
at the execFile timeout), NOT a safety necessity — the subprocess cannot leak unboundedly even
with zero cancellation support. This strengthens the A2 recommendation to demote AbortSignal to a
follow-up: nothing unsafe happens without it.

## A4 — N3 §6.4 "caller-handled" relabel is AIRTIGHT for the two cited callers. (verification — confirms, no change)

Verified the claim against code, both halves:

- `MessagingToneGate.parseResponse` (`MessagingToneGate.ts:627-646`): on no-JSON-match,
  non-boolean `pass`, or a JSON.parse throw → returns `failOpen = {pass:true,...}`. **Confirmed
  fail-open on malformed output.** Additionally `review()` (`:277-299`) validates `parsed.rule`
  against `VALID_RULES` (the B-id allowlist) and fail-opens (`invalidRule:true`) on an invented or
  empty rule, all inside an outer `try/catch` that fail-opens (`:308-318`). The §6.4 description
  matches the code exactly.
- `MessageSentinel` (`MessageSentinel.ts:558-598`): unparseable → `category:'normal',
  pass-through`; outer `catch` → `category:'normal', pass-through`. **Confirmed fail-open / never
  blocks on garbage.**

The relabel from "scoped OUT/deferred" to "CALLER-HANDLED" is justified by the actual fail-open
logic in both callers, and the residual is correctly identified as **well-formed-but-semantically-
wrong**, a provider-independent property of any LLM gate. **No overclaim.** (One pedantic note,
not a blocker: §6.4 says the residual is "not introduced here," which is true — but the default
policy DOES change the *base rate* of a semantically-wrong verdict, since a smaller/cheaper Codex
model may produce more semantically-wrong-but-well-formed verdicts than Claude did. That is a
quality shift, not a safety regression — the gate still fail-opens structurally — and §6.4's own
`<!-- tracked -->` swap-target-output-sanity follow-up already covers it. Worth a one-clause
acknowledgement that the *rate* of the residual is provider-sensitive even though the *handling*
is not.)

## A5 — Cap-dominates-rateLimitWait holds, but only if the cap RACES the whole evaluate() (incl. acquireOrWait). Confirmed; one ordering caveat. (verification — confirms with caveat)

`CircuitBreakingIntelligenceProvider.evaluate` (`:184-198`) calls `await
this.breaker.acquireOrWait(waitMs)` with `waitMs = options.rateLimitWaitMs` (≈120s) **before**
`this.inner.evaluate`. So the 120s wait happens INSIDE the single `tp.evaluate()` promise the
router races. N2's claim that a 5s outer cap racing `tp.evaluate()` abandons the rate-limit wait
at 5s is therefore **correct** — the cap sees the whole composite (acquireOrWait + inner call) as
one racer and times the entire thing out at 5s. **Caveat (NEW):** this only holds if §4.5 races the
cap against the *router's call to the wrapped provider* (the `CircuitBreakingIntelligenceProvider`
instance), which is what `resolveProvider(target)` returns. If a future refactor moved the cap
*inside* `CircuitBreakingIntelligenceProvider` (after acquireOrWait), the cap would no longer
dominate the 120s wait. The spec should pin "the cap wraps the resolved provider's `evaluate()` at
the router layer, OUTSIDE acquireOrWait" as the load-bearing placement — §4.5 implies it but never
states the layering invariant that makes the domination true. A unit test asserting "an attempt
internally waiting on rateLimitWaitMs is abandoned at the cap" (already listed in §7) will catch a
regression, but the invariant deserves one prose sentence so a refactor doesn't silently break it.

---

## Verdict

The three round-2 prescriptions are **substantially sound** — N3 (§6.4) is airtight (A4), the
cap-dominates-rateLimitWait interaction is correct (A5). But N1's orphan-safety prescription
contains a real **imprecision that can mislead the build**: its crash premise is true only for the
detached-handle shape (Pattern C) and FALSE for the `Promise.race` form that the codebase already
ships safely (A1), and its AbortSignal cancellation clause has **no receiver in any current
provider** and is mislabeled as a "where supported" capability when support is uniformly zero
(A2/A3). These are correctness-of-the-spec issues, not safety holes in the resulting feature
(every path still fail-opens/fail-closes correctly), but they would cause a builder to either add a
redundant guard or — following N1's literal mental model — adopt the one implementation shape that
actually crashes. **needs-changes** — primary reason: N1 must (a) scope the mandatory `.catch` to
the detached/cancellation implementation and bless the crash-safe `Promise.race` form explicitly,
and (b) demote AbortSignal cancellation to a tracked follow-up (no provider receives a signal
today) OR own the `IntelligenceOptions`+both-CLI-providers contract change it actually requires.
