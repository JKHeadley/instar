# Side-Effects Review — Tone-Gate Graceful Degradation (Postmortem F4)

**Version / slug:** `tone-gate-graceful-degradation`
**Date:** `2026-06-25`
**Author:** `Echo (instar-dev agent)`
**Second-pass reviewer:** `required (outbound block/allow decision + "gate") — verdict + resolution appended at the end`

## Summary of the change

`MessagingToneGate.review()` is the outbound block/allow authority on the Telegram
reply path. Its provider-exhaustion catch branch was **fail-CLOSED by default**:
when the LLM backend was unavailable (breaker-open / rate-limit / transport error),
it HELD every message unconditionally. Tonight that turned a `claude -p` rate-limit
into a multi-hour silent outbound outage — the user saw delivery receipts but no
replies. This change makes the outage path **degrade to an in-process deterministic
leak floor** (`detectGateSignals` B1–B7 + `detectInternalIdLeak`, both pre-existing
pure detectors): a clean message SENDS, a leaked artifact still HOLDS.

The same rate-limit outage has **two manifestations**, and this change covers BOTH:
the FAST throw (breaker open → `review()` rejects) degrades inside `review()`; the
SLOW stall (the gate waits up to 120s for a rate-limit window and overruns the
outbound route budget — the DOCUMENTED 2026-06-08 production failure) degrades at
the route seam in `reviewWithinBudget`, via the shared `buildDegradedToneResult`.
The capacity-shed (fork-bomb P3) path and the discipline-failure path are UNCHANGED.

Files: `src/core/MessagingToneGate.ts` (the shared `buildDegradedToneResult` +
`degradedToDeterministic` result flag + `DegradeReason`), `src/server/outboundGateBudget.ts`
(budget-timeout degrade callback), `src/server/routes.ts` (three-valued route disposition),
`tests/unit/MessagingToneGate.test.ts`, `tests/unit/spawn-cap-fail-closed-gates.test.ts`,
`tests/unit/outbound-gate-budget.test.ts`, plus the spec + ELI16 + this artifact.

## Decision-point inventory

- `MessagingToneGate.review()` provider-exhaustion catch branch — **modify** — was pure-hold; now degrades to the deterministic floor by default (clean sends, leak holds).
- `reviewWithinBudget` budget-timeout disposition (route seam) — **modify** — the slow-stall timeout was pure-hold (`GATE_TIMEOUT`) under the default; now degrades to the SAME floor by default (the slow sibling of the fast throw). Pure-hold/fail-open overrides still reachable.
- `MessagingToneGate.review()` capacity-shed branch (`isCapacityUnavailable`) — **pass-through** — still pure-hold (fork-bomb P3 invariant preserved).
- `MessagingToneGate.review()` discipline-failure branch (unparseable/contradictory after one re-prompt) — **pass-through** — still pure-hold (a model that produced an unusable verdict is not an infra outage).
- `messaging.toneGate.failClosedOnExhaustion` config flag — **modify** — was 2-valued (default-true hold / false open); now 3-valued (unset = degrade, true = pure-hold, false = open) on BOTH the throw and the budget-timeout paths.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

The change strictly REDUCES over-block on the provider-exhaustion path: messages
that were previously held during a backend outage now send if they carry no
deterministic leak. The only inputs still held on the degraded path are those
carrying a real B1–B7 artifact (a literal CLI command, file path, config key,
code block, API endpoint, env var, cron/slug) or a B20 internal-id leak — the
exact high-stakes content that must never escape. A message that legitimately
*discusses* such an artifact in prose (e.g. "I'll run the migration for you")
does NOT trip the detectors (verified by the GateSignalDetectors negative tests)
and sends normally.

---

## 2. Under-block

**What failure modes does this still miss?**

On the degraded path the behavioral rules (B11–B20 tone/self-stop/false-blocker/
parked-on-user/jargon) are NOT evaluated — they require LLM judgment that is, by
definition, unavailable during the outage that triggers this path. So during a
backend outage a slightly-off-tone or self-stop-shaped message could reach the
user unchecked. This is a deliberate, bounded trade: a leak (the dangerous class)
is still caught deterministically; a tone slip (the recoverable class) reaching
the user beats silence (the F4 goal). When the backend recovers, full LLM review
resumes automatically. Operators who want the strict behavior restore pure-hold
with `failClosedOnExhaustion: true`.

---

## 3. Level-of-abstraction fit

The degrade floor is the right layer: it REUSES the existing low-level
deterministic detectors (`detectGateSignals`, `detectInternalIdLeak`) that the
gate already calls to build its LLM prompt — it does not re-implement detection.
The authority (send/hold) stays where it belongs, inside `review()`. No higher
gate exists that should own this; `review()` IS the outbound authority. The
change feeds an existing primitive into an existing authority's fallback path —
no new abstraction introduced.

---

## 4. Signal vs authority compliance

**Required reference:** `docs/signal-vs-authority.md`

- [x] No — this change reuses EXISTING signal-producers (`detectGateSignals`,
  `detectInternalIdLeak`) feeding the EXISTING smart authority (`review()`). It
  adds no new brittle blocking check.

The deterministic detectors are pure signal-producers; the gate is the authority.
On the degraded path the authority consults those signals deterministically
(LLM unavailable) and fails CLOSED on any positive signal. This is the
signal-vs-authority pattern applied exactly as intended — the brittle detectors
never gained new authority; they inform a fallback disposition that defaults to
holding on any leak signal.

