# Convergence Report — Skill-driven sign-in repair

**Spec:** [docs/specs/skill-driven-signin-repair.md](../skill-driven-signin-repair.md)
**ELI16:** [docs/specs/skill-driven-signin-repair.eli16.md](../skill-driven-signin-repair.eli16.md)
**Slug:** `skill-driven-signin-repair`
**Status:** **CONVERGENCE-FAILED at the 10-iteration cap.** Round 10 still had design-class findings, and the rule requires two consecutive design-quiet rounds.
**Iterations:** 10
**Convergence tag:** NOT written. `review-convergence` is absent, so `/instar-dev` stays blocked. Retrying needs the operator's input, per the skill's hard cap.

## Cross-model review: codex-cli:gpt-5.5

A real GPT-tier external pass ran through the agent's codex CLI in every round (1–10). A clean-door Anthropic second read (`claude-code:claude-fable-5`, `crossFamily: false`) also ran every round. It is disclosed separately and does not count as the cross-model pass. Gemini was not authed (`gemini-not-authed`), so no Gemini-tier pass ran.

**Caveat, disclosed honestly.** In rounds 2, 4, 5, 7 and 9, the author made small edits between launching the external reviewers and launching the internal ones. The externals in those rounds read a body a few lines older than the internals did. Every edit was then read by the next round's externals, except the post-round-10 edits, which no reviewer has read.

**Deviation from the skill, disclosed.** The six internal perspectives ran as three subagents, each covering two lenses:

- security + adversarial (with P20);
- integration + scalability (with Standards A and B);
- decision-completeness + lessons-aware.

Round 1 used six separate subagents. The Standards-Conformance Gate ran every round.

## ELI10 Overview

Instar has an automatic "sign-in repair" for when a Claude or Codex subscription gets signed out. It has never once worked for real. Its browser-clicking step follows fixed rules, and real sign-in pages keep showing things the rules don't expect. On 25 September those rules stopped both Laptop accounts within three seconds. An ordinary agent session then signed both in within ten minutes, just by looking at the screen and clicking like a person.

The spec hands that clicking step, on a Mac, to a short-lived agent session that works like a person. Everything that decides whether the repair worked stays in code: starting the login, passing the final code, and checking the right account is signed in and working. Passwords are never shown to the session. The server types them, and only after checking that the front Chrome window is the one it opened, that the page is a real sign-in page, and that the focused box is an empty password or code box.

The trade-offs:

- The session has the same machine-level trust as any agent session. That is stated as an explicit decision, and rollout starts with the operator approving each repair.
- Unattended repair only works on a Mac that has a spare healthy Claude seat, an unlocked screen and the right macOS permissions.
- The exact incident that motivated this (both Laptop accounts signed out together) would still go to the operator. The operator's part can be finished from a phone.

## Original vs Converged

- **Code hand-off.** Originally the session was to submit the Claude code through "the existing submit-code route". No such route existed for repairs; that route belongs to a different flow. After review, four episode-bound routes exist only while the episode is waiting on its session, with a per-episode token: brief, code, report and type-secret. The code feeds the unchanged in-memory paste-back path.
- **Passwords.** Originally the only protection was skill prose ("passwords only on Google or Claude pages"). After review, the session never sees a password. A server route types it after checking the pid, the origin, page focus, an empty field of the right kind and a settings-redirect refusal. It re-checks afterwards, and use limits apply per episode.
- **Security breaker.** Originally a session's own report of "captcha" or "wrong account" would lock the account for 24 hours. After review, reports only hand off to the operator. Only the server's measured wrong-identity opens the breaker.
- **Operator contact.** Originally the session was bound to the operator's Telegram topic and could chat freely. After review, it has no topic. The server sends fixed-text notices: a phone tap is needed, the console is unavailable, no seat is available, or it handed off.
- **State and concurrency.** Originally a new episode state was added and the session "waited in approved" for a slot. After review, it runs inside the existing `browser-driving` state (rollback-safe). A store index enforces one repair per machine at approval time with no queue. The service tick no longer blocks for 15 minutes, restart and boot cleanup are defined, and the session is never revived.
- **Honesty about scope and trust.** After review, the spec states four things plainly. The motivating incident goes to the phone path unless a third seat exists. The session is a trusted local operator. The navigation origin floor from the earlier design is a named regression. The earlier driver's scope false positive is accepted off-macOS.

## Iteration Summary

Design and precision counts are the internal reviewers' own declared classes. External reviewers do not classify; their verdicts are noted.

| Iteration | Reviewers who flagged design issues | Design findings | Precision findings | Spec sections changed |
|-----------|-------------------------------------|-----------------|--------------------|-----------------------|
| 1 | all six internal; codex SERIOUS; clean-door SERIOUS | ~39 | ~6 | Full rewrite: routes, code floors, breaker, no topic, restart/rollback, skill+migration, maturation plan, reconciliation with agent-driven-relogin |
| 2 | sec/adv 3, integ/scal 5, DC/lessons 2; codex SERIOUS; clean-door SERIOUS | 10 | 16 | Approval gate/slot, session cap vs login TTL, drivePid, focus-field check, use limits, spawn flags |
| 3 | sec/adv 1, integ/scal 1, DC/lessons 1; codex SERIOUS; clean-door minor | 3 | 12 | Honest operator-equivalent residual, post-typing re-check, Claude-capable seat only, store-derived slot |
| 4 | sec/adv 1, integ/scal 4, DC/lessons 1; codex SERIOUS; clean-door minor | 6 | 6 | Store index for the slot, one session per *attempt*, keystroke rationale, console notice |
| 5 | sec/adv 2, integ/scal 3, DC/lessons 1; codex SERIOUS; clean-door minor | 6 | 9 | retryFailed writes transport, index over all live states, evidence scoping, glossary |
| 6 | integ/scal 1, DC/lessons 1; clean-door 2 | 4 | 9 | Notice-row clearing on entering approved, correlated-expiry acceptance, normal-browser property |
| 7 | sec/adv 1, integ/scal 2, DC/lessons 1; codex SERIOUS | 4 | 8 | Notice template branches, dashboard Sign in on a waiting cell, settings-redirect refusal |
| 8 | sec/adv 1, integ/scal 2; codex SERIOUS | 3 | 10 | Waiting-cell cancel made reachable, outcome wording, trust decision FD11, surface count |
| 9 | sec/adv 1, integ/scal 1, DC/lessons 1; codex SERIOUS | 3 | 9 | Outcome-based terminal wording, macOS permission prerequisites, typed-unverified |
| 10 | sec/adv 1, integ/scal 1, DC/lessons 2; codex SERIOUS; clean-door minor | 4 | 6 | Applied **after** the round and not re-reviewed: permission probe inside the session's launch context; Sign in on suggested/failed cells; secret-focus-lost warning never deleted; System Events fallback opt-in only |

