# Standards Enforcement-Coverage Audit — Plain-English Overview

## The one-sentence version

For every rule in the project's constitution, this checks whether a real, automatic
guard exists (a test, a lint, a gate) or whether the rule is still just a sentence
someone has to remember — and it surfaces the rules that are still only wishes.

## Why we need it

The constitution (`docs/STANDARDS-REGISTRY.md`) is the project's set of hard-won
rules. Almost every rule even names, in its own text, the thing that's supposed to
enforce it ("enforced by this test", "guarded by that gate"). But nobody ever
*checks* those claims. A rule whose guard was renamed, deleted, or never actually
built looks protected while being fake-protected — which is the exact failure the
constitution itself warns about, turned back on the constitution.

The founding principle of the whole project is "Structure beats Willpower": if a
behavior matters, enforce it in code, not in a prompt nobody re-reads. This feature
makes that principle *measurable* — it tells you, concretely, which rules are
structurally guaranteed and which are still running on willpower.

## How it works

1. **Read the constitution.** Parse every rule and the enforcement it claims.
2. **Verify the claims.** For each named guard — a test file, a lint script, a gate,
   a route — check that it actually exists in the codebase right now.
3. **Classify each rule.** Strongest guard wins: a CI ratchet (fails the build on
   regression) is stronger than a gate, stronger than a lint, stronger than just a
   design doc, stronger than nothing.
4. **Surface the gaps.** The rules with no verifiable guard are the actionable list —
   each gap is a guard worth building. And if a rule *names* a guard that no longer
   exists (a "dangling reference"), that's flagged even louder: a broken guarantee.

It's almost entirely deterministic — it just reads local files, so it costs nothing,
sends nothing anywhere, and gives the same answer every time (it "converges" by
construction, unlike anything that leans on a language model's judgment). An optional
language-model pass to help classify the fuzzy cases exists but ships turned off.

## What changed for users if it ships

Nothing visible unless you turn it on (it ships off by default). When enabled, you
get two read-only views: a full coverage map of every constitutional rule and its
guard, and a health summary with the gap list and the "enforced ratio." A slow
background job re-checks it and quietly raises ONE note only when a NEW gap appears
(a new rule with no guard, or a guard that got deleted) — never a flood.

And because the project's own rule is "every tool we build for ourselves should ship
to users too," this same audit becomes a capability a user's own agent inherits:
"which of *my* agent's standards are actually guarded?"

## The main tradeoffs (what the design fought over)

- **Two earlier designs were thrown out.** The first tried to use a language model to
  check every code file against every rule — it would have cost ~$320 per pass and
  never settled. The second narrowed it down, but turned out to be a no-op: every
  rule checkable from a single file is *already* caught by a cheaper automatic check.
  So the question was inverted: don't audit the code against the rules (already
  covered), audit whether the *rules themselves* have guards (nobody checks that).
- **Deterministic, not clever.** The value is in the simple, reliable, repeatable
  map — not in an AI's opinion. The language-model help is optional and advisory; the
  file-existence checks are the authority.
- **Surface, don't fix.** It points at the gaps; it never auto-builds a guard and
  never blocks anything. A gap is information for a human (or the agent) to act on.
