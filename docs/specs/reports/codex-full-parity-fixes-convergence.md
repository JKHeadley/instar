# Convergence Report — Codex ↔ Claude Full-Parity Fixes

**Spec:** docs/specs/codex-full-parity-fixes.md · **Round:** 5 internal reviewers (security, adversarial, integration, scalability, lessons-aware), 2026-05-25. External GPT/Gemini/Grok require the billed cloud path (not self-runnable here; `/ultrareview` available to Justin for that extra layer).

## ELI10 Overview

We're making Instar's safety guards actually work on the Codex (GPT) engine the same way they do on Claude. Earlier this session I built four fixes and got them green on unit tests. Then I ran a five-angle review of the plan — and it earned its keep: it caught two places where I'd over-claimed "done," plus a couple of real bugs in the code I'd already committed. That's exactly the value of reviewing before shipping: the author (me) was blind to things a fresh set of eyes caught immediately.

The headline piece (auto-arming the guards so a fresh Codex agent isn't unprotected until a human clicks "trust") got sharper, not softer: the review turned vague "we'll figure out scoping" into hard go/no-go gates — most importantly, "do NOT use the system-wide policy channel, and prove the guards are scoped to this one agent before shipping, or don't ship that path at all." Because policy-installed guards that can't be turned off are great until they reach into your *personal* Codex or can't be removed when one misbehaves.

## Original vs Converged (in plain terms)

- **Before:** I'd marked "the two review checkers already work on Codex — no code needed" because Codex's program *lists* the data field they read. **After:** that's not proof the field is actually *filled in* at runtime. Downgraded to "looks right, not yet verified" — must capture a real Codex turn and confirm the field isn't empty before calling it done.
- **Before:** the plan let the hook-rewiring fix ship on its own. **After:** that's dangerous — rewiring the hooks file makes Codex distrust the guards until they're re-armed, so shipping it *before* the auto-arming fix would leave existing agents *less* protected than today. Now they must ship together, and the migration must refuse to rewire unless it can re-arm.
- **Before:** "managed config is the clean answer." **After:** still the right direction, but only the lowest-privilege, per-agent, user-removable variant — never the machine-wide policy tier — with a proven kill switch and a runtime check that the guards actually still block.

## Material findings (all incorporated into spec §7)

2 BLOCKING (B1 schema≠runtime over-claim; B2 P1-before-P0 dark-guard window — flagged by 3 of 5 reviewers), 5 P0 hard gates (no MDM tier; per-agent scoping proven; operator kill switch; content-hash pinning; runtime arming canary), 3 fallback gates, and 6 code-level findings (C1 asdf dead fallback — **FIXED**; C2 detector memoization — **FIXED**; C3 scope-coherence re-entry guard; C4 canary should drift-detect not hardcode; C5 model-badge confirmed OK; C6 confirm Stop-trio fail-open).

## Iteration summary

| Round | Reviewers | Material findings | Outcome |
|-------|-----------|-------------------|---------|
| 1 | security, adversarial, integration, scalability, lessons-aware | 2 blocking + 5 P0 gates + 6 code/latency | spec §7 added; over-claims corrected; asdf C1/C2 fixed in code |

## Convergence verdict

Converged on the internal panel: the spec now states honest status (no over-claims), hard P0 gates, and the P1+P0 atomic requirement. Code fixes: C1+C2 landed; C3/C4/C6 + B1 runtime capture are tracked must-fixes bound to the P0 build (which is the autonomy-safety piece Justin may still send through `/ultrareview`). The two independent P2 fixes (asdf, model-badge) are mergeable after their live-proof; P1+P0 merge together post-build.
