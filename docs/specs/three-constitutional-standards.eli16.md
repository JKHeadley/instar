# Three Operator-Ratified Constitutional Standards — Plain-English Overview

> The one-line version: we are writing three rules the operator hand-decided into the constitution — the agent is always one entity across many machines, watchers self-heal before they page you, and stray alerts all go to one topic — and this change lands only the *text* of those rules; the machinery that enforces them is a separate build.

This change is small and precise: it adds three new standards to the constitution and their matching lesson entries, and nothing else. It does not build any new gate, hook, sentinel, or route. Think of it as writing three new laws into the rulebook. The laws are now on the books, so every future spec review reads them and asks the questions they raise — but the automated *enforcement* of those laws (the strengthened spec-converge check, the side-effects review field, the conformance guard) is a follow-up build that comes after. Landing the text first is deliberate: it makes the rule real and reviewable before the code that polices it exists, and it gives the lessons-aware spec reviewer something to cite on day one.

## The problem in one breath

Three separate failures kept recurring because the rule that would have caught each one lived in habit and prose, not in a written, enforceable standard. The operator had to catch each one by hand. When a human keeps having to point out the same class of mistake, the real defect is a missing standard — so we are writing the three standards down.

## What already exists

- **The constitution** — `docs/STANDARDS-REGISTRY.md` (the enforceable standards) and `docs/INSTAR-DESIGN-PRINCIPLES-AND-LESSONS.md` (the earned-lessons catalog the spec-converge lessons-aware reviewer reads). Both are already the source of truth that shapes every spec review.
- **Cross-Machine Coherence** — the existing standard that keeps N machines from splitting into two agents (the lease and seamlessness layer). It governs robustness under degraded conditions; it does NOT govern whether each new feature actually rides that machinery.
- **The per-feature multi-machine posture check** — already asks each feature to *declare* a posture, but it accepts "machine-local BY DESIGN" as a valid answer with no justification.
- **Bounded Notification Surface (P17)** — already caps how *many* Telegram topics can be auto-created; the topic-creation budget, the attention-topic coalescing guard, and the burst-invariant test all already ship.
- **Near-Silent Notifications / No Silent Degradation** — already make self-lifecycle chatter quiet and forbid swallowing failures.

## What this adds

Three standards, each written in both the enforceable registry and the lessons catalog:

- **(A) An Instar Agent Is Always a Multi-Machine Entity.** "Unified across my machines" is the *default* posture for every feature and state surface. "Machine-local" becomes an exception that must name a concrete reason it cannot be unified (a credential physically bound to one disk's keychain, a hardware-bound resource, or an operator-ratified exception). A bare "machine-local BY DESIGN" with no justification is now a violation, not a valid answer. This closes the gap the existing posture check missed: it tested that a feature *declared* a posture, not that the *default* was unified.

- **(B) Self-Heal Before Notify.** A watcher that detects an internal issue must first attempt a bounded, audited self-heal. The operator is paged only when the self-healing itself has failed — not on first detection. Nothing goes silent (every detection, heal attempt, and outcome is audited), so this composes with No Silent Degradation by refining *to whom* the report goes: into the self-heal machinery, with the operator as the last resort.

- **(C) Notices Route to the Alerts Topic, Never a New One.** A message that belongs to an existing conversation goes there; an ownerless notice (an alert, a system notice, a housekeeping escalation) routes to the ONE dedicated alerts/hub topic. Creating a new Telegram topic per alert or event is forbidden. This is the routing corollary of Bounded Notification Surface: that standard caps how many topics are born; this one names where an ownerless notice goes instead.

## Why each was earned

- **(A)** The tiered-intelligence-delegation spec defaulted its consult memory to machine-local and survived SEVEN convergence rounds — the automated review machinery passed it, and only the operator's own read caught it. That is the tell: the always-multi-machine expectation lived in reviewer habit, not in structure.
- **(B)** While hardening that same spec's "watcher for the watcher," the operator named the general rule: the user almost never hears about internal issues; those get routed to the parts of the system that self-heal, and the user is told only if the self-healing itself fails.
- **(C)** The recurring topic-spam floods — the 2026-05-22 sentinel flood, the 2026-05-28 collaboration-redrive flood, and the 2026-06-05 worktree-detector flood (which dodged the per-source budget by giving every item a unique source) — were all the same shape: a housekeeping feature spawning one topic per event. A standing operator rule since 2026-07-01, now raised to constitutional status.

## The safeguards

**This change is text-only.** It adds no runtime surface, no gate, no code path. There is nothing to over-block or under-block, no message flow it can shadow, and no state it can strand. The risk of a docs change is that the text is wrong or contradictory — not that it misbehaves at runtime.

**The enforcement is tracked, not implied.** Each standard's "Applied through" section names the enforcement build that follows (the strengthened spec-converge cross-machine check that rejects undefended machine-local, the side-effects review §7 justification field, the conformance guard marker, and the alerts-topic routing assertion at the chokepoint). Landing the text does NOT claim the enforcement exists — the build is a separate, tracked follow-up.

## What ships when

This PR lands the three standard texts (registry + lessons entries) plus these gate artifacts. The enforcement build — the code that mechanically polices each standard — follows separately, tracked against topic 29723 and the feature-maturation audit (topic 30668). From the moment this merges, the spec-converge lessons-aware reviewer already reads P21–P23 and asks their questions of every future spec, even before the dedicated guards land.

## What you actually need to decide

The operator has already ratified all three standard texts (2026-07-03, topic 29723). The only question for a reviewer of THIS change is: do the landed entries faithfully capture the three ratified rules and read coherently against the existing constitution — yes or no? The enforcement build is out of scope here.
