# Fable 5.2 becomes a known model — the plain-English version

## What this is

Anthropic released Claude Fable 5.2. The Claude Code command line already serves it (asked directly on 2026-11-09, it answered and reported itself as `claude-fable-5-2`). Justin asked that every job, task and topic currently on Fable 5.1 move to Fable 5.2, including the conversation he asked from.

Instar refused: "`claude-fable-5-2` is not a known claude-code model id". That is not a policy decision; it is a list that lagged one release. Instar keeps an explicit list of model ids it will accept for a topic pin or an escalation target, precisely so a typo or a made-up name can never be pinned. The same list lagged when Fable 5.1 and Opus 5.5 came out, and each time the fix was the same one-line addition.

## What changes

- `claude-fable-5-2` joins the accepted Claude model ids, with a comment recording when and how it was verified.
- The model registry manifest records it as **recognized, not promoted**: topics and the escalation setting may now name it, but nothing in Instar starts routing to it on its own. The "capable" and "ultra" lanes and the shipped escalation default do not move; a model earns a routing lane by benchmark, not by release date. The manifest's review date is unchanged because no pin changed.

## What does not change

No topic, job or setting is repointed by this change itself. Repointing is the operator's choice, done afterwards through the normal topic-profile and config paths once this build is running. Nothing is removed from the list; Fable 5.1 stays valid, so existing pins keep working.

## Safeguards

- The pin path still validates against the list; this only adds one real, live-verified id.
- The registry freshness lint still runs on every commit; a recognized-not-promoted row cannot drift a pin.
- Reverting is deleting one line and one manifest row.

## What you need to decide

Nothing for this change. The follow-up (which topics and which setting move to 5.2) was already decided: everything on 5.1 moves, this topic included.
