# MR1 Model Registry Review — Plain-English Overview

> The one-line version: update the reviewed frontier labels and three model-routing defaults to the vendor-confirmed current models, while keeping the existing freshness guard intact and refusing to hide a newly discovered routing incompatibility.

## The problem in one breath

The registry review date was refreshed on August 18, but the live routing pins did not move with it. New Anthropic model ids were added while superseded ids stayed labelled frontier, and the Codex registry still treated the previous generation as current. That combination allowed old routing choices to remain green for another 45 days even though the vendor evidence said they were no longer the current capable choices.

## What already exists

- **A model registry** — records the reviewed frontier models available through each command-line doorway.
- **A freshness and drift check** — rejects an old review date and rejects a watched capable pin that is not in its doorway's reviewed frontier set.
- **Closed runtime model lists** — prevent a configured model id from reaching a launcher unless that id is explicitly recognized.

## What this adds

This change labels the current Anthropic and Codex models as frontier, demotes the superseded entries without deleting their history, and repoints three existing capable/default routes to the reviewed current ids. Gemini's model id stays unchanged because it remains current; its verification came from vendor documentation rather than a successful local CLI probe.

The review also exposed an important compatibility problem: the Claude tier-escalation default now names `claude-opus-5`, but the independent closed runtime list does not recognize that id yet. The runtime therefore refuses the new default and returns no model. This branch records that result and must not merge in its present form; MR1 did not authorize changing the closed list or rewriting its tests.

## The safeguards

**The freshness guard is unchanged.** Its script, staleness window, enforcement mode, pin definitions, and bypass posture are untouched.

**The drift tooth still bites.** A temporary change back to the non-frontier Codex id made the real freshness command fail and name the exact offending pin. Reverting the mutation restored a clean check.

**The routing incompatibility is visible.** The targeted suite runs the real resolver and fails because the new Claude default is outside the closed enumeration. The pull request is therefore a review surface, not a claim that the change is ready to ship.

## What ships when

Nothing in this branch should ship until the operator authorizes a complete compatible change and the targeted suite is green. The current pull request preserves the reviewed registry delta, the hand evidence, and the exact blocker without merging it.

## What you actually need to decide

Should the routing correction proceed with an explicitly authorized update to the Claude closed model enumeration and its value-pinned tests, or should the Claude default remain on the prior id while the registry-only corrections are reviewed separately?