Standards-Conformance Gate, one line per round:

- Round 1: ran (3 flags: Judgment Within Floors, Verify the State, Maturation Path)
- Round 2: ran (3 flags: Structure beats Willpower, Verify the State, Judgment Within Floors)
- Round 3: ran (2 flags: Judgment Within Floors, Verify the State)
- Round 4: ran (2 flags: Judgment Within Floors, Framework-Agnostic)
- Round 5: ran (2 flags: Judgment Within Floors, Verify the State)
- Round 6: ran (2 flags: Structure beats Willpower, Judgment Within Floors)
- Round 7: ran (2 flags: Judgment Within Floors, Mobile-Complete)
- Round 8: ran (1 flag: Judgment Within Floors)
- Round 9: ran (2 flags: Judgment Within Floors, Mobile-Complete)
- Round 10: ran (1 flag: Structure beats Willpower)

The recurring Judgment Within Floors / Structure beats Willpower flag concerns the session keeping shell and vault access. From round 4 on, every internal decision-completeness/lessons reviewer judged it adequately answered by Frontloaded Decision 11 and the named residual. The code gate keeps raising it because the design deliberately does not isolate the session.

Internal reviewer model: the authoring session's model (Opus-class) for every round; no tier drop was observed.

## Full Findings Catalog (condensed)

**Round 1 (blocking themes).**
- Nonexistent submit-code route (all reviewers).
- Prose-only floor (security, adversarial, lessons, both externals).
- Self-reports opening the 24-hour breaker (P20).
- Free-text operator channel via topic binding (MFA-fatigue risk).
- Revivable or orphaned session.
- 15-minute cap exceeding the 10-minute episode budget.
- Seat exhaustion.
- Blocking service tick.
- Skill section 3 is a troubleshooting table, not a procedure.
- Missing maturation rung.
- Silent reversal of agent-driven-relogin Frontloaded Decision 1 (clean-door, lessons).

All were resolved in the round-1 rewrite.

**Rounds 2–5.**
- Focus-field gap in type-secret: keystrokes could land in the address bar or a chat box.
- Backup-code drain.
- Approval expiry versus the slot queue.
- Capacity refusals burning attempts.
- Login TTL shorter than the session cap.
- Chrome left open after a restart.
- Codex headless sandbox cannot reach localhost, so the seat must be capability-qualified.
- "One session per episode" was false against the retry paths.
- Slot race, fixed with a store partial unique index.
- `transport` not written on `retryFailed`.
- Index state coverage.
- Evidence scoping could erase wrong-identity history, so wrong-identity was kept unscoped.

All resolved.

**Rounds 6–9.**
- Notice-row dedupe blocked later attempts' notices.
- Correlated expiry, accepted as a phone-completable operator case.
- Notice template and dashboard gaps on that phone path.
- The waiting-cell cancel branch was unreachable because the service filtered the state out.
- Terminal wording claimed "verified".
- macOS permission prerequisites were unnamed.
- Navigation-after-type semantics.

All resolved.

**Round 10 (open at the cap, fixes applied but not re-reviewed).**
- **Permission probe in the wrong process (integration, design).** Now runs inside the session's tmux launch context using preflight APIs.
- **Refused approval left no phone path (DC/lessons, design).** Sign in now also shows on suggested and failed agent-session cells.
- **Permission notice lacked variants (DC, design).** Template variants added.
- **A cleanup could delete the "a secret may have gone elsewhere" warning (security, design).** That warning is now never deleted.
- **External, not yet addressed:** codex again asked for a per-module source-delta checklist and for real-provider unknowns to be listed as preconditions. The latter was done as "empirical preconditions checked at Rung 2". Clean-door asked for fleet-wide frequency data on the delivered-scope preconditions, which is not available to the author.

## Convergence Verdict

**Not converged. Stopped at the 10-iteration hard cap.** Design-class findings fell from about 39 in round 1 to 3 or 4 per round in rounds 8–10. The remaining findings are narrow and local, mostly consequences of earlier fixes interacting with existing notice and dashboard code, rather than architectural. No reviewer in rounds 8–10 challenged the core architecture. The architecture is: a session inside the existing state, server-typed secrets, server-only success, an explicit trust decision, and approval-mode rollout.

The spec still carries no convergence tag. Per the skill, a retry needs the operator's input. The honest options are:

1. **One more pass.** Authorize a fresh convergence run on the current body, which already includes the round-10 fixes. It would likely finish in two rounds if those fixes hold.
2. **Accept or reshape the scope.** Given the delivered-scope limit, accept the design as it stands, or narrow it first.

`approved: true` is the operator's step either way.
