# Convergence Report — Framework-Onboarding Mentor System

**Spec:** `docs/specs/FRAMEWORK-ONBOARDING-MENTOR-SPEC.md`
**ELI16 companion:** `docs/specs/FRAMEWORK-ONBOARDING-MENTOR-SPEC.eli16.md`
**Converged:** iteration 3 (0 material findings in the final round)
**Reviewers:** security, scalability, adversarial, integration, lessons-aware (5 internal Claude perspectives, all rounds). External cross-model (GPT/Gemini/Grok) deferred per abbreviated-convergence allowance for an internal-tooling spec; the mandatory lessons-aware reviewer ran every round.

---

## ELI10 Overview

We're building a self-running routine that teaches a new AI "engine" how to be a good Instar
developer — and writes down everything it learns so the next engine is faster to onboard. Today
Instar runs on Claude and Codex; Cursor, Aider, and Gemini are next. We recently discovered, by
luck, that the fastest way to find what's broken in a new engine is for an experienced agent (Echo)
to play the user, work alongside the new agent (Codey), watch where he trips, then look under the
hood and write down the lessons. This spec turns that lucky one-off into a scheduled job — and saves
every lesson into a durable, labeled notebook (a "ledger") that becomes a reusable onboarding
checklist for future engines.

The heart of the design is two "hats." Echo wears the **user hat** first — chatting with Codey like
a real customer would, deliberately *blind* to his code and logs, so the wild real-world problems
actually surface instead of being quietly steered around. Then Echo wears the **inspector hat** —
reading the logs and code afterward and recording each problem with a label: "the engine's own
limit," "Instar not fitting the engine," or "a mistake anyone could make." Only the first two travel
forward to the next engine's checklist; the third is just coaching. Meanwhile Codey does *real*
Instar improvement work from the feedback backlog, so he's learning on live fuel, not busywork.

What changes if it ships: onboarding a new AI engine stops being a lucky accident and becomes a
compounding methodology. The main tradeoff the review wrestled with is **trust** — Echo is both the
teacher and the note-taker, which creates obvious ways to grade itself favorably or bury
inconvenient findings. Most of the review work went into making those self-serving shortcuts
structurally impossible rather than relying on Echo's good intentions.

---

## Original vs Converged

The original draft was directionally sound but had four load-bearing weaknesses that the review
turned into hard structural guarantees:

1. **The "two hats" weren't actually separate.** Originally it was "one job with two allowlisted
   phases" — but one AI brain running both phases in sequence carries what it saw under the hood
   last time into this time's supposedly-blind chat. Input rules control what you *fetch*, not what
   you *remember*. **After review:** the user hat runs as a genuinely separate, fresh sub-task each
   time with no access to the inspector's findings, the forensic tools are physically withheld from
   it, and a tripwire flags any tick where the user-hat references internals it shouldn't know —
   with a built-in self-test that proves the tripwire actually works (so a dead tripwire can't
   masquerade as "all clean").

2. **Echo was judge, jury, and scorekeeper.** Originally Echo proposed every problem-label, decided
   what tasks Codey got, AND computed Codey's "graduation" from its own intervention count — all
   gameable by the same agent. **After review:** graduation evidence now comes from outside facts
   Echo doesn't control (did CI pass, did the PR merge), task difficulty is tagged by the backlog
   source not by Echo, every "level up" requires Justin's sign-off, a slice of the "blame the
   mentee" labels always go to Justin regardless, and Codey himself can dispute his own labels —
   with silence never counting as agreement.

3. **The known agent-to-agent bugs would fire constantly.** A chatty every-15-minutes job is the
   worst case for two documented bugs: a message-loop where every delivery spawns a fresh session,
   and an overflow when a long conversation gets crammed into a command line. Originally the spec
   "hard-depended" on a fix that doesn't exist yet. **After review:** the mentor uses a
   *persist-and-pick-up* delivery (no fresh session spawned per message) and a *fresh thread per
   task* (so history never grows unbounded), and it physically refuses to go live until that safe
   delivery path is verified wired.

