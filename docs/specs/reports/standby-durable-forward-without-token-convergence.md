# Convergence Report — A standby without the Telegram login keeps a reply when the sending machine is unreachable

## Cross-model review: codex-cli:gpt-6-astra

GPT-6 Astra ran a real external review in all six rounds. Fable 5.2 also read every round through the clean door (`clean-door-anthropic-review: claude-code:claude-fable-5-2`). That second read is not cross-family.

## ⚠ Status: STOPPED AT THE ROUND CAP — operator decision needed

The spec reached the Tier-2 cap of 6 rounds. Round 6 still raised DESIGN findings, three of them safety-class:

- the successor operation id was not actually stable on retry;
- the notice re-post could go out twice after a crash;
- peer debt entries had no closure path.

All three are resolved in the current text, but no review round has checked those resolutions. Under the skill's cap rule, this goes to the operator rather than being stamped converged. The convergence tag has **not** been written.

## ELI10 Overview

When the agent runs on two Macs, only one of them (the Studio) can actually post to Telegram. The other one (the M5) hands its replies over. If the Studio is briefly down, the M5's replies are lost, and the agent is wrongly told they might have gone through. This spec makes the M5 save such a reply and send it once the Studio is back, using the same careful mechanism machines with the Telegram login already use. The only extra piece is a public bot number, which it reads from the Studio's own answer.

Most of the review effort went into edge cases around that core. Examples: two saved replies must not cancel each other, a wrong bot must never send a saved reply, the delay notice must not arrive stale, and the other machines must know a reply is pending.

## Original vs Converged

- **Account id.** Originally the M5 cached the bot's account number in a file. The review removed the cache: it was a second source of truth, it could be poisoned, and it was empty right after boot. The M5 now reads the number fresh from the Studio before saving. If the Studio is unreachable, it uses a placeholder that is filled in later.
- **Repackaging saved replies.** Originally the spec assumed an existing way to repackage a saved reply for a new bot. The review found it didn't exist for this case. The spec now defines exactly when repackaging happens: only from the placeholder, never from one real bot to another.
- **Overtaking.** Originally saved replies could cancel each other as "out of date". Now the M5 stamps each saved-then-delivered reply, and only live replies count as newer.
- **Rollout.** Originally this would have switched on for every agent at once. Now it is switched on for development agents first, and the regular rollout review decides when it reaches the fleet, based on evidence the Studio records.
- **Honesty.** "Don't resend" is never shown for a reply that was not saved.

## Iteration Summary

| Round | Design (deduplicated) | Left behind | Main spec changes |
|---|---|---|---|
| 1 | 9 | 6 | cache removed; placeholder; local-sent guard; not-sent honesty; maturation gate |
| 2 | 13 | 8 | typed re-seal; chain walk; drain-always wiring; concrete-seal protection; per-holder short-circuit |
| 3 | 9 | 7 | read capabilities before prepare; no notice loop; holder-side evidence; ladder numbers |
| 4 | 5 | 10 | `forwardedHeld` stamp; acked evidence events; honest §9 debt; notices never held |
| 5 | 9 | 9 | stamp moved to the standby's own row; `heldMs` defined; plan-scoped ids; re-post; peer debt held open |
| 6 | 7 (3 safety) | 6 | stable id inputs; idempotent re-post; outcome report and machine-gone closure; shared reachability check; timestamp source |

Standards-Conformance Gate: it ran every round. Flags were 2, 1, 4, 1, 1 and 1. The remaining multi-machine flag is resolved by Frontloaded Decision 7, an operator ratification requested with approval.

Reviewers: in rounds 1–2, six separate internal reviewers. In rounds 3–6, three or four reviewers covered the same six lenses with some combined, recorded per round. All internal reviewers ran on claude-opus-5-5.

## Proportion

This is a Tier 2 change. The spec grew from about 1,100 words to about 5,900 words, and review used 6 rounds against a cap of 6. ⚠ That is heavy for what began as "save the reply instead of dropping it". Most of the growth answers multi-machine and maturation standards, and edge cases of the existing held-reply review.

## Left behind

- About 60 s worst-case attempt timing. It stays inside the 120 s route budget and is stated in the spec.
- Held-row growth during an outage is bounded only by the 6 h deadline.
- The `capabilities` read becomes a write when it carries events. This is stated.
- A paired machine could falsely mark replies as held. That is inside the pool trust boundary, and it is stated.
- The ladder harm metric treats a correctly handled outage longer than 6 h as harm. That is intended, because the reply is lost.
- Implementation details are left to the build: the dev-gate justification text, the release fragment name and a customised-script migration test.

## Full Findings Catalog

The per-round findings, reviewers and resolutions are recorded in the six round logs kept with this run. They are summarised above, and the spec text is the resolution of each.

## Convergence verdict

Not stamped. The review stopped at the 6-round cap while round-6 safety findings were being resolved. The spec is ready for one of two operator choices:

- approve it as is, with the round-6 resolutions checked during build by the tests in Acceptance 2–8;
- authorise one more verification round first.
