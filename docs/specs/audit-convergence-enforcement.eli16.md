# Making "thorough audit" a provable claim instead of a feeling — plain English

## The problem

We already have a rule on the books: an audit isn't done after one pass — you audit, fix what you found, then audit AGAIN, and you only get to say "done" when a full re-check finds nothing new. It exists because it's been proven the hard way: a sweep that found "about 20" problem sites turned out to have 44 when the fixes were re-checked. One pass always misses things, and the fixes themselves move things around.

But right now that rule is just words. The system's own enforcement checker grades it "documented-only with zero guards" — meaning nothing actually stops me (or any agent) from running one tired pass and calling it thorough. The instructions describe the loop; nothing enforces it.

## What this builds

Four small pieces, all copying a pattern that already works for design reviews:

1. **A standard audit report with a per-round ledger.** Every audit keeps one file: what was hunted, where, and — per round — every finding with its fate (fixed, with the commit that fixed it, or accepted, with a written reason). Each round records how many NEW things it found. A healthy audit shows that number falling to zero.

2. **A stamp that must be earned.** A small validator reads the ledger and will only stamp the report "converged" if there were at least two rounds, the last round found zero new things, every finding has a closed fate, and the audit left behind a standing tripwire (an automated check that fails if the problem pattern ever creeps back in — or a written reason why that's not possible). You can't hand-write the stamp: the commit gate rejects any audit report claiming convergence that the validator didn't earn. An honestly-incomplete audit is fine to commit — it just can't wear the "converged" label.

3. **The default route, delivered to every agent.** Every agent's instructions gain the rule: audit-shaped work (find-all-X, security sweep, compliance check) runs as the converging loop with the standard report — and a single-pass audit is incomplete BY DEFINITION. New agents get it at setup; existing agents get it on their next update; non-Claude agents (Codex, Gemini) get it too.

4. **The constitution entry gets teeth the checker can see.** The rule's text now names the actual guard files, so the enforcement checker re-grades it from "documented-only" to structurally guarded — and will raise an alarm if the guard ever disappears.

Plus one switch: the already-approved report-backed check for DESIGN reviews turns on for this development machine (it was built earlier and shipped off).

## What could go wrong, honestly

- The gate only checks the report's STRUCTURE (rounds, counts, fates) — a lazy auditor could still write shallow rounds. Structure can't force diligence; it forces honesty about what was done, which is the achievable half. Content quality stays with reviews.
- Old audits aren't retroactively judged — the gate applies from now on.
- Nothing changes at runtime for anyone: this is all commit-time checks, docs, and instructions.

## What you'd be agreeing to

That "converged" becomes a claim the system verifies rather than trusts — the same standard your design reviews already live under — and that every agent is told, structurally, that the converging loop IS how audits are done.