4. **The notebook could be poisoned and could grow forever.** Originally the playbook ranked
   problems by raw recurrence count — so an unfixed issue observed every tick would dominate
   forever — and the evidence table had no retention. **After review:** recurrence counts distinct
   *episodes* (not raw ticks), there's a per-issue cap with a "probable-loop" flag, the count is
   stored not recomputed on every read (killing a performance landmine), retention is bounded, and
   ranking decays with age.

Beyond those four: every HTTP route now requires auth + input clamping, evidence is stored as
opaque pointers (never inlined log text that could leak secrets), all captured text is treated as
untrusted data, the three Instar migration mechanisms are named precisely, the agent-awareness
CLAUDE.md update is required, and all three test tiers (including the "is it actually alive?" E2E)
must ship in the first PR.

---

## Iteration Summary

| Iteration | Reviewers who flagged material findings | Material findings | Spec changes |
|-----------|-----------------------------------------|-------------------|--------------|
| 1 | security (7), scalability (8), adversarial (10), integration (8), lessons-aware (11) | 44 | Full rewrite: §4 structural two-hats, §6 governance + cross-agent termination + budget, §8 externally-anchored graduation, §13 anti-poisoning storage, §15 telemetry, §16 config, §17 security, §18 testing, §3.3 topology, §14 migration |
| 2 | adversarial (2), integration (1), lessons-aware (3); security 0, scalability 0 | 6 | §6 concrete persist-only delivery + fail-closed live-gate; §6 fresh-thread-per-task (argv overflow); §4.3+§18 leakage-detector positive-control + canary; §6 dispute non-response default; §14.1/§10/§19 built-in-job mechanism pinned; §9 per-framework co-location precondition |
| 3 | (converged) | 0 | none |

---

## Full Findings Catalog

### Iteration 1 — 44 material findings

**Security (7):** prompt-injection via untrusted Codey replies into autonomous task/spec assignment
(HIGH); cross-agent identity asserted not authenticated (HIGH); evidence-pointer exfiltration channel
(HIGH); stored-injection via captured free-text into the playbook seed (MED); routes need
Bearer+503+clamps+allowlist (MED); SQL-injection / parameterized statements (LOW); spoofable tick
cadence (LOW). → All resolved in §3.1/§7.1, §7.2, §13.2/§17, §17, §5/§17, §13.8/§17, §7.2/§16.

**Scalability (8):** unbounded `framework_observations` growth (HIGH); read-time per-issue COUNT N+1
in playbook ranking (HIGH); no indexes (MED); no WAL/busy_timeout/concurrency config (MED); hot-path
LLM cost unmodeled (MED); budget-gate fail semantics + shared-queue starvation (MED); reply-round cap
unquantified (LOW); probable-dup query unbounded (LOW). → Resolved in §13.2 retention, §13.1/§13.4
materialized recurrenceCount, §13.1 indexes, §13.8 WAL/CAS, §6+§16 cost model, §6 atomic pre-tick
fail-closed background-lane check, §6/§16 caps, §13.3 bounded query.

**Adversarial (10):** two-hats leak across ticks — "structural" was a wish (HIGH); Echo
proposer+grader+assigner+sole-metric-writer self-reinforcing loop (HIGH); bucket mis-classification
no disinterested check (HIGH); ledger poisoning via recurrenceCount inflation (HIGH); unbounded
autonomous task assignment (MED); regression link relies on biased proposer (MED); playbookStatus
promotion owner unspecified (MED); safe-window inferred by interested model (MED); wont-fix silent
escape hatch (LOW); no instrument to detect gaming (LOW). → Resolved in §4 (spawned-context
isolation + tool-grant + PreToolUse deny + leakage detector), §8 (external evidence + Justin
ratifies + difficulty tags + intervention-as-audit-event), §6 (Codey counterparty + sample-audit +
distribution telemetry), §13.4 (episode recurrence + cap + probable-loop + decay), §7.3/§16 caps,
§13.5 auto-suggest, §13.6 non-Echo promotion review, §12 Q3 hard signals, §13.7 wontFixReason, §15
telemetry.

