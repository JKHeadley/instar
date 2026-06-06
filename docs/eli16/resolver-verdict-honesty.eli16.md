# Red-team resolver verdict honesty — ELI16

> The one-line version: the harness was stating a guess as a fact — now every "governed / ungoverned" verdict says out loud that it came from crude keyword matching and shouldn't be trusted as ground truth.

## The problem in one breath

The MTP red-team harness decides whether an organization's rulebook actually governs a scenario by checking if the words overlap — a crude keyword match. That match is brittle: it misses rules that mean the same thing in different words. On the very first run it told me my own intent had a "gap" (it doesn't govern "presenting estimates as confirmed numbers") when in fact my rule "never present unverified work as completed" plainly covers that — the matcher just didn't see the word overlap. So the harness reported a false hole as if it were fact, and it briefly fooled me.

## What already exists

The resolver (in `ScenarioPack.ts`) reuses the existing intent-test engine's keyword matcher and returns a verdict with a human-readable reason. The reason string asserted things like "Ungoverned: no constraint matches this scenario" — stated as fact.

## What this adds

Two honesty changes, no behavior change to the matching itself:
- Every verdict now carries a `method` field saying exactly how it was produced (`keyword-heuristic`), so no consumer, report, or future session can mistake a heuristic for ground truth.
- The verdict reason strings now tell the truth about their basis. The "ungoverned" reason no longer claims "no constraint matches"; it says "no constraint's keywords matched — which is NOT proof of a real gap; the matcher misses semantically-related rules and is bypassable by rephrasing; treat this as a candidate to verify, not a fact."

## The safeguards

This is required by the just-ratified Truthful Provenance standard: a verdict must carry the method that generated it. A new unit test asserts every verdict carries its method, and that the ungoverned reason names the keyword basis and frames itself as a candidate rather than a fact — so the old as-fact phrasing can never silently return. The real fix for the brittleness (an LLM-judged resolver that understands meaning, not just keywords) is tracked separately; this change makes the current heuristic honest about what it is in the meantime.

## What ships when

This ships now as a small correctness fix to already-merged harness code. The semantic (LLM-judged) resolver that removes the brittleness is the Phase-2 follow-up.
