# DRAFT for ratification — constitution amendment

> Proposed addition to `docs/STANDARDS-REGISTRY.md` under **Building — engineering
> discipline**, directly after "Bounded Notification Surface" (its sibling: that
> standard bounds notification loops; this one generalizes to ALL loops).
> Requested by Justin, 2026-06-05, topic "Resource Limitation Mitigation":
> "a fundamental standard… never allowing raw loop behavior through that can
> lead to compounding issues."

---

### No Unbounded Loops — Every Repeating Behavior Carries Its Own Brakes

**Rule.** Any code path that repeats an action — a retry, a poll, a monitor tick, a recovery attempt, a sync flush — must ship with all three brakes built in: **backoff** (the interval between failed attempts grows), a **breaker** (after sustained failure it stops attempting and surfaces the degradation once, instead of trying forever), and a **cap** (a hard bound on the work one attempt may generate — payload size, processes spawned, log lines, notifications). A repeating behavior with no brakes is not "simple code" — it is a standing invitation for the compounding failure mode: the loop's own work makes the condition it is retrying against worse. No raw loop ships; a PR adding one must show the three brakes and a test that proves the bound holds under sustained failure.

**In practice.** Ask three questions of every `setInterval`, `while`, and retry-on-failure path: (1) *If the target rejects every attempt for an hour, how many attempts run and what does each cost?* — if the answer is "720 attempts, each rebuilding a payload," there is no backoff and no breaker. (2) *Does a failed attempt leave the system doing MORE work than a successful one?* — divergence resends, full-table rescans, per-attempt log lines, and respawns are amplification; cap them. (3) *Who notices when the loop gives up?* — a breaker that opens silently violates Observability; it reports once through DegradationReporter or the attention queue, then stays quiet. The brakes live IN the looping component (injectable clock, bounded state, unit-testable), not in the caller's good intentions — the canonical shapes are `AgeKillBackoff` (veto-respecting suppressor), the live-tail guards (version gate + exponential backoff + content cap), `AttentionTopicGuard` / `topicCreationBudget` (volume budgets at the chokepoint), and `LlmCircuitBreaker` (the breaker shape).

**Earned from.** One day — 2026-06-05 — produced three independent instances of the same disease on the live fleet. The reaper age-gate re-requested a kill the KEEP-guard vetoed, every 5 seconds, forever: 17,503 identical requests in a day, reading to the operator as "the machine is under heavy load" (fixed by PR #863). The live-tail streamer rebuilt every topic's content every 5 seconds — a full synchronous read of a 75,000-line file per topic per tick — and hot-retried every flush a peer rejected: the loop's own cost froze the event loop, the freeze staled its mesh timestamps, the stale timestamps caused the rejections it was retrying against — a textbook compounding spiral that ground the Laptop to a halt (fixed by PR #867). And the third topic-spam flood had already shown the notification variant (fixed by P17 / Bounded Notification Surface). Per **Distrust Temporary Success — A Recurrence Is a Root Cause**: three same-shaped incidents in one day is not three bugs, it is one missing standard — the absence of a structural rule that repeating behavior must carry its own brakes.

**Traces to the goal.** An autonomous agent is made of loops — that is what persistence IS. An agent whose loops can compound against a degraded environment destroys the machine, the budget, and the trust it exists to earn, precisely when the environment is weakest (the moment it most needs to behave well). *Structure beats Willpower*: "remember to add backoff" is willpower; a gate that refuses a raw loop at review time is structure. This standard is the temporal twin of Bounded Notification Surface — that one bounds what loops emit at the user, this one bounds what loops do to the world.

**Applied through.** `AgeKillBackoff` (`SessionManager` age-gate), the live-tail guards (`LiveTailSource` version gate / failure backoff / content cap + `TelegramAdapter` tail cache), `topicCreationBudget` + `AttentionTopicGuard`, `LlmCircuitBreaker`, `DeliveryRetryManager`. Enforcement is landing via the multi-machine loop-safety audit (CMT-1109, in progress): an inventory of every repeating behavior in the mesh paths scored against the three brakes, each unbounded loop fixed as its own PR, and a `sustained-failure` test pattern (drive the loop against a permanently-rejecting target; assert attempt count and per-attempt cost stay under the declared bound) added to the Testing Integrity tiers for any PR that ships a repeating behavior.

---

*Ratification note: on your word this lands as a one-section amendment PR to `docs/STANDARDS-REGISTRY.md` (with the audit PRs referencing it as their parent principle). The "Applied through" enforcement items marked in-progress ship with the audit, not before — the standard names them so the loop is closed when they land.*
