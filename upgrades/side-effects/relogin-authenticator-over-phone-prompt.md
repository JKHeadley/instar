# Side-Effects Review — Sign-in repair answers Google's 2-Step Verification phone prompt with the saved authenticator

**Version / slug:** `relogin-authenticator-over-phone-prompt`
**Date:** `2026-11-26`
**Author:** `echo (Subscription Management, Mac M5 Pro)`
**Second-pass reviewer:** `independent second-pass agent, 2026-11-26 15:47 PT (concerns raised and resolved below); plus the six-round spec convergence`

## Summary of the change

The agent-session sign-in helper may now answer Google's 2-Step Verification phone prompt with the saved authenticator code on `password+totp` accounts. It does so only with the server's `proceed` for each step: the mode must be `on`, the origin `https://accounts.google.com`, the heading exactly "2-Step Verification", and at most two codes are allowed. Risk checks still go to a person. The setting `subscriptionPool.assistedRelogin.authenticatorOverPhone` is shadow by default on development agents and off on the fleet. A server latch supervises the first three uses per machine, with reviews recorded through `POST /subscription-relogin/EPISODE/authenticator-review`. Any granted, rejected or refused code, or a missing authenticator option, blocks automatic retries. One skill line is added, with a migration. The change is Tier 2: 18 files and about 1,400 lines in the staged diff, counting code, tests, the spec, its overview, the report and this review; 6 spec review rounds. Spec: docs/specs/relogin-authenticator-over-phone-prompt.md.

## Decision-point inventory

- Helper judgment at the 2-Step Verification page: judgment-candidate within a floor (exact heading, origin, two codes, the unsure default).
- Server gate on intent and code requests: cooperative invariant.
- Supervision latch: invariant, server-enforced.
- Retry blocking via challengedSinceAdmission: invariant.
- Risk-check hard line: unchanged invariant, now with precedence over the heading.

## 1. Over-block

Accounts on non-English Google pages never get the step (the heading test is English), so they keep today's behaviour. A miss or refusal before the switch falls back to today's phone tap; that includes a second use waiting for review during supervision. After the switch to "Try another way", any refusal (`heading-not-2sv`, `code-limit`, `review-failed`, `no-intent`), a second rejected code, or a list with no authenticator option ends at the operator-only `phone-confirmation` hard line and blocks automatic retry. That fails closed, but it is one operator handoff where a phone tap might have done. Nothing that works today is blocked: direct code entry is unchanged in every mode.

## 2. Under-block

A helper that ignores its prompt could still make a code from the vault entry; the gate is cooperative, and the transcript review is the backstop. A successful misread of a risk page as the 2-Step Verification page is visible only in the transcript. Two machines repairing the same account could each use two codes. Any agent session holding the agent's Bearer token, not only Subscription Management, can record reviews and so open the latch; as the spec says, the latch paces the rollout and is not a security boundary. A helper session that survives a failed kill keeps counting as driving until it is gone, which closes the self-review window the second pass found. All of these are stated as accepted risks in the spec.

## 3. Level-of-abstraction fit

The behaviour lives in the server-rendered helper prompt, the helper's notice route and the per-machine repair store, which is where the helper path's decisions already sit. The fleet-default fixed page-class driver is not changed; that is CMT-034.

## 4. Signal vs authority compliance

No brittle detector gains blocking authority over anything else. The heading and origin checks only narrow when the new step may run. A miss before the switch falls to today's phone tap; after the switch it fails closed at the hard line (section 1). The judgment about risk pages stays with the model, judged by meaning, within the floor.

## 4b. Judgment-point check (Judgment Within Floors standard)

