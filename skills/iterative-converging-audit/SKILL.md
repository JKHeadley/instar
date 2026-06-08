---
name: iterative-converging-audit
description: Run any "find all instances of X" sweep — a security audit, a safety audit, a code review, a research question, a compliance check — as an iterative loop that does NOT stop at one pass. Audit → fix → RE-audit → … until a clean pass returns zero NEW discoveries. Use whenever thoroughness matters and a single pass would miss things. Trigger words: audit, sweep, find all, review everything, comprehensive, thorough, exhaustive, security review, safety audit, no stone unturned, did we get everything, convergence.
license: MIT
metadata:
  author: sagemindai
  version: "1.0"
  homepage: https://instar.sh
  user_invocable: "true"
---

# iterative-converging-audit — Audit to Convergence, Not to Exhaustion-of-Patience

A single audit pass is never thorough. The first sweep has blind spots; the fixes themselves reveal new instances or introduce new ones; and "I looked once and stopped finding things" usually means "I got tired," not "there is nothing left." The only honest definition of a complete audit is a **converged** one: a re-run that finds **zero new discoveries**.

This skill turns that into a structurally enforced loop. It applies to ANY "find all instances of X" task — security audits, safety audits, code reviews, research sweeps, compliance checks, dependency audits, dead-code hunts, "are there other places we do this wrong" investigations.

This skill enforces the **Iterative Audit to Convergence** constitution standard (`docs/STANDARDS-REGISTRY.md`). You do not declare an audit complete on round 1. You track rounds. You re-audit after every fix batch.

---

## When to Activate This Skill

- Any request to "find all", "audit", "sweep", "review everything", "make sure we got everything".
- After fixing a bug, when the same class of bug likely exists elsewhere ("where else do we do this?").
- A security or safety audit where a missed instance is dangerous.
- A research/review question where one source or one angle is not enough.
- Whenever you catch yourself about to say "I checked, looks clean" after a SINGLE pass.

---

## The Loop (do not skip steps)

### Step 0 — Frame the audit (write this down first)

Before sweeping, define — explicitly, in the audit ledger:

1. **Target pattern** — what exactly are you finding? Be precise. "Silent LLM fallbacks in gating paths", not "bad error handling".
2. **Search surface** — where could instances live? List the angles/locations. The first list is always incomplete; you will add to it.
3. **Classification rule** — for each finding, what are the buckets? (e.g. DANGEROUS / MITIGATED / ADVISORY-OK). A finding is not "done" until it is classified.
4. **Fix policy** — what does "fixed" mean per bucket? (remediate / annotate-as-accepted-with-reason / escalate).
5. **Convergence criterion** — usually: a full re-sweep surfaces zero findings not already in the ledger. State it concretely.

### Step 1 — Audit pass (round N)

Sweep the search surface for the target pattern. Record EVERY finding in the ledger with: location, current behavior, bucket. Cast wide — false positives are cheap to classify out; missed instances are the failure mode this skill exists to prevent. Use multiple search angles (by-name, by-content, by-structure); one angle is blind to what the others catch.

### Step 2 — Fix pass

For each finding, apply the fix policy: remediate it, OR classify it as accepted with an explicit written reason (an accepted finding is a DECISION, not a TODO). Capture the diff. **Fixing changes the code**, which is exactly why you must re-audit.

### Step 3 — RE-audit (round N+1)

Sweep again — the FULL surface, not just what you touched. Two things happen on a real re-audit:
- Your search surface grew (round N taught you new places/angles to look). Add them.
- The fixes may have moved, masked, or created instances. Catch them.

Record any NEW findings. If there are new findings → back to Step 2. If a re-sweep finds **nothing not already in the ledger** → **converged**.

### Step 4 — Declare convergence (honestly)

Only now may you say the audit is complete — and you state it as: "Converged after K rounds; round K surfaced no new findings. Ledger: X total, Y fixed, Z accepted-advisory (each with a reason)." If you stopped for any reason OTHER than a clean re-sweep (ran out of time, budget, patience), say so explicitly — that is an INCOMPLETE audit, not a converged one. Never dress up an exhausted audit as a thorough one.

### Step 5 — Leave a standing guard (so it stays converged)

A converged audit decays the moment new code lands. Where possible, encode the target pattern as a **ratchet** (a test/lint that fails when a new instance appears) so the audit does not silently un-converge. The ledger of accepted findings becomes the ratchet's allowlist. (Example: the `no-silent-llm-fallback` test is the standing guard for the LLM-fallback audit.)

---

## The Ledger (the durable artifact)

Keep a written ledger for the audit — a markdown table or a structured file — with one row per finding: `location | round-found | behavior | bucket | disposition (fixed → commit / accepted → reason)`. The ledger is what makes "converged after K rounds" a verifiable claim instead of a feeling. Track the per-round count; a healthy audit shows the new-findings-per-round curve falling to zero.

---

## Anti-Patterns (this skill exists to forbid these)

| Anti-pattern | Why it fails | The fix |
|---|---|---|
| **"I checked, looks clean"** (one pass) | Round 1 always has blind spots | Re-audit at least once; converge |
| **"Fixed the 3 I found, done"** | Fixes reveal/create new instances | Re-sweep AFTER fixing |
| **Re-auditing only what you touched** | New instances hide in untouched code | Re-sweep the FULL surface every round |
| **Treating an accepted finding as a TODO** | It silently rots; later reader can't tell reviewed-OK from missed | Every accepted finding carries a written reason |
| **Declaring "thorough" when you stopped for time/budget** | Dishonest; the gap reads as "covered" | Say "incomplete — stopped at round K with N open", never "thorough" |
| **One search angle** | Each angle is blind to what others catch | Sweep by-name AND by-content AND by-structure |
| **No standing guard** | The audit un-converges on the next commit | Leave a ratchet (test/lint) keyed on the pattern |

---

## Relationship to other tools

- For a fan-out across many files where you only need the conclusion, delegate the per-angle sweeps to subagents and converge their findings — but the convergence loop (re-audit until clean) is still yours to run.
- The **Coherence Gate** and **DegradationReporter** are about runtime behavior; this skill is about pre-merge thoroughness.
- When the audit's pattern is enforceable in CI, pair this skill with a `no-*` ratchet test (the standing guard from Step 5).

**The principle:** thoroughness is not how hard you looked once — it is whether a fresh look finds anything new. Audit until the fresh look comes back empty.
