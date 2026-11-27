# Convergence Report — Sign-in repair: answer Google's 2-Step Verification phone prompt with the saved authenticator code

**Spec:** [docs/specs/relogin-authenticator-over-phone-prompt.md](../relogin-authenticator-over-phone-prompt.md)
**Slug:** `relogin-authenticator-over-phone-prompt`
**Converged at:** 2026-11-26T23:45:00.000Z (round 6, the Tier 2 cap)
**Iterations:** 6
**Final-round design findings:** 2 (both non-safety). Both were fixed in the final edit; the fixes were not re-reviewed, because round 6 is the cap. See "Left behind".

---

## Cross-model review: codex-cli:gpt-6.2-astra

A real GPT-tier external pass ran in all six rounds through the agent's codex CLI. A separate clean-door Claude read (claude-code:claude-fable-5-2) also ran every round. It is recorded separately and is not counted as cross-model.

Standards-Conformance Gate: ran every round. Flags by round: r1 2, r2 2, r3 2, r4 1, r5 1, r6 3. Every flag was engaged; the recurring advisory ones are listed under "Left behind".

## ELI10 Overview

When one of the agent's subscription accounts gets signed out, Instar can sign it back in by itself, using a short-lived helper session that drives the account's own Chrome. Google often asks for a phone tap first ("Check your phone"). The helper always stopped there and waited for a person, even when the account's authenticator secret was already saved. That stopped two repairs on November 25 and 26.

The change lets the helper, on a Google page headed exactly "2-Step Verification", choose "Try another way" and enter the authenticator code. It only does so on accounts that sign in with a password plus a saved authenticator, and only with Instar's permission for each step. Google's real security checks ("Verify it's you", unusual activity, a CAPTCHA) still go to a person.

The behaviour starts in a watch-only mode on development agents. It is turned on per machine only after recorded evidence and one test-page run check out. The first three real uses on each machine are then reviewed one at a time, and a single bad review switches it off on that machine for good. The fleet keeps today's behaviour until later evidence supports a separate change.

## Original vs Converged

The original spec only rewrote the helper's instructions: when an authenticator is saved, choose "Try another way" at a phone prompt. Review moved almost all of the safety into code and process:

- **What may act and where.** The trigger narrowed from "a phone prompt" to "a page whose heading reads exactly 2-Step Verification, on accounts.google.com". Risk warnings take precedence, and an unclear page means today's behaviour.
- **Who decides.** The helper used to decide alone. Now the server answers "proceed" for each step: it checks the mode, the origin and the heading, allows at most two codes, refuses any code after a refusal or a failed review, and keeps a code-count that survives a restart.
- **Retries.** Any granted, rejected or refused code, and a missing authenticator option, now block automatic retries, so a stale secret costs one stop, not a loop.
- **Rollout.** The change used to be on for everyone at once. It is now dev-gated, starts in shadow, needs a test-page run per driver family before it is turned on, and is limited to Claude Code helper seats, whose transcripts can be audited.
- **Supervision.** The server now enforces review of the first three uses per machine. Uses and reviews are kept in never-pruned tables; a resumed repair counts as a new use; a fail is accepted at any time and closes the step for good.
- **Skill text.** Instead of rewriting the by-hand sign-in guide fleet-wide, the change adds one line: in a repair, the prompt wins. The by-hand rules and the risk-check row are unchanged.
- **Honesty.** The spec now says plainly what the evidence cannot see: the helper's reports are self-reports, and a successful misread is visible only in the transcript.

## Experience fit

