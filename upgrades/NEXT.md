# Upgrade Guide — NEXT (A Wall Is a Hypothesis: new constitution standard + B16 guard)

<!-- bump: patch -->
<!-- patch = new guard rule within the existing outbound authority + docs; backward compatible -->

## What Changed

**New constitution standard "A Wall Is a Hypothesis", with real structural enforcement.**

Added to the Standards Registry (The Substrate family, beside "The Right to Stand Ground"): before an agent declares a path infeasible / blocked / impossible because some interface or API is missing, it must first inventory the capabilities it already has. A limitation is a hypothesis to test against your own toolkit, not a verdict to accept. A real wall, named honestly after that inventory, is fine — the failure is surrendering without it.

Enforcement is a new always-evaluated rule, **B16_UNVERIFIED_WALL**, in `MessagingToneGate` (the same outbound-message authority that hosts B15's self-stop guard). It blocks an outbound message that declares infeasibility from a missing interface/API/mechanism when the message shows no evidence the agent checked its own tools first. Severity favors false-negatives: genuinely-external limits ("I can't read your email until you connect it"), walls reported after a visible inventory, real either/or questions, and messages discussing the rule all pass.

The standard is also registered in `docs/INSTAR-DESIGN-PRINCIPLES-AND-LESSONS.md` (P11), the catalog the `/spec-converge` reviewer loads, so specs that accept an untested wall are flagged at review time.

The registry's own "how a new standard joins" step was corrected for accuracy: the registry-wide conformance gate and the Usher that would read the registry directly are described as actively-being-built North Star surfaces, not as already live — the registry does not yet enforce itself.

## What to Tell Your User

I added a new rule to my own constitution and wired it so it actually bites. Before I tell you something is impossible or can't be done, I now have to check the tools I already have that might get past it. The reason is a recent miss where I called a feature impossible because it had no official hookup for other programs — while forgetting that typing into a live session is one of my core abilities. A checker now reads my outgoing messages and stops me if I claim something is blocked without first showing I looked. The balance matters: this is not me never giving up. Real dead-ends, named after I've actually checked, go through fine, and so do normal limits like needing you to connect an account first. You should just notice fewer "that's impossible" answers that fall apart the moment you push back.

## Summary of New Capabilities

- New constitution standard "A Wall Is a Hypothesis" in the Standards Registry (The Substrate family).
- New outbound-gate rule B16_UNVERIFIED_WALL blocks unverified infeasibility claims; biased toward false-negatives so ordinary messages pass.
- Standard registered as principle P11 in the design-principles catalog the spec-review reviewer reads.
- Registry governance step corrected to distinguish enforcement that is live today from the conformance gate and Usher being built.

## Migration Notes

No action required. `MessagingToneGate` runs server-side, so the rule ships with the server on update — no per-agent migration. The changes to the Standards Registry and the design-principles catalog are repository documentation.

## Evidence

- **Unit** (`tests/unit/messaging-tone-gate-b16.test.ts`, 9 tests): the B16 rule + its infeasibility markers + carve-outs render in the prompt; the gate accepts B16 as a valid rule id without fail-open on the /goal-style wall; both sides of the boundary pass correctly (wall-after-inventory, genuinely-external limit, rule-discussion); drift detection preserved (an invented rule id still fails open).
- **Integration** (`tests/integration/telegram-reply-b16-wall.test.ts`, 2 tests): through the real POST /telegram/reply route, a B16 block returns 422 with rule B16_UNVERIFIED_WALL and the message is not sent; a passing reply still delivers 200.
- tsc clean.
