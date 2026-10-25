# ELI16 — the ratification check now finds your approval after the merge, not only before it

## The one-sentence version

The check that verifies you approved a constitutional change only looked for your approval while the pull request was open; on the merge itself it never looked at all, read "I have no file to read" as "there is no approval", and refused — which turned the main branch red after every change you had, in fact, approved.

## What already exists

Changing the constitution (`docs/STANDARDS-REGISTRY.md`) requires your ratification. There used to be exactly one way to give it: an Ed25519 signature, from a key that was never created — so for five days no registry change could pass its own check.

On 2026-08-22 you chose a second route, and it is now the real one: **your approving review on the pull request IS the ratification.** GitHub holds the change for you specifically, because the registry has you as its code owner. The check reads that review and confirms three things mechanically — the review says APPROVED, it came from the repository owner, and it is bound to the exact commit being merged rather than to some earlier version of it.

The security boundary is **not** this check. It is the repository's own ruleset — code-owner review required, and any approval cancelled the moment new code is pushed. That ruleset is yours and an agent cannot edit it. The check exists for legibility: to say, in the build output, which articles changed and whether an approval is bound to this exact commit.

## What was broken

The check gets its evidence from a small step in the build that asks GitHub for the pull request's reviews and writes them to a file. That step was gated to run **only on the pull-request event**.

A merge to the main branch is a *different* event. On that event the step never ran, so the file was never written, so the check found nothing to read — and reported "review unavailable". Which reads exactly like "you did not approve this."

You had approved it. Minutes earlier. On the pull request that produced that very commit.

The consequence was not subtle: the main branch went red at 05:05 on 2026-08-23 and stayed red across three consecutive merges, every one of them a change you had personally approved. Worse, the state was unfixable from where it stood — there is no pull request to approve on a merge commit, so no action by you could ever have satisfied it.

## What changes

The evidence is still reachable after the merge. It just has to be reached through the commit instead of through the event.

The step now runs on both events. On a merge it asks GitHub "which pull request produced this commit?", then reads that pull request's reviews and its head commit, and hands them to **exactly the same evaluator as before**. Nothing about what counts as a valid approval changes — same three conditions, same strictness.

One detail that matters: a commit can be linked to several pull requests, so the step does not take the first one in the list. It matches on the merge commit itself, which is GitHub's own record of "this pull request produced this commit". That was verified against two real merges of yours from last night rather than assumed from documentation.

## The safeguards, in plain terms

- **Nothing gets easier to approve.** A merge commit with no pull request behind it — someone pushing straight to main — resolves nothing, and the check refuses exactly as before.
- **A broken connection cannot become a pass.** If GitHub is unreachable, rate-limits us, or returns something unexpected, the step writes an empty file rather than failing. The check then sees no approval and refuses. "We couldn't check" can never turn into "we checked and it was fine."
- **The mistake cannot come back quietly.** The build's own self-description now REFUSES the event gate that caused this. Re-adding it, or removing either input the merge path needs, fails a check instead of silently returning to the broken behaviour. Three tests pin those three routes.

## What you actually need to decide

Nothing. This needs no approval — it touches no constitutional text. It is here because the main branch is red until it lands, and because the reason it went red is worth reading once: a check that could not tell "the operator did not approve" apart from "nobody asked".