The one competing-signals point (is this the 2-Step Verification page or a risk check?) is a judgment-candidate with a declared floor, an arbiter (the helper, then Subscription Management's transcript review), a conservative default and shadow evidence before authority.

## 5. Interactions

- `challengedSinceAdmission` gains five LIKE patterns, all scoped to `helper-authenticator-*` labels. The integration reviewer confirmed that no other consumer reads those classes.
- The new tables `authenticator_uses` and `authenticator_reviews` are only read by the latch.
- The migration runs after the existing sign-in skill migrations and is idempotent.
- No interaction with backup-code handling (#3920): backup codes stay out of unattended repair.

## 6. External surfaces

- One new Bearer route (`POST /subscription-relogin/:episodeId/authenticator-review`), listed in CapabilityIndex.
- `GET /subscription-relogin` gains `authenticatorSupervision`.
- One new config key.
- The helper prompt and one skill line change.
- An awareness entry tells agents about the setting, the events and the latch.
- The step acts on real Google accounts, only for accounts already on the operator's no-ask list for unattended repair, and only after graduation.

## 6b. Operator-surface quality

Not applicable: no dashboard, approval page or grant form is changed.

## 7. Multi-machine posture (Cross-Machine Coherence)

- **Unified:** the helper prompt and the skill line. Every machine renders the same text.
- **Machine-local, physical-credential-locality:** the setting value (in each machine's git-ignored config), the uses and reviews tables, and the audit events. They govern how that machine's helper uses that machine's own logins.
- **Routing:** a review must be POSTed to the machine that ran the use; the pool view does not route it.
- **A fail is per machine:** it closes only that machine's latch. A confirmed misuse is shut off on the other machines by the review's revert decision (CMT-035), not by the latch.
- **No user-facing notices:** the change sends none of its own, so no one-voice gating is needed.
- **No URLs or topic-bound state:** it generates no URLs and holds no state tied to a topic.

## 8. Rollback cost

- **Per machine, at once:** record a fail review, which closes the step on that machine permanently, or set the setting to shadow or false and restart.
- **Full:** revert the PR; the prompt returns to the old text on restart.
- **What a revert leaves:** the added skill line stays in installed skills and is harmless. The new tables and events stay and are ignored by old code.
- **Data:** no data migration is needed.

## Conclusion

The six-round review moved this change from a prompt-only edit to a server-gated, supervised, dev-only rollout with honest residual risks. It is clear to ship once its tests pass through the shared test line and Local Verify (the M5 is reserved, so they have not all run yet).

## Second-pass review (if required)

**Reviewer:** independent second-pass agent (2026-11-26 15:47 PT)
**Independent read of the artifact: concern, resolved**

- The fallback after the switch was misstated: fixed in sections 1 and 4.
- Who can record reviews, and a self-review window after a failed kill, were left out: both added to section 2. The code now kills the helper before dropping its live entry, and counts a surviving session as driving until it is gone (`isAnyDriving`, with a unit test).
- A fail's scope on other machines: added to section 7.
- The docstring now says five retry-blocking families; the change size states what it counts.

## Class-Closure Declaration (display-only mirror)

- **Trace declaration:** `defectClass: unbounded-self-action`, `closure: n/a`. Reason: the change adds no new self-triggered action. It only adds stop conditions to the existing slow retry (rejected, refused, granted or no-option authenticator outcomes now count as challenges, so fewer retries run). The new review route and helper notices are request-driven, never self-triggered.
- **Also recorded (registry and this mirror; the trace holds one class):**

- `defectClass: novel` → registered as `over-broad-stop-rule` in docs/defect-classes.json (status unconfirmed, nearestExistingClass brittle-keyword-authority).
- `closure: gap`, with gap item ACT-001 on the Mac M5 Pro (a class-level guard: every hard line in a server-rendered agent prompt names the risk it guards and the neighbouring case it must not catch, with a test that pins both). An unconfirmed class cannot carry `closure: guard`.

## Evidence pointers

- Mama PC episode 804b1744 (account B, 2026-11-26 22:41Z, agent-hard-line-phone-confirmation).
- Laptop episode 809f5ae7 (account A, 2026-11-25, phone-tap-requested then agent-helper-exited).
- First unit run: 5 files, 51 passing at 14:57 PT, before the later revisions.
- Convergence report: docs/specs/reports/relogin-authenticator-over-phone-prompt-convergence.md.
