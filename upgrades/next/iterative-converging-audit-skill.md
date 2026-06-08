## What Changed

Added a new built-in skill, `/iterative-converging-audit`, and the constitution standard it operationalizes ("Iterative Audit to Convergence"), plus its paired safety standard ("No Silent Degradation to Brittle Fallback") in `docs/STANDARDS-REGISTRY.md`. The skill turns any "find all instances of X" task — security audit, safety audit, code review, research sweep, compliance check — into a structured loop that does not stop at one pass: frame the target, sweep, fix-or-classify each finding, then RE-sweep the full surface, repeating until a clean pass returns zero new discoveries. It ships to every agent via `installBuiltinSkills`, so any agent can invoke it.

## What to Tell Your User

I now have a reusable "audit until it's actually done" skill. Instead of looking once and saying "looks clean," it runs a proper loop — sweep, fix what it finds, then sweep again — until a fresh pass turns up nothing new. It works for security reviews, safety audits, research, any "did we get everything?" job, and it's honest: if it has to stop early it says "incomplete," it never dresses up a half-finished sweep as thorough. I also wrote the principle behind it into my constitution so it's a standard I hold myself to, not just a tool.

## Summary of New Capabilities

- `/iterative-converging-audit` — a built-in, user-invocable skill that runs any find-all sweep as an audit → fix → re-audit loop to convergence, with a written findings ledger and a "leave a standing ratchet" step so the converged state cannot silently regress.
- Two new constitution standards in the registry: "Iterative Audit to Convergence" (thorough means converged, not one-pass) and "No Silent Degradation to Brittle Fallback" (a gating LLM call must swap-provider or fail-closed, never silently drop to a heuristic).