---

## 5. Interactions

- **Shadowing:** the degrade branch runs ONLY in the provider-exhaustion catch,
  after the LLM call throws. It cannot shadow the normal-verdict path (that path
  `return`s before the catch) or the capacity-shed branch (which `return`s first
  inside the catch). Ordering verified: capacity-shed check precedes the
  provider-error disposition.
- **Double-fire:** none — a single `review()` call returns exactly one
  disposition.
- **Races:** none — `review()` is a pure per-call function over its `text` +
  live-read config; it shares no mutable state with concurrent calls.
- **Feedback loops:** none — the floor reads the candidate text only; it does not
  feed any system that feeds back into the gate.
- The downstream retry path (`failClosedOnExhaustion` hold → queued for retry) is
  unchanged for the held cases; a now-SENT clean message simply skips that queue.

---

## 6. External surfaces

- **Other agents / users:** none directly. The install-base effect is the intended
  one: during a backend outage, outbound replies degrade-and-send instead of
  silently holding.
- **External systems (Telegram):** a clean message now reaches Telegram during an
  outage that previously held it. The held-leak case is byte-identical to before
  (still `pass:false`, queued for retry).
- **Persistent state:** none — no new state written.
- **Operator surface:** no NEW operator surface. The change extends the value
  semantics of the existing `messaging.toneGate.failClosedOnExhaustion` config
  flag (a config edit, already documented) — it adds the `unset = degrade`
  default and keeps `true`/`false` working. No new PIN-gated route or dashboard
  form.
- **Result shape:** adds an OPTIONAL `degradedToDeterministic?: boolean` to
  `ToneReviewResult`. Existing consumers that don't read it are unaffected (the
  `pass`/`rule`/`issue`/`failedClosed` contract is preserved).

---

## 6b. Operator-surface quality

No operator surface — not applicable. The change touches no dashboard renderer,
approval page, or grant/revoke/secret-drop form. The only operator-facing element
is the pre-existing `failClosedOnExhaustion` config flag (a JSON edit), whose
default and overrides are documented in the spec.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**machine-local BY DESIGN.** The tone gate is a pure, stateless, per-message
function evaluated on whichever machine is serving that outbound reply. It holds
no durable state, emits no cross-machine notice, and generates no URL. Given the
same candidate text + the same `failClosedOnExhaustion` config, the disposition
is identical on every machine — so there is nothing to replicate or proxy. It
does not strand on topic transfer (no state), needs no one-voice gating (it does
not itself emit a user notice; it gates the agent's own reply, which is already
single-voiced per topic), and creates no machine-bound link.

---

## 8. Rollback cost

Cheap and instant, two independent levers:
1. **Config (no deploy):** set `messaging.toneGate.failClosedOnExhaustion: true`
   to restore the exact legacy pure-hold behavior on the provider-error path.
   Read live per review — no restart.
2. **Code:** revert the single commit. The change is isolated to one method's
   catch branch + one shared helper + the route seam + one optional result field;
   no migration, no state, no schema. No data repair or agent-state repair needed.

---

## Phase 5 — Second-pass review (independent reviewer)

An independent reviewer subagent audited the change (code diff, `GateSignalDetectors`,
`internal-id-leak`, the artifact, both test files, and ran the suites).

**Verdict:** Concur with the core change — leak-safe, control-flow-correct, tests
honest — with ONE substantive concern.

- **Leak safety — PASS.** The degraded floor (B1–B7 + B20) is exactly the tone
  gate's high-stakes artifact-leak class; everything else is behavioral/tone
  (recoverable). Secrets/API-keys are redacted separately on BOTH paths (not a
  regression). The floor is strictly *stricter* than the LLM on the leak class
  (holds on any positive detection), so degrade can only over-hold, never
  under-send a leak.
- **Control flow — PASS.** Capacity-shed returns before the provider-error
  disposition; the degrade branch cannot be reached for a discipline failure
  (that path returns inside the `try`).
- **3-valued flag — PASS.** `true`→hold, `false`→open, `undefined`→degrade; a
  throwing config getter yields `{}`→`undefined`→degrade (safe default).
- **Tests — PASS.** Non-vacuous inputs; the override test holds a message that
  would otherwise send.

**Concern raised (resolved in this change):** the original revision fixed only the
provider-*throw* manifestation; the provider-*slow* (budget-timeout) sibling — the
DOCUMENTED 2026-06-08 production failure — still pure-held under the default, so
the F4 goal was only partially met and the artifact overstated the fix.

**Resolution:** rather than defer (no-deferrals standard), the slow path was closed
in this same change. `reviewWithinBudget` now takes a `budgetDegrade` callback; the
route passes it under the default disposition so a budget timeout degrades to the
SAME `buildDegradedToneResult` floor (clean sends, leak holds). Two new tests in
`outbound-gate-budget.test.ts` prove the slow-path clean-send and leak-hold. The
artifact summary + decision inventory above were corrected to describe both paths.
The reviewer's two minor notes (dead capacity-arm in the degrade helper; B12
health-jargon passing on degrade) were also addressed — the dead arm was removed in
the `buildDegradedToneResult` refactor, and the B12 behavioral drop is documented as
accepted in §2.