- **Goal and source.** The Chief of Staff handoff of 2026-11-26 asks that every subscription account stays signed in on every machine by itself, with one clear ask only when that is impossible. Justin's question at 10:43 PT that day asked why auto-login felt broken.
- **Ordinary journey.** In shadow, nothing changes for the operator: a phone prompt still asks for one tap. After graduation, a qualifying account's phone prompt is answered with the saved code and needs no human. During the first three supervised uses on a machine, a second use waits for the previous review and falls back to today's single tap.
- **Contrasting cases.** Accounts without an authenticator (two accounts without an authenticator) see no change. A direct code page is unchanged. Non-English pages never get the step. A Google list with no authenticator option ends in one operator handoff instead of a phone tap.
- **Evidence and limits.** Two live stops motivate the change. Whether Google lists the authenticator under "Try another way" is unmeasured until the step is on. Shadow tests the helper's read and judgment, but not code entry.
- **Ask load.** The change removes the phone-tap ask for qualifying accounts once a machine has graduated, adds no operator approvals (the reviews are the agent's), and adds a few extra taps during shadow and supervision. Reviewers judged this proportionate to the authority granted.
- **Trust surface.** One new Bearer review route. The latch paces the rollout; it is not a security boundary against a helper that ignores its prompt, and the spec says so.

## Iteration Summary

| Iteration | Reviewers who flagged design issues | Design findings | Precision findings | Spec sections changed |
|-----------|-------------------------------------|-----------------|---------------------|-----------------------|
| 1 | codex, clean-door, security, adversarial, integration, decision, lessons; SCG | 14 | 12 | Decision, Changes, Observability, Rollback, posture, commitments |
| 2 | codex, clean-door, adversarial, lessons, integration; SCG | 11 | 10 | heading rule, server gate, shadow, Windows read, graduation, awareness |
| 3 | adversarial, decision, lessons, codex, clean-door; SCG | 6 | 7 | supervision latch, cap exemption, origin, seat restriction |
| 4 | codex, clean-door, internal panel; SCG | 8 | 9 | direct-code path, use counting, durable reviews, route test |
| 5 | codex, clean-door, internal panel; SCG | 7 | 8 | inconclusive result, any-drive-live refusal, uses table |
| 6 | codex, clean-door, internal panel (0 safety); SCG advisory | 2 internal (non-safety) + external | 6 | live fail, fail without a use, fixture run, suggested reviewable |

## Full Findings Catalog

Each round's findings and their resolution, as recorded during the run:

- **Round 1:** heading-based distinction; the hard-line row kept; the misread metric; rejected codes and the retry loop; the population claim; the skill surviving a revert; the review cadence carrier (CMT-035); the driver-path owner (CMT-034); stale base and upgrade note; posture of audit rows; pool view claim; migration CRLF; agent-run subsection conflict.
- **Round 2:** server gate on intent and code; slow retry counting rejected and refused codes; risk precedence and ordinary subtext; the no-option fallback; shadow would-use/stop; the Windows heading read; graduation per driver family with a dated check (CMT-036); the server check reworded as a gate, not corroboration; dedupe keyed on label; classifier edge characters; awareness entry; per-machine setting; rollback wording.
- **Round 3:** the server supervision latch; cap exemption; code without intent refused; table wording; stale comment; hard line 2 wording.
- **Round 3 external:** any granted code blocks retry; the pre-submission heading in reports; one revert rule; Claude Code seats only; origin key; server mint considered and declined.
- **Round 4:** direct-code path unchanged; use counting; fail over a pass; restart-safe code count; review only for a finished repair; durable reviews table; fail stops codes mid-drive; route test; ELI16 wording.
- **Round 5:** the grant record is never dropped; an inconclusive result; metric tied to the switch path; reviews refused while any helper is live; uses table keyed by drive; code count bounded by the latest approval.
- **Round 6:** fail accepted at any time, including without a use; hard line scoped to the switch path; no-option blocks retry; fixture run required for graduation (CMT-038); suggested repairs reviewable; comment and wording fixes.

## Proportion

Tier 2. About 13 files changed, around 600 lines of code and tests plus the spec. Six rounds were used against a cap of six. The effort is large for what started as a prompt-text change, because the change grants a new authority over real Google accounts. Most of the growth came from moving that authority behind server checks, evidence and supervision.

## Left behind

- **Round 6 design findings, fixed and not re-reviewed (cap):** a fail is accepted while a helper runs; a suggested repair is reviewable. Both fail toward today's behaviour.
- **Accepted: the gate is cooperative.** A helper that ignores its prompt could still make a code from the vault entry. Server minting was declined because it would slow the direct-code path that already works. The transcript review is the backstop.
- **Accepted: the reviewer is the agent, not the operator.** An operator tap per pass would bring back the asks the change removes.
- **Accepted: "why exactly 3" (SCG advisory, rounds 3–6).** 3 is a minimum, the reviewer can hold the latch closed longer, and weekly review continues after.
- **Accepted: the two-code limit is a conservative floor.** It is not a measurement of Google's own threshold.
- **Accepted: the server checks the reported heading, not the page.** A server-side read was rejected because the helper drives an ordinary, non-debuggable Chrome.
- **Later:** a language-independent URL-path signal in shadow (unverified); more fixture cases (cost); the fixed-driver version of the change (CMT-034).
- **Precision items:** wording consistency fixed in the final edit; a test title corrected.

## Convergence Verdict

Converged at round 6, the Tier 2 cap. The final round found no safety, security or data-loss design issue. Its two other design findings were fixed in the final edit, and the accepted risks are listed above. The spec is ready to approve and build. Its tests still need a run through the shared test line and Local Verify, because the M5 is reserved.
