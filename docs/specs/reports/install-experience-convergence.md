# Convergence Report — Install experience

**Spec:** [docs/specs/install-experience.md](../install-experience.md)
**Stopped at:** round 6 of 6

## Cross-model review: codex-cli:gpt-6-astra

Astra ran on every round through the Codex CLI. Internal reviewers ran on Fable (`claude-fable-5-1`), as the operator asked. Rounds 2 to 6 combined lenses into fewer reviewers rather than running six separately, which is a disclosed reduction from the skill's default.

## Convergence honesty

**No round came back quiet from Astra.** Fable reached no design findings on two of the three specs in round 6, with one low finding on the third. Review stopped at the Tier 2 cap of six rounds. **The round 6 fixes were written after the last review and have not themselves been reviewed.** They are one-sentence contract statements rather than new mechanisms, and implementation review covers them.

## Iteration Summary

| Round | Reviewers | Design findings | Spec changes |
|---|---|---|---|
| 1 | Six separate Fable reviewers, Astra | About 45 across lenses | Enrollment, reachability floor, door proof and PIN inventory added |
| 2 | Three combined Fable reviewers, Astra | 14 | Split into three specs, phase order fixed |
| 3 | One combined Fable reviewer per spec, Astra per spec | 17 | Non-replayable approvals, reset defined, relay connection defined, headless path |
| 4 | One combined Fable reviewer, Astra per spec | 13 | Origin table, action states, local name, autostart, browser routes |
| 5 | One combined Fable reviewer, Astra per spec | 9 | Owner record simplified to a chain with a fork rule, admin reset, redeem predicates |
| 6 (cap) | One combined Fable reviewer, Astra per spec | 8 (1 from Fable, 7 from Astra) | One-sentence machine-key rule, fork-rule validation, legacy unlock end state, dashboard transport, relay fencing and takeover bootstrap |

Standards-Conformance Gate: round 1 ran, output not read because of a parsing mistake on my side; round 2 ran (2 flags); rounds 3 to 5 not run, an omission; final state ran on each spec (flags below).

## Proportion

Tier 2, 6 of 6 rounds, three specs totalling about 50 KB. The split at round 2 kept them reviewable.

## ELI10 Overview

We're making Instar installable by a normal person with one command, from an AI tool they already use, or with the iPhone app alongside. It explains what an agent is, asks a few questions, installs what's missing, and proves it reached the person. Nobody needs Telegram, Cloudflare, a phone or any service we run.

The tradeoff is more installer engineering. Some things are honestly limited: the app can't start a computer, API keys and local models wait on proof, and a phone away from home needs a private address until the relay ships.

## Original vs Converged

The first draft put everything in one spec and assumed the phone could start things. Review separated the concerns, moved sign-in ahead of owner setup, gave AI tools a way to run the installer without hanging, defined what "delivered" means per channel, added a messaging-free way to stay reachable, and made sure the agent survives a reboot.

## Standards gate on the final text

Standards gate flags on the final text: Mobile-Complete (headless and first install need a terminal: accepted) and Maturation Path (fixed by adding the test-agent rung).

## Left behind

See the spec's `## Left behind` section. Precision findings were not iterated on.

## Full Findings Catalog

Findings per round are summarised above and resolved in the spec's sections. Headline findings by source:

- **Astra:** optional messaging lacking replacement paths, route lists not moving phones between machines, phase-order prerequisites, passphrase-only owners, browser credential custody, current authority, replay envelopes, revocation cycles, redeem transport, reliability of browser routes, relay fencing and takeover bootstrap.
- **Fable:** the ownership race, trust-anchor handling, sibling trust, recovery display, harness hanging, first-minute liveness, passkey-first simplicity, origin classes, machine keys, relay certificates and abuse.

## Convergence verdict

Stopped at the round cap. The final Fable pass found one low design item, now fixed in one sentence; Astra's final findings are also folded in. **Those last fixes are unreviewed.** Spec is ready for the operator's review.
