# MR1 Model Registry Review — Plain-English Overview

> The one-line version: update the reviewed frontier labels and three model-routing defaults, reconcile the runtime allowlist, and add a CI check proving every manifest pin resolves through its real runtime path.

## The problem in one breath

The registry review date was refreshed on August 18, but the live routing pins did not move with it. New Anthropic model ids were added while superseded ids stayed labelled frontier, and the Codex registry still treated the previous generation as current. That combination allowed old routing choices to remain green for another 45 days even though the vendor evidence said they were no longer the current capable choices.

## What already exists

- **A model registry** — records the reviewed frontier models available through each command-line doorway.
- **A freshness and drift check** — rejects an old review date and rejects a watched capable pin that is not in its doorway's reviewed frontier set.
- **Closed runtime model lists** — prevent a configured model id from reaching a launcher unless that id is explicitly recognized.

## What this adds

This change labels the current Anthropic and Codex models as frontier, demotes the superseded entries without deleting their history, and repoints three existing capable/default routes to the reviewed current ids. Gemini's model id stays unchanged because it remains current; its verification came from vendor documentation rather than a successful local CLI probe.

The first review exposed an important compatibility problem: the Claude tier-escalation default named `claude-opus-5`, but the independent closed runtime list did not recognize that id. MR1-B adds only the two Anthropic ids established by the vendor selector, updates the value-pinned expectations, corrects the three contradictory notes, and adds a CI check that invokes every owning resolver for every registered manifest pin.

## The safeguards

**The freshness guard is unchanged.** Its script, staleness window, enforcement mode, pin definitions, and bypass posture are untouched.

**The drift tooth still bites.** A temporary change back to the non-frontier Codex id made the real freshness command fail and name the exact offending pin. Reverting the mutation restored a clean check.

**Runtime resolvability is now checked.** The new test extracts all six concrete values represented by the five manifest pins, invokes each owning resolver, and refuses missing resolver coverage or an empty/mismatched result. Removing `claude-opus-5` from the closed enum makes the test execute and fail with the exact Claude tier pin and an `<empty>` resolved value.

## What ships when

The proposal remains a draft pull request for operator approval because it changes live model routing. The targeted suite, type-check, freshness checks, and full lint are green; draft status and disabled auto-merge remain deliberate.

## What you actually need to decide

Should the operator approve routing the three named code paths to the reviewed current frontier models with the new runtime-resolution ratchet in place?
