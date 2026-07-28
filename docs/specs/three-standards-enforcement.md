---
title: "Enforcement of the Three Ratified Constitutional Standards (A/B/C)"
slug: "three-standards-enforcement"
author: "echo"
parent-principle: "Structure beats Willpower"
eli16-overview: "three-standards-enforcement.eli16.md"
status: "converged (2026-07-03 — internal 6-angle + external codex/gemini cross-model, 2 rounds; awaiting operator approval)"
tags: [review-convergence]
origin: "Topic 29723 (2026-07-03). Operator ratified three standards after the tiered-intelligence spec's machine-local-memory error survived 7 review rounds and only the operator caught it. This spec turns the ratified TEXTS into structure."
operator-gate: "The three standard TEXTS are already ratified (Justin, 2026-07-03 10:51 PDT). This spec covers only the ENFORCEMENT mechanisms — machinery, dark-first where it ships runtime code. No new constitutional text is minted here; the registry entries ship separately under the already-granted ratification."
---

# Spec — Enforcement of the Three Ratified Constitutional Standards

**Ships:** the structural teeth for three operator-ratified standards, so each is
*enforced* rather than *remembered*. **Honest framing (do not read "enforced" as "fully
deterministic today"):** what ships in THIS run is the `/spec-converge` review-ENFORCEMENT LENS +
the machine-checkable marker/field CONTRACTS + C's routing default & tests; the purely-deterministic
lint floors (A's marker lint, B's field-schema lint) land WITH the registry ship that carries each
standard's registered guard (hard-sequenced — see *Rollout*). Until then A/B are review-lens +
per-spec-gate authority, not a no-LLM guarantee. The three standards:

- **A — Always Multi-Machine:** the `/spec-converge` cross-machine reviewer check is
  upgraded from "a posture is *declared*" to "the default posture is `unified`; an
  undefended `machine-local` is a MATERIAL FINDING" (a closed justification taxonomy), plus
  a conformance-audit marker so an unjustified machine-local surface is a surfaced gap.
- **B — Self-Heal Before Notify:** a structural escalation-gate pattern (an operator-facing
  raise is unreachable before a bounded, audited self-heal is attempted and exhausted) plus
  a `/spec-converge` review-check that flags a watcher escalating on first detection.
- **C — Alerts-Topic Routing:** verify the topic-less-notice path routes to the one hub
  topic BY DEFAULT (not merely as a flood-guard fallback), and extend the burst-invariant
  test to assert it.

**Run boundary (Autonomy Principle 2):** the deliverable is the review-check upgrades
(A, B), the self-heal-gate PATTERN documented (B) — its application to the maturation watcher's
runtime code is a downstream build task, registered under *Close the Loop*, NOT built in this run —
and the routing-default verification + test (C). The standard TEXTS' registry entries ship under
the separate already-granted ratification; this spec mints no new constitutional text.

## Glossary (for a reader outside Instar)

- **`/spec-converge`** — Instar's spec-review pipeline: multiple internal LLM reviewers + real
  external cross-model reviewers iterate a design spec to convergence before any code is built.
- **hub topic** — the single always-present Telegram forum topic where topic-less / housekeeping
  notices land (this agent: 7848), instead of spawning a fresh topic per notice.
- **maturation watcher** — the background monitor that tracks features shipped "dark" (disabled)
  along their graduated-rollout track and surfaces ones ready to promote.
- **topic-less notice** — a user-facing notice that belongs to no existing conversation topic
  (e.g. a housekeeping alert), so it needs a routing home.
- **unified / machine-local** — a state surface either shared across all the agent's machines
  (unified) or deliberately kept on one machine (machine-local); this spec makes *unified* the
  default and *machine-local* a finding unless justified.
- **dark-first / graduated rollout** — new runtime code ships disabled (or dry-run) and is
  promoted by stages, so a change can't hit the whole fleet before it's proven.

## Problem statement

Three standards were ratified on 2026-07-03 because each named an expectation that lived in
prose and reviewer habit — willpower — where the Root (**Structure beats Willpower**) demands
structure. Each has a distinct enforcement gap:

1. **A — the `/spec-converge` "Cross-Machine Coherence" check accepts a *declaration*, not a
   *default*.** It verifies a feature declares a cross-machine posture and accepts
   "machine-local BY DESIGN" as a valid answer. So a WRONG posture (machine-local where
   unified was correct) passes by being declared. The tiered-intelligence consult-memory did
   exactly this and survived seven convergence rounds; only the operator caught it on read.
   The check tests for a declaration, not for the unified DEFAULT.

2. **B — nothing forbids a watcher from paging the operator on first detection.** The
   constitution holds *No Silent Degradation* (never swallow a failure) but that pushed some
   watchers toward escalating immediately. "Self-heal first, notify only on self-heal
   exhaustion" is a pattern no structure enforces; a new monitor can still be shaped to raise
   an operator item as its FIRST move.

3. **C — topic-less-notice routing to the hub is a flood-guard *fallback*, not the default.**
   `AttentionTopicGuard` + the `topicCreationBudget` ceiling bound the FLOOD, and the
   burst-invariant CI test proves the bound. But routing a topic-less notice to the one hub
   topic (this agent: 7848) is not asserted as the RULE — a path that mints a fresh topic for
   a topic-less notice is bounded, not closed. The 2026-05-22 sentinel flood and the
   2026-06-05 worktree-detector flood are the scars.

Each gap is the same shape: a check that measures the presence of an answer rather than the
correctness of the default, or a pattern with no gate. This spec closes all three.

## Program-shared posture (binding on A/B/C)

- **Signal + Authority, not new brittle authority.** A/B pair a cheap DETERMINISTIC signal (a
  machine-checkable `machine-local-justification:` marker for A; the required self-heal
  declaration fields for B — both conformance-gradeable) with the EXISTING full-context
  `/spec-converge` LLM reviewer that holds the semantic authority. They add a review lens + a
  deterministic floor, not a brittle string-matcher with blocking authority. This is the
  constitutional *Signal vs. Authority* / *Body and the Mind* split, and it is the direct answer
  to the round-1 external critique that "a review-check is just willpower." C's runtime change is
  a routing DEFAULT + test assertion over machinery that already exists; it introduces no new
  blocking gate.
- **Composes with *No Silent Degradation*.** B refines *to whom* a failure is reported
  (into the self-heal machinery, audited) — it never licenses swallowing. Every detection and
  heal attempt is audited; the operator is the last resort, not the silent-drop alternative.
- **Maturation posture — "dark-first" means LIVE ON DEV AGENTS, dark on the fleet (never globally
  disabled).** Per *Maturation Path — Every Feature Ships Enabled on Developer Agents*: most of this
  spec is NOT dark-gated at all — A/B are `/spec-converge` template/prompt changes that take effect
  on the next review run (no runtime flag), and C is a routing-default bug-fix + test (not a
  graduated-rollout feature). The ONLY graduated-rollout runtime code is the downstream
  maturation-watcher self-heal APPLICATION (deferral 2), and it ships ENABLED on development agents
  (dogfooding) + dark on the fleet — never a globally-disabled flag. No `DARK_GATE_EXCLUSIONS`
  carve-out is needed because nothing in THIS run's boundary is fleet-dark runtime code; the
  dev-live / fleet-dark posture binds the downstream watcher build.

## Standard A — reject undefended machine-local (the `/spec-converge` cross-machine check)

**Mechanism in plain language:** a spec must say, for each piece of state it adds, whether that
state is shared across the agent's machines or kept on one. "Shared" is the default; "kept on one"
is allowed only for a short list of concrete reasons (a login/key that physically lives on a disk,
hardware, or something the operator signed off on) and must say which. A cheap machine-checkable
tag records the claim; the smart reviewer judges whether the claim is actually true — in BOTH
directions (a credential wrongly declared "shared" is caught too).

**Where:** the "Cross-Machine Coherence — mandatory check" in `skills/spec-converge/SKILL.md`
(the integration-reviewer instruction) and its template
`skills/spec-converge/templates/reviewer-integration.md`. **These are built-in skill/template
files, so this change carries a Migration-Parity obligation:** existing agents receive it via the
idempotent `PostUpdateMigrator` entry specified in *Migration & loop-closure* (P3, case 5b — update
installed skill content); new agents get it via `init`. (Same obligation for Standard B's
review-check template edit.)

**Two-layer enforcement (Signal vs. Authority, deliberately).** Per the constitutional *Signal
vs. Authority* + *The Body and the Mind*: a cheap DETERMINISTIC layer emits the signal, the
full-context LLM reviewer holds the authority. Neither alone is the enforcement — together they
are, and this is the answer to "isn't a review-check just willpower?" (raised by both external
reviewers, round 1):
- **Deterministic signal (the marker).** A spec that introduces a machine-local state surface
  declares it with a machine-checkable `machine-local-justification: <taxonomy-key>` marker —
  designed so PRESENCE is parseable without an LLM. The no-LLM parse is DELIVERED by the static
  marker lint that ships with the registry PR; **until that lint lands, the per-spec
  `POST /spec/conformance-check` gate + the reviewer surface a missing marker** (see *The marker's
  location + parse contract* for the current-vs-future split; the standards-level
  `/conformance/coverage` grades only guard-exists-on-disk, not per-spec markers). This is the
  deterministic floor that front-runs the reviewer — once its lint lands.
- **LLM authority (the reviewer).** The `/spec-converge` integration reviewer judges the
  CORRECTNESS of the justification — the semantic call the marker cannot make. A marker whose key
  is present but substantively wrong is exactly what the reviewer must catch (see the live proof
  in *Multi-machine posture*, below, where this spec's OWN first draft mislabeled C).

**The upgrade (reviewer authority):**
1. The DEFAULT posture is `unified`. Every state surface a spec introduces is expected to be
   unified across the agent's machines (rides One Memory / stateSync / proxied-on-read) unless
   it carries an explicit `machine-local-justification:` naming a concrete reason from a
   **closed taxonomy**:
   - `physical-credential-locality` — a login / credential / key / service-binding physically
     lives on one disk (a Claude OAuth login, a browser profile's cookies, a Telegram bot token +
     the forum/topic ids that binding namespaces).
   - `hardware-bound-resource` — bound to specific physical hardware (a GPU, a local device, a
     machine-specific sensor).
   - `operator-ratified-exception` — the operator explicitly ratified a machine-local design for
     a named reason. **This key MUST cite a MACHINE-VERIFIABLE, existence-checkable artifact ref** —
     a commit SHA, a registry key, or a URL a CI job can confirm RESOLVES — not a bare topic+date
     (which nothing can mechanically check). Existence-checking is not content-verification (whether
     the ref actually says what's claimed stays with the reviewer/operator — *Know Your Principal*),
     but a ref that does not even resolve fails DETERMINISTICALLY, so the weakest "trust me, it was
     ratified" form is closed by construction (round-4 external finding, gemini). A bare claim with
     no resolvable ref is an unverified principal and the reviewer contests it as it would a
     fabricated approval.
2. A bare "machine-local BY DESIGN" with no taxonomy-jailed justification is a **MATERIAL
   FINDING** — the reviewer must raise it, exactly as the decision-completeness reviewer
   contests a cheap tag. The reviewer INDEPENDENTLY contests the justification (a justification
   that names the taxonomy key but is substantively wrong is still a finding — the marker's
   PRESENCE never satisfies the CORRECTNESS check).
3. Absence of any posture declaration defaults to `unified`-required (a silent single-machine
   assumption is the defect the check exists to catch).
4. The check is **bidirectional**. Just as an undefended `machine-local` is a finding, an
   **infeasible `unified`** posture is one too: a surface that is inherently credential/hardware-
   bound (a login, a bot-token-namespaced topic id, a hardware key) but declared — or left to
   default — `unified` is a MATERIAL FINDING, because "just claim unified" would otherwise be the
   trivial way to dodge the machine-local scrutiny entirely (and, worse, invites an unsafe attempt
   to replicate a credential). Neither direction is taken at face value: the reviewer judges
   whether the DECLARED posture is the CORRECT one for the surface.

**The marker's location + parse contract (the deterministic floor, made concrete).** The
`machine-local-justification: <taxonomy-key>` marker is a single labeled line inside the spec's
`## Multi-machine posture` section — one line per machine-local surface, `key` drawn from the
closed taxonomy. This fixed location + `key: value` shape is what makes PRESENCE machine-checkable
without an LLM. **Two DISTINCT conformance surfaces (a round-1 conflation, corrected):**
- **Per-spec grade** — **Today:** the **per-spec** `POST /spec/conformance-check` gate (an
  LLM-backed constitutional read that already runs each `/spec-converge` round) + the reviewer
  surface a spec that flags a surface machine-local without a taxonomy-keyed marker — the
  reviewer-plus-existing-wiring path, NOT yet a deterministic parse. **Registry PR (future):** adds
  the static marker LINT (a no-LLM parser) that `/spec/conformance-check` uses to grade PRESENCE
  deterministically. The spec must not claim the no-LLM deterministic parse exists before that lint
  ships (round-4 external finding, codex).
- **Standards-level grade** — `GET /conformance/coverage` grades only that the STANDARD's named
  structural guard *exists on disk* (guard-exists), per its documented contract; it does NOT scan
  individual specs. Citing it as the per-spec marker grader was wrong.

**Honest scope of THIS run (Signal vs. Authority — the LLM is a semantic AUDIT, not the sole
enforcement).** Both external reviewers (round 1) pressed that the hard calls still rest on LLM
judgment. This run ships (a) the LLM review-LENS (semantic authority, live on the next review run)
and (b) the marker CONVENTION above. The purely-deterministic floor — a static lint that FAILS a
spec whose machine-local surface lacks a well-formed marker, plus fixtures of rejected examples —
lands with the registry ship (the standard's registered guard), NOT in this run. **Ordering
dependency (honest):** until that lands, the marker is graded by the per-spec gate + the reviewer,
and the LLM read is a semantic audit layered over that floor, never the sole guard; the
deterministic marker lint's grade is inert until the registry ship. This spec's PR names the
dependency so the two ships don't silently diverge.

**Why the taxonomy stays closed (Q1 resolved).** The three keys are NOT claimed to be a
*naturally complete* enumeration of every reason a system might keep state local — round-1
external review (codex) rightly flagged "exhaustive" as overclaiming. They are a **deliberately-
closed ALLOWED set**, and closing it is the point. The common architectural locality reasons an
author would reach for — availability / partition tolerance, a privacy / data-residency boundary,
a cost / latency envelope, an "intentional per-machine cache" — are **DENIED by default**, not
folded in as if they were naturally covered: each is either (a) not a *legitimate* locality
requirement (a derivable per-machine cache is unifiable, so it is not a real exception; an
availability / latency preference is an optimization, not a locality *requirement*) or (b) a
*policy the operator must ratify* (`operator-ratified-exception`, with the policy cited — a
data-residency / legal constraint is exactly this). The standard intentionally routes these
through operator sign-off rather than pretending the three keys cover them; making the operator
the gate for a fourth reason is the deliberate friction that keeps the escape hatch from widening
on author convenience. A fourth key is therefore a constitution-bound operator decision — never
an author's convenience.

**Watch the escape hatch (round-3 external finding, gemini).** The risk of a closed taxonomy is
the inverse: `operator-ratified-exception` becoming a de-facto catch-all that quietly hollows the
standard. So its usage is MONITORED — the conformance audit counts how often it is invoked, and a
dominant / rising rate is itself a surfaced signal (not silent) that the taxonomy needs an operator
revisit (either the real reasons deserve a named key, or authors are over-reaching the hatch).
"Track the escape hatch's frequency" is the standard watching ITSELF erode — Close-the-Loop
applied to A's own exception surface. **Proactive control too (round-5 external finding, gemini):**
the frequency audit is reactive, so EACH use of `operator-ratified-exception` ALSO raises a
non-blocking, high-priority notification for immediate operator visibility — the hatch can't quietly
become the path of least resistance between periodic audits.

**Regulatory / data-residency locality is DELIBERATELY operator-ratified, not a 4th key (round-1/5
external finding, codex).** A privacy / data-residency / regulatory-compliance driver is routed
through `operator-ratified-exception` ON PURPOSE, not as convenience: a compliance obligation is
exactly the kind of policy that must be operator-OWNED and CITED (with a resolvable ref), never
author-asserted — so making the operator ratify it is the correct control, not audit noise to
engineer away. Whether such cases deserve a first-class `policy-or-regulatory-locality` key is
itself a 4th-key decision, which this spec has NO authority to mint — it is constitution-bound
(operator sign-off). The proactive notification above ensures a genuine regulatory case gets
immediate operator eyes rather than hiding in the exception bucket.

**Scope of the guarantee (honest).** This catches machine-local surfaces in NEW specs going
through spec-converge. EXISTING machine-local surfaces are swept by the feature-maturation
audit (a separate task) — the audit inventories them and each gets a unify-or-justify
disposition. This spec does not retroactively re-audit shipped surfaces.

## Standard B — self-heal-before-notify (escalation-gate pattern + review-check)

**Mechanism in plain language:** a watchdog is not allowed to ping the operator the instant it
sees a problem. First it must try a bounded, logged self-repair; only when that repair genuinely
runs out of road does the operator hear about it — EXCEPT for data-loss / security problems, which
always alert immediately while repair runs. Every attempt is logged, so nothing is ever swallowed;
a repair that keeps failing over and over auto-escalates on its own; and a recoverable problem has
a hard time ceiling past which the operator is told even if repair is still trying.

**The pattern (structural, since a pure design pattern can't be fully lint-enforced):**
A monitor's operator-facing attention-raise is DOWNSTREAM of a `selfHealAttempted &&
selfHealExhausted` signal — the escalation path is not reachable on first detection. The
watcher shape is: `detect → attempt bounded self-heal (re-register / restart / re-deliver) →
on exhaustion, raise ONE deduped item`. This is already realized in the tiered-intelligence
watcher-for-the-watcher (§14) and is the reference implementation.

**The self-heal step must itself carry P19 brakes (bounded — not decorative).** A "bounded"
self-heal that is not actually bounded is the failure the pattern would otherwise invite (both
external reviewers, round 1). Per *No Unbounded Loops* (P19), a declared self-heal MUST name its:
`max-attempts`, `max-wall-clock`, `backoff`, `dedupe-key`, `breaker` (stop-and-surface after
sustained failure — INCLUDING flapping: N heals of the same break within a window auto-escalate,
see the severity carve-out below), `max-notification-latency` (the recoverable-watcher visibility
ceiling — see Backstop 1), `audit-location` (a scrubbed, metadata-only trail — never raw secrets,
consistent with Instar's other audit surfaces), and — the deterministic anti-no-op signal —
`remediation-actions`: the concrete operations the heal invokes (e.g. `re-register-flag`,
`restart-tracker`, `re-deliver-report`). Listing the intended actions makes "did this heal
actually DO something?" machine-inspectable, so the reviewer's substance judgment becomes a
semantic AUDIT over a deterministic floor rather than the sole guard (the direct answer to both
externals' "still leans on LLM judgment" finding, round 1). **Idempotency + partial-execution
safety (round-5 external finding, codex):** any `remediation-action` with a nontrivial side effect
MUST declare an idempotency key/guard AND its compensation/rollback behavior — because a self-heal
retried over a HALF-completed action is exactly how these loops corrupt state (duplicate
registrations, duplicate notifications, a torn write). A side-effecting remediation-action with no
declared idempotency guard is a MATERIAL FINDING. The review-check requires these fields
to be present — a self-heal that omits them is a MATERIAL FINDING, because an unbounded or no-op
"heal" is exactly the compounding-loop / silent-swallow failure P19 and *No Silent Degradation*
exist to forbid.

**Two anti-gaming teeth (adversarial):** the escalation-gate must never become a swallow.
- **No fake self-heal.** The declared self-heal must do SUBSTANTIVE remediation (re-register /
  restart / re-deliver), and its `remediation-actions` field must name the concrete operations it
  invokes — a no-op that merely sets `selfHealAttempted = true` to unlock the escalation path is a
  MATERIAL FINDING. The `remediation-actions` list is the deterministic floor; the reviewer's
  substance call is the semantic audit over it, judging substance against the declared actions —
  not the bare flag.
- **Exhaustion must be REACHABLE.** A self-heal whose exhaustion can never fire (infinite
  retries, no breaker) never notifies — that is *No Silent Degradation* violated through the back
  door: the failure is silently absorbed forever. The P19 `breaker` + `max-attempts` above make
  exhaustion reachable BY CONSTRUCTION, so the operator is always eventually told.

**Severity carve-out (composition with *No Silent Degradation*, made precise).** Self-heal-
before-notify governs RECOVERABLE, noisy watchers — it is never a gag on a critical alert. The
carve-out has ONE static-declaration part and TWO structural backstops; the backstops are runtime
behavior an author's label can never waive (this is the direct fix for both externals' "recoverable
can be misclassified optimistically" finding, round 1):

- **Static severity class (declared AND contested).** Each degradation a watcher reports declares
  its class. An **irreversible / data-loss / security-class** degradation escalates IMMEDIATELY and
  self-heals CONCURRENTLY (notify-and-heal, never heal-then-maybe-notify — the operator must know
  now, even while repair runs). Everything else is `recoverable`. **The reviewer INDEPENDENTLY
  CONTESTS the class**, exactly as Standard A contests a machine-local justification: a
  data-loss / security degradation mislabeled `recoverable` to unlock the heal-first path is a
  MATERIAL FINDING — the PRESENCE of a class field never satisfies the CORRECTNESS check. This is
  the anti-gaming tooth symmetric to A's marker-correctness rule.
- **Backstop 1 — a bounded visibility window (`max-notification-latency`).** A `recoverable`
  watcher MUST declare a `max-notification-latency`: the ceiling past which the operator is told
  EVEN IF self-heal is still running (a low-noise "self-heal in progress" observability line, not
  silence). This closes the failure both external reviewers raised — a self-heal quietly consuming
  the entire visibility window while the operator stays unaware is itself *No Silent Degradation*
  violated. A missing `max-notification-latency` on a recoverable watcher is a MATERIAL FINDING.
  **Operational bounds (round-2 external finding, codex):** `max-notification-latency` MUST be an
  explicit duration WITH units (e.g. `120s`), never a bare number or an adjective, and MUST NOT
  exceed the standard's default recoverable-latency CEILING (the registry entry sets the
  constitutional ceiling; a watcher needing longer escalates instead of extending the window).
  And "escalates IMMEDIATELY" for the critical class means on the SAME detection tick — no
  heal-gate delay interposed — not merely "soon." These bounds make the timing reviewer-enforceable
  rather than intent-judged. **Ceiling ownership + a concrete value (round-3/4 external finding,
  codex):** the constitutional ceiling lives at a NAMED durable registry key —
  `standards.selfHealBeforeNotify.recoverableLatencyCeiling` — carried by the standard's registry
  entry, with a PROPOSED initial value of `300s` (5 min); the registry PR cites the final value in
  the implementation checklist so a builder can evaluate expected behavior from that key rather than
  guess. If the key is absent or non-numeric when a watcher ships, the watcher's PR is BLOCKED on it
  (the same hard-sequencing as A/B's deterministic floors) rather than defaulting to an unbounded
  window — a missing ceiling fails CLOSED (escalate-sooner), never open.
- **Backstop 2 — mandatory flapping detection (structural, not a declared class).** Flapping —
  heal-then-re-break repeatedly — is NOT a class an author declares; it is a runtime property the
  P19 `breaker` MUST detect: N heals of the same break within a window auto-reclassify the
  degradation to critical and escalate. Per *Distrust Temporary Success* (P14) the recurrence IS
  the signal; a watcher silently re-healing a recurring break is hiding a root cause. Because this
  is realized by the mandatory P19 breaker, it cannot be waived by a "recoverable" label — it is
  the structural backstop that catches every miscategorization the reviewer's contest misses.

The review-check requires a spec's watcher to state the static class of each degradation AND to
carry both backstops, so "self-heal first" can never be stretched to muffle an alert that should
have fired on detection.

**The review-check (`/spec-converge` integration reviewer):** a spec that adds a
monitor/watcher which raises operator notices MUST declare (a) its self-heal step and its
`remediation-actions` (each side-effecting one carrying an idempotency guard + compensation),
(b) that step's P19 brakes (incl. `max-notification-latency` + a flapping breaker), and (c) the
severity class of each degradation it reports — which the reviewer CONTESTS for correctness, not
mere presence. A first-detection escalation on a RECOVERABLE degradation is a
MATERIAL FINDING; so is a heal without brakes, a no-op heal (no substantive `remediation-actions`),
an unreachable exhaustion, a missing `max-notification-latency`, or a mislabeled severity class.
The check names the composition with *No Silent Degradation* explicitly so a reviewer does not
mistake "route to self-heal" for "swallow": every detection + heal attempt is audited; the audit
trail is the report. **Scope (Q2 resolved):** the
check binds a *monitor/watcher or any recurring/automated notice source*, NOT a one-shot
user-reply — a single conversational reply is not a watcher and does not pay the self-heal cost.

**A deterministic floor (Signal vs. Authority).** Like A, B is registered in
`docs/STANDARDS-REGISTRY.md` with a conformance-gradeable guard (the required self-heal
declaration fields above) so the constitution can grade their PRESENCE; the LLM reviewer remains
the authority on whether a declared self-heal is SUBSTANTIVE. The review-check is the mind; the
registry marker is the body's cheap signal.

**Applied surface — reference exemplar, downstream build (scope, resolved).** The maturation
watcher is this pattern's worked example: its watcher-for-the-watcher self-heals (re-register a
live-but-unregistered flag, restart a stalled tracker, re-deliver a dropped report) before it ever
raises the one operator item — under declared P19 brakes, `remediation-actions`,
`max-notification-latency`, and stated severity classes. **This run ships the PATTERN + the
review-check, NOT the watcher's implementation:** applying the gate to the maturation watcher's
runtime code is a downstream build task, registered under *Close the Loop* (see *Migration &
loop-closure*) with a concrete id, not built here. The earlier "(a separate task)" notes meant
exactly this; the run boundary is corrected to match — the deliverable is the pattern + review
lens, the code application follows.

**Anti-drift — one shared gate, not N re-implementations (round-2 external finding, codex).** A
per-watcher hand-rolled escalation gate invites drift (one watcher's "exhaustion" is another's
infinite retry). The FIRST runtime application (the downstream maturation-watcher build) MUST
extract the pattern into a reusable `SelfHealGate` helper/interface AND a shared conformance
fixture that proves, for ANY watcher wired through it, that (i) the operator-raise is UNREACHABLE
before `selfHealAttempted && selfHealExhausted`, AND (ii) the declared `remediation-actions`
produced OBSERVABLE evidence — a real state transition or command invocation, not merely the
action NAMES (round-3 external finding, codex: a plausible-but-ineffective action list must not
pass the fixture). **The fixture must exercise the COMPLEX STATEFUL behaviors explicitly
(round-5 external finding, gemini)** — flapping detection (auto-escalate after N heals in the
window) and the `max-notification-latency` backstop firing while a heal is still running — not
merely the static unreachable-before-exhaustion invariant; those stateful paths are where an
in-process gate is hardest to get right. Subsequent watchers inherit the gate + the fixture rather
than re-implementing the shape. This requirement is carried in the downstream build task's
ship criteria (see *Migration & loop-closure*, deferral 2), not built in this run — but it is named
here so the pattern converges on ONE gate, not many.

**Build-vs-buy (round-3 external finding, gemini).** `SelfHealGate` is deliberately a THIN
declaration + assertion layer over Instar's EXISTING in-process primitives (the P19 breaker family
— CrashLoopPauser and the breakers already threaded through the monitors), NOT a new workflow
engine. A stateful external workflow server (Temporal, Camunda) is the wrong tool here: it adds a
heavyweight infra dependency + out-of-process state for what is a single in-process monitor's
BOUNDED self-heal, contradicting Instar's file-based-state / no-heavy-dependency design decisions.
The gate reuses the breaker/backoff/dedupe primitives the codebase already has; it does not
reimplement a distributed retry engine. **Inventory-then-adapt (round-4 external finding, codex):**
because the required semantics are extensive (retries, wall-clock, backoff, dedupe, breaker,
flapping window, latency ceiling, audit, severity reclassification, observable-remediation
evidence), the downstream task MUST first INVENTORY which of these existing primitives already
provide, and `SelfHealGate` may only ADAPT them — reimplementing a piece an existing primitive
already covers is itself a MATERIAL FINDING in that task's review. "Thin helper" is a hard
requirement, not an aspiration. **Pause-and-respec escape valve (round-5 external finding,
codex):** if that inventory shows the existing primitives do NOT compose to cover most of the
required semantics, the downstream task PAUSES and re-specs — it does NOT quietly grow an accidental
bespoke workflow engine under the "thin helper" label. Discovering the primitives don't compose is a
respec trigger, not a licence to build the engine anyway.

## Standard C — alerts-topic routing default (verify + test)

**Mechanism in plain language:** a notice that belongs to no conversation goes to the one alerts
hub BY DEFAULT — that is the rule, not a lucky side-effect of the flood-guard. A test proves stray
notices land in the hub instead of spawning a fresh topic each time.

**Mostly EXISTS; this closes the default and proves it.**
1. **Keep (existing):** `AttentionTopicGuard` (per-source + global budget; coalesces overflow
   into one notices topic), the `topicCreationBudget` ceiling inside `createForumTopic`
   (origin-typed, auto-by-default), the burst-invariant CI test
   (`tests/integration/notification-flood-burst-invariant.test.ts`), and the funnel lint
   (`scripts/lint-no-unfunneled-topic-creation.js`).
2. **The addition — the default:** a user-facing notice with NO owning conversation topic
   ROUTES to the one alerts/hub topic by DEFAULT — the RULE, not a fallback the flood-guard happens
   to reach. Verify the messaging layer's topic-less-notice path targets the hub; if any path can
   still mint a new topic for a topic-less notice, close it. **Binding semantics (round-4 external
   finding, codex):** the hub topic id (this agent: `7848`) is an EXAMPLE / current-agent value —
   the code MUST resolve it from the per-agent Telegram binding config, NEVER bake `7848` as a
   universal constant. This is required for consistency with C's own posture: the hub topic is
   `physical-credential-locality` (per-machine, bot-token-namespaced), so a hard-coded id would be
   wrong on every other agent/machine.
3. **Enforcement:** extend the burst-invariant test to assert topic-less notices land in the
   hub, not new topics. The funnel lint already refuses raw topic creation outside the
   budgeted funnel. **Plus a table-driven routing CONTRACT test (round-5 external finding,
   codex):** one extended burst test can miss direct adapter calls, legacy topic-creation paths,
   or future notice sources — so add a table-driven contract test AT THE ADAPTER/FUNNEL BOUNDARY
   covering the enumerated cases: topic-less non-critical → hub, HIGH/URGENT → own individual
   topic (carve-out preserved), existing-owning-topic → that topic, and misconfigured/unresolvable
   hub → a safe fallback (never a silent new-topic mint). The contract test proves the ROUTING
   RULE, not just the flood bound.

**Why the hub-topic default now, not a shared alert-event source today (alternatives considered —
round-2 external finding, codex).** The simpler industrial pattern — canonical alert EVENTS in one
shared queue/log with Telegram as a pure delivery adapter — is not skipped; it is ALREADY THE SHAPE
for the class that matters: HIGH/URGENT alerts ride the pooled attention QUEUE (a shared,
pool-readable alert-event source), and this spec builds ON that rather than around it. What is
deferred is ONLY the unified Telegram PUSH adapter OVER that shared source (deferral 3) — a
delivery-fabric build, not a re-plumb of where alert events live. The per-machine housekeeping hub
default is preferable NOW because it ships as a routing default + test over machinery that already
exists (zero new fabric), while the push adapter is a genuinely new cross-machine surface that
earns its own scoped build. This is an explicit choice, not an oversight.

**Ship criterion — no miscite (round-3 external finding, codex).** C's PR states explicitly that
hub routing covers ONLY non-critical topic-less notices and MUST NOT be cited anywhere as
satisfying CRITICAL-alert reachability — that guarantee is the pooled attention queue's (read) and,
for Telegram push, the deferred unified stream's (deferral 3). The read-path/push-path split is a
named transitional state, not a closed critical-alert guarantee; conflating them in any doc or PR
description fails the ship.

## Decision points touched

- `/spec-converge` integration-reviewer verdicts (A, B) — a review LENS on a smart reviewer,
  not a new blocking gate. It raises MATERIAL FINDINGS; the human/operator still decides.
- The topic-creation path (C) — a routing default over existing budgeted machinery; no new
  block, and HIGH/URGENT items keep their existing individual-topic carve-out.

## Config & posture

- A, B review-checks: `/spec-converge` template/prompt changes; effective on the next review
  run. No runtime flag.
- B self-heal-gate applied to a watcher: rides that watcher's existing dark/dry-run flag
  (graduated rollout). No new global switch.
- C routing verification: no new config; the change (if any path is found minting topics) is a
  bug-fix to route to the hub default, covered by the extended burst-invariant test.

## Migration & loop-closure

**Migration Parity (P3) — the review-check upgrades must reach EXISTING agents.** A/B change
built-in skill content (`skills/spec-converge/SKILL.md` + `templates/reviewer-integration.md`).
`installBuiltinSkills()` is non-destructive (it never overwrites an installed SKILL.md), so a new
agent gets the upgrade via `init` but an ALREADY-INSTALLED agent would silently keep the old
review-checks — the exact "new-agent-only feature" the Migration Parity standard defines as
broken. Per that standard (built-in-skill *content* update → case 5b): this spec's PR ships an
idempotent `PostUpdateMigrator` entry (scoped to the spec-converge default-skill allowlist) that
patches the installed SKILL.md + template to the upgraded review-check text — the same shape as
`migrateSkillPortHardcoding()`. C is a runtime bug-fix + test in `src/` / `tests/`, propagated by
the normal server auto-update — no skill migration needed. (This closes the round-1
Standards-Conformance-gate *Migration Parity* finding.)

**Close the Loop / Deferral = Deletion — the deferrals are registered with CONCRETE IDs, not
prose.** The *No Deferrals* / *Deferral = Deletion* standard forbids a SILENT drop, not a bounded,
tracked scope boundary: a deferral REGISTERED with a durable cadence + a concrete id, re-surfaced
until closed, is the COMPLIANT form (precisely what *Close the Loop* prescribes). Three items are
legitimately out of this run's boundary; per that standard each gets a durable cadence AND a
concrete durable identifier that the PR MUST cite in its ship criteria (a commitment id and/or a
maturation-track ref — never a bare "tracked follow-up"). A deferral without a cited id fails the
ship (round-1 external finding, codex #5):
1. the **existing-machine-local-surface sweep** (the feature-maturation audit that inventories
   already-shipped surfaces + gives each a unify-or-justify disposition) — filed to the maturation
   track; ship criterion: cite the maturation-track ref.
2. the **maturation-watcher self-heal APPLICATION** (Standard B's pattern applied to the watcher's
   runtime code, per *Standard B → Applied surface*) — filed as a build task; ship criterion: cite
   the commitment/task id.
3. the **fully-unified single Telegram alerts stream** (Q3's residual, now framed as a
   Telegram-first critical-alert-push gap, not UX) — filed as a commitment under the
   multi-machine-seamlessness track; ship criterion: cite the commitment id.
Each is recorded with a re-surfacing cadence at this spec's ship, closing the round-1
Standards-Conformance-gate *Close the Loop* finding. The concrete ids are registered and cited in
the landing PR's ship-criteria checklist BEFORE merge approval — a PRE-merge gate, not a
post-merge planning step (round-2 external finding, codex): a reviewer approving the merge sees the
real ids, never a placeholder. Id-cited-pre-merge, or the ship fails.

## Multi-machine posture (Cross-Machine Coherence — Q7, applied to this spec itself)

- A's check upgrade lives in `/spec-converge` templates + SKILL.md — **replicated** via git like
  all skills; machine-agnostic. (Existing agents receive the changed skill content via the
  migration in *Migration & loop-closure*, above — replication of the file is not the same as an
  already-running agent picking it up.)
- B's pattern is documentation + a per-watcher code shape; each watcher declares its OWN
  posture (the maturation watcher's is specified in its task). No new cross-machine state.
- **C's hub — the taxonomy-key correction (a live proof of A's teeth).** This spec's FIRST draft
  justified C's per-machine hub as `hardware-bound-resource`. That is WRONG — a Telegram forum +
  its topic ids are not bound to *hardware*, they are namespaced by the machine's **bot token +
  forum binding**, a per-disk service credential. The correct key is
  **`physical-credential-locality`**. Round-1 external review (codex) flagged exactly this
  mislabel, and A's own rule ("a justification that names the taxonomy key but is substantively
  wrong is still a finding") is what catches it — so this correction is the standard being
  enforced against the very spec that introduces it. The hub **TOPIC** is legitimately
  machine-local under the corrected key.
- **C's operator VIEW — the acute guarantee vs. the residual gap (Q3 resolved, sharpened).** The
  hub *topic id* being per-machine does NOT make the operator's alerts EXPERIENCE machine-local for
  the class that matters — but the closure is narrower than "it's fine," and round-1 external
  review (codex) was right to press it. Precisely:
  - **What IS closed (the acute miss-risk):** HIGH/URGENT notices route through the attention
    queue, which exposes a cross-machine merged READ (`GET /attention?scope=pool`) — so a critical
    alert raised on ANY machine is pool-visible from any machine, and "what needs my attention?" is
    answered pool-wide. The authoritative critical-alert surface is the (pooled) attention queue,
    not a hub topic.
  - **The residual gap (named, not waved):** a merged READ is not a PUSH. A Telegram-first operator
    who waits to be buzzed still receives a critical item's Telegram notification on the RAISING
    machine's surface; pool-visibility helps only when they go LOOK. So for a purely Telegram-push-
    driven operator, critical-alert delivery is still machine-scoped at the push layer. That is a
    **reachability** concern (*The Agent Is Always Reachable*), not a cosmetic UX preference — so
    the fully-unified *single Telegram alerts stream* follow-up is **elevated from "UX improvement"
    to "closes a Telegram-first critical-alert-push gap,"** and carries that framing (and priority)
    into its Close-the-Loop registration. It remains out of THIS run's boundary (this spec ships the
    housekeeping-hub routing default + test, not a new cross-machine push fabric), but it is not
    dismissed as taste.
  - Only NON-critical housekeeping hub notices are intentionally left machine-local (a per-machine
    record the operator browses, never a missed alarm).

## Rollout / build sequencing

1. Registry + lessons entries (separate Tier-1 ship, in flight) — the standard TEXTS.
2. **Standard A** review-check upgrade (integration-reviewer template + SKILL.md) — smallest,
   highest-leverage (prevents the exact recurrence). Its own PR.
3. **Standard B** watcher self-heal-gate pattern + review-check. Its own PR.
4. **Standard C** routing-default verification + burst-invariant test extension (mostly
   verification of existing machinery). Its own PR (Tier-1-eligible if it is purely a test +
   a verified-already-correct default).

Each a focused PR against canonical; no batching.

**Hard sequencing dependency — no overclaim (round-2 external finding, codex).** Until the
deterministic floors actually exist on disk, A/B enforcement is the per-spec `/spec/conformance-
check` gate + the LLM review-lens (a semantic AUDIT), NOT a deterministic guarantee — and the PRs
must SAY so rather than read as if the floor is already live. Concretely: the deterministic marker
lint (A) + the self-heal-field schema lint (B) are HARD-sequenced against the registry ship that
carries each standard's registered guard — item 2/3's PR either (i) includes the static lint +
rejected-example fixtures, or (ii) explicitly declares itself blocked-on the registry guard and
ships review-lens-only WITH that stated in the PR body (never silently). A review-check PR that
ships claiming "enforced" while its deterministic floor is still pending fails its own honesty /
Migration-Parity check. This is the direct answer to the round-2 meta-critique: "deterministic
floors" must never be described as present before they exist.

## Implementation checklist (per standard — concrete files, fields, tests, pass/fail)

A jargon-free builder's contract (round-3 external finding, codex + gemini: reduce reliance on
constitutional terminology / cognitive overhead). This checklist + each standard's *Mechanism in
plain language* line + the `.eli16.md` companion together ARE the author's golden path: a builder
can satisfy each standard from these three without tracing the full constitutional derivation. Each
row is a ship gate; where a deterministic floor is not yet on disk, the honesty clause in *Rollout →
Hard sequencing dependency* applies.

**A — reject undefended machine-local**
- Files: `skills/spec-converge/SKILL.md` (integration-reviewer instruction) + `skills/spec-converge/templates/reviewer-integration.md`; existing-agent reach via a `PostUpdateMigrator` entry (see *Migration & loop-closure*).
- Field/convention: a `machine-local-justification: <key>` line in a spec's `## Multi-machine posture`, `<key>` ∈ {`physical-credential-locality`, `hardware-bound-resource`, `operator-ratified-exception`}.
- Grade: per-spec `POST /spec/conformance-check` (marker PRESENCE) + the reviewer (CORRECTNESS, bidirectional).
- Pass/fail: a spec with an undefended `machine-local` OR an infeasible `unified` FAILS; a well-keyed, correct justification PASSES. The deterministic marker lint + rejected-example fixtures land with the registry ship (hard-sequenced).

**B — self-heal before notify**
- Files: `skills/spec-converge` reviewer template (the review-check); downstream build: a reusable `SelfHealGate` + shared fixture (the maturation-watcher application, deferral 2).
- Fields a watcher declares: `max-attempts`, `max-wall-clock`, `backoff`, `dedupe-key`, `breaker` (incl. flapping), `max-notification-latency` (units + ≤ registry ceiling), `audit-location` (scrubbed), `remediation-actions` (each side-effecting one with an idempotency guard + compensation), severity `class`.
- Pass/fail: a first-detection escalation on a `recoverable` degradation, a heal with absent brakes, a no-op `remediation-actions`, a side-effecting action with no idempotency guard, a missing/unitless `max-notification-latency`, or a critical-as-`recoverable` mislabel FAILS. The `SelfHealGate` fixture asserts the operator-raise is unreachable before exhaustion, that remediation produced observable evidence, and that flapping-detection + the latency backstop fire.

**C — alerts-topic routing default**
- Files: the messaging topic-less-notice path (`TelegramAdapter`), `tests/integration/notification-flood-burst-invariant.test.ts` (extend), `scripts/lint-no-unfunneled-topic-creation.js` (existing).
- Rule: a topic-less notice routes to the hub (7848) BY DEFAULT; HIGH/URGENT keep individual topics.
- Pass/fail: the extended burst-invariant test FAILS if a topic-less notice mints a new topic instead of landing in the hub. Ship criterion: hub routing is documented as non-critical-only and never cited as critical-alert reachability.

## Frontloaded Decisions

The three round-1 open questions are resolved here (Autonomy Principle 2 — no live user-decision
survives convergence). None is cheap-to-change-after: each fixes a semantic contract, an
escape-hatch surface, or a user-visible interface.

1. **A's taxonomy is a deliberately-CLOSED allowed set; a fourth key is an operator decision.**
   [resolved in *Standard A → Why the taxonomy stays closed*] The three keys are a closed ALLOWED
   set for this standard — NOT a claim they naturally exhaust every locality reason (the "exhaustive"
   overclaim is corrected). Other locality reasons (availability, privacy/residency, cost/latency,
   per-machine cache) are DENIED by default: each is either not a real locality requirement or
   requires an `operator-ratified-exception` (a constitutional amendment to widen the set).
   *Cheap-to-change-after:* **NO** — the taxonomy is the standard's escape-hatch surface; changing
   it is a constitutional edit, deliberately expensive.

2. **B's review-check is monitor/watcher-scoped (incl. any recurring/automated notice source),
   NOT every operator-facing message.** [resolved in *Standard B → Scope (Q2)*] A one-shot
   conversational reply is not a watcher and does not pay the self-heal cost; a recurring or
   automated notice source is in scope. *Cheap-to-change-after:* **NO** — it defines the
   review-check's binding surface, a semantic contract reviewers rely on.

3. **C's hub TOPIC is machine-local (corrected key `physical-credential-locality`); C's operator
   alerts VIEW is unified.** [resolved in *Multi-machine posture → Q3*] The acute miss-a-critical-
   alert risk is already closed via `GET /attention?scope=pool`; only non-critical housekeeping
   hub notices stay machine-local. The single-unified-hub-stream UX is a registered Close-the-Loop
   follow-up (see *Migration & loop-closure*), not a silent defer. *Cheap-to-change-after:* **NO**
   — it touches a user-visible interface (where the operator reads alerts), which the
   Decision-Completeness taxonomy holds is never cheap.

New decision points introduced by convergence edits, all frontloaded (none left for the builder):

4. **A's deterministic marker convention** (`machine-local-justification: <key>`) — frontloaded in
   *Standard A → Two-layer enforcement*. *Cheap-to-change-after:* **NO** — it is the
   machine-checkable contract the conformance audit grades.
5. **B's required self-heal declaration fields** (P19 brakes + severity class) — frontloaded in
   *Standard B*. *Cheap-to-change-after:* **NO** — the review-check keys on their presence.
6. **Migration approach** (idempotent `PostUpdateMigrator` entry scoped to the spec-converge
   allowlist) — frontloaded in *Migration & loop-closure*. *Cheap-to-change-after:* **NO** —
   Migration Parity is NON-NEGOTIABLE; a wrong approach is a broken ship.

Round-2 convergence edits (external codex/gemini corroboration) added these decision points, all
frontloaded — none left for the builder:

7. **A's check is BIDIRECTIONAL — an infeasible `unified` is also a finding.** [resolved in
   *Standard A → The upgrade*, item 4] Closing only the machine-local direction would leave "just
   claim unified" as a trivial dodge (and invite an unsafe credential replication).
   *Cheap-to-change-after:* **NO** — it defines the reviewer's contract in both directions.
8. **The marker's location + parse contract + which conformance surface grades it.** [resolved in
   *Standard A → The marker's location*] The marker is a labeled line in `## Multi-machine posture`;
   the per-spec `/spec/conformance-check` grades presence (NOT `/conformance/coverage`); the static
   lint floor lands with the registry ship, not this run. *Cheap-to-change-after:* **NO** — it is
   the machine-checkable contract downstream tooling parses.
9. **B's deterministic self-heal fields** (`remediation-actions`, `max-notification-latency`, and
   flapping folded into the P19 `breaker`). [resolved in *Standard B*] These are the machine-
   inspectable floor the reviewer audits over. *Cheap-to-change-after:* **NO** — the review-check
   keys on their presence and they are a declared contract.
10. **B's severity class is CONTESTED, not merely declared; flapping is a structural backstop.**
    [resolved in *Standard B → Severity carve-out*] Presence of a class field never satisfies
    correctness; flapping is mandatory breaker behavior, not a waivable label. *Cheap-to-change-
    after:* **NO** — it is the anti-gaming contract symmetric to A.
11. **C's authoritative critical-alert surface is the pooled attention queue; the unified Telegram
    stream is a reachability follow-up, not UX.** [resolved in *Multi-machine posture → Q3*]
    *Cheap-to-change-after:* **NO** — it classifies a user-visible alert-delivery guarantee, which
    Decision-Completeness holds is never cheap.
12. **Every Close-the-Loop deferral must cite a concrete durable id in the ship criteria.**
    [resolved in *Migration & loop-closure*] A prose "tracked follow-up" is the abandonment this
    forbids. *Cheap-to-change-after:* **NO** — it is a ship gate, and Close the Loop is a standard.

## Open questions

*(none)*