**Integration (8):** missing Agent Awareness / CLAUDE.md template (HIGH); vague migration-parity
conflating 3 mechanisms (HIGH); cross-machine forensics topology undefined (HIGH); config knobs not
enumerated (MED); rollback/clean-disable unspecified (MED); dashboard surface unaddressed (MED);
provider-neutral-evolution-mode dependency framing (LOW); ships-staged reconciler keying (LOW). →
Resolved in §11/§14.4, §14.1-3, §2/§3.3, §16, §14.5, §15, §10, §11/frontmatter.

**Lessons-aware (11):** cross-agent ack/spawn loop NOT structurally prevented — §6 capped the wrong
layer (CRITICAL); Threadline argv-overflow unaddressed + send-dedupe missing (HIGH); two-hats
prompt-not-structure (HIGH); graduation metric self-gameable (HIGH); supervision tier undeclared
(MED); auto-capture wiring trap (North Star) (MED); near-silent stable-key dedup (MED); migration +
E2E must be in v0.1 (MED); provider-neutral non-blocking (LOW); ELI16 ≥800 (LOW); identity self-id
check (LOW). → Resolved across §6, §3/§6 (round 2), §4, §8, frontmatter supervision, §5/§18, §11,
§14/§18, §10, companion, §7.2.

### Iteration 2 — 6 material findings

- **(adversarial, MED)** Leakage detector is itself an interested, unscored guardrail — a dead
  detector reads identical to a clean run. → §4.3 + §18: positive-control test + seeded-leak canary.
- **(adversarial, LOW-MED)** Codey-as-dispute-counterparty had no non-response default. → §6:
  non-response routes to Justin sample-audit pool, never auto-confirms.
- **(integration, MED)** Built-in job mechanism internally inconsistent (`installBuiltinJobs` vs
  `.instar/jobs/schedule/` "template"). → §14.1/§10/§19 pinned to a built-in job at
  `.instar/jobs/instar/` consistently.
- **(lessons, HIGH)** §6 loop-containment hard-depended on a non-existent receive-side gate; "fallback
  path" named but undefined. → §6 concrete persist-only / queued-pickup delivery + fail-closed
  live-gate mirroring §3.3.
- **(lessons, HIGH)** argv-overflow (`bug_threadline_spawn_command_too_long`) never addressed. → §6
  fresh-thread-per-task + threadId-handoff (fetch history via tool, not inline argv).
- **(lessons, LOW)** §9 recursion should restate the §3.3 co-location precondition per-framework. → §9.

### Iteration 3 — 0 material findings (converged)

All five perspectives clean. Adversarial confirmed the leakage-detector positive-control + canary
and the dispute non-response default close their round-2 gaps with no new issue. Integration confirmed
the built-in-job pin is migration-parity-consistent with a coherent disable path. Lessons-aware
confirmed the persist-only delivery **structurally eliminates spawn-on-receive** (the documented
root of the loop, not a content-marker band-aid) and the fail-closed live-gate is a real structural
precondition, and that fresh-thread-per-task + threadId-handoff genuinely fixes the argv overflow.

---

## Convergence verdict

**Converged at iteration 3. No material findings in the final round across all five reviewer
perspectives.** The spec is ready for user review and approval.

The four structural risks the review existed to catch — willpower-masquerading-as-structure in the
two-hats separation, the self-grading feedback loop, the cross-agent spawn-loop + argv-overflow, and
ledger poisoning — are all closed with mechanisms (spawned-context isolation, externally-anchored
graduation with Justin ratification, persist-only delivery + fresh-thread-per-task behind a
fail-closed live-gate, episode-based recurrence) rather than instructions. `approved: true` remains
the user's structural contribution and is not written by this process.
