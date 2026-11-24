# Review record for local dashboard access and safe identity defaults

**Split after round 5 (2026-11-18).** Round 5 found 16 design findings across ten bundled changes, so piece 1 is now built as small specs in the umbrella's order; the first is `identity-security-piece1a-local-link.md`. This document and `identity-security-piece1.md` stay as the record of rounds 1-5; their round-5 findings are carried by the later sub-specs. Original status line follows.

**In progress.** The build spec still requires independent review and approval. The latest frozen draft is round 4. The local build has no production implementation yet.

## Cross-model review status

Gemini 4 Argon reviewed rounds 1–4. On the round-4 text it found zero design issues and five wording or documentation refinements. The independent Headley GPT-6.2 Astra reviewer returned a rate limit before producing an opinion. Fable 5.2 produced a combined opinion in round 1 and six independent opinions in round 2. Its security reviewer read the implementation sources in round 3. The other five round-3 Fable reviewers reported a subscription limit. These are separate from the verified Headley account and model used to write the spec.

## Plain-language overview

A person at the computer can open the dashboard with a single-use link. A lost browser reply must let that same browser finish the same action. The link alone cannot choose an owner or authorize a different action. Ordinary Basic sign-in continues while a change is being tested.

A member gets a private conversation. When a job needs something they wrote, the owner sees the exact text and decides whether to include it. New notices omit the PIN. An upgrade can remove an old pinned instruction once the owner has another verified way to sign in.

## Changes after review

| Original problem | Current design |
| --- | --- |
| The server could accept a link and lose the reply. | Record the action and browser key atomically. A retry can finish the original transaction until its deadline. |
| A long-lived browser key could become a standing reset credential. | A reset takes a fresh, action-bound link. The server checks the original deadline and prevents repeat effects. |
| Shared PIN throttling could lock out the legitimate owner. | Preserve a separate proven recovery route. Keep the per-credential aggregate intact across callers and sign-ins. Verify the owner's real path before rollout. |
| A restore or lease change could roll back permissions. | Keep current shares in their authoritative signed log, exclude private content from ordinary backups, and reconcile before dispatch or recovery. |
| A job might carry free-form member text into owner tools. | Isolate the reader. The server prepares one selection for the owner, with an exact job occurrence and text. A changed grant or message invalidates the selection. |
| Switching relay modes might treat old queued input as verified. | Require proof on the original input before routing or using a callback. Re-fetch through the existing authenticated source where possible. |
| An old group PIN might have been shared. | Freeze the eligible pre-migration proofs. Basic remains available during a disputed claim. Only a qualifying proof can settle it. |

## Iteration summary

| Round | Constitutional check | Human-readable outcome |
| --- | --- | --- |
| 1 | Ran, 100 standards, 4 flags | Combined Fable and Argon reviews changed link recovery, team isolation, migration and rollout. Independent Astra returned HTTP 429. |
| 2 | Ran, 100 standards, 1 flag | Six Fable lenses and Argon reviewed the revised draft. The resulting changes narrowed the link to one action, clarified app and SSH access, protected queued messages and added a rollout decision for each control. |
| 3 | Ran, 100 standards, 3 flags | Fable security and Argon inspected code foundations. Their changes addressed backup exclusions, missing-credential behavior, the relay guard, PIN accounting and the owner selection card. Five Fable lenses returned no opinion due to the weekly limit. |
| 4 | Ran, 100 standards, 1 flag | Gemini reviewed the inspector flag about ticket, expiry and rate defaults and found no design defect. Its five precision findings are recorded in the review packet. The required Fable and separate Astra reviews remain pending. |

## Evidence and decisions still open

Three existing unit test files passed all 41 tests on base commit 27061914c. They cover native local owner enrolment, PIN throttling and Windows desktop transport. The first implementation still requires its own unit, integration, production-initialization and disposable live checks.

The author rejected an outside suggestion to allow a local-only reset of a group-exposed PIN. Section 10 of the approved umbrella requires a qualifying pre-existing proof or OS administrator authentication for that case. A working remote sign-in for a new browser under sustained anonymous traffic remains a rollout prerequisite where the user's chosen route depends on it.

The per-round snapshot and original reviewer outputs are in the topic's saved handoff under reviews/r1 through reviews/r4. Continue at round 4 on the same snapshot. No convergence timestamp or post-review approval has been recorded.
