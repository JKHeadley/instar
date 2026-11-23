# Make Failed Message Delivery Honest

## What Changed

A failed Telegram injection no longer seeds the successful-delivery cache. Known before-send refusals may be attempted later; uncertain sends retain separate same-source suppression and never produce a false Delivered response. The forwarding route observes the actual callback refusal before acknowledging it. The known baseline refusal records truthful attention and an agent-owned existing commitment, including an exact source reference, and inspects persistence and notice receipts.

## What to Tell Your User

If the conversation cannot verify a message handoff, it says what happened to that attempt instead of pretending delivery succeeded. The agent retains a responsibility to investigate and report what can be verified. It will not automatically repeat an uncertain message. This change does not guarantee eventual delivery or alter session identity binding.

## Evidence

Build and55lint checks passed before the final source-reference metadata correction. Earlier targeted cohorts and the original fixture failure are retained separately; final affected-file checks and complete verification of the eventual pushed head remain required. No live repair is claimed.

## Summary of New Capabilities

The existing attention and commitment reads retain a source-specific refusal and agent-owned investigation without adding replay authority or a new inbox.
