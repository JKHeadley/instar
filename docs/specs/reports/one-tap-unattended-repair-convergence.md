# Convergence Report — One tap turns on automatic sign-in repair for every account on every chosen machine

## Cross-model review: codex-cli:gpt-6-astra

A real GPT-tier pass (codex CLI, gpt-6-astra) ran in all six rounds. A Claude clean-door read (claude-code, opus) also ran every round; it is recorded separately and is not counted as cross-model. Gemini was not signed in on this machine.

## ELI10 Overview

Instar agents can sign a Claude or Codex account back in by themselves when it gets signed out, but only on machines where that is switched on, and only for the accounts on that machine's list. Today there is no button for this anywhere, it works one machine at a time, the lists are out of date with nothing on screen saying so, and a second setting change after an update could be saved without ever taking effect.

This change adds a section to the dashboard's Accounts page. After one PIN unlock, the operator ticks machines and taps once. Every machine that is already set to "repair without asking" gets its account list brought up to date, and the operator's own machine can be switched on from any state. A machine set to "ask first", watch-only or off is never escalated from another machine; it is switched on from its own dashboard. A second button switches machines back to asking first. The restart that applies a setting is fixed so it can no longer be silently skipped.

The trade-off: a tap reaching another machine travels as a signed, single-use permission for that exact machine and setting. That adds real machinery (a signed permission, a fingerprint of the setting, a write counter and a "has it changed since you looked" check), but it reuses the existing one-click repair path, and every piece answers a specific failure the review found.

## Original vs Converged

- **Who can start it.** Originally the new route reused a guard that also accepts the PIN typed into the request body with no limit on guesses. Now it accepts only a fresh dashboard unlock, like the existing route. The spec also states honestly that the PIN is a human-presence signal, not a lock against the agent itself.
- **Delivery to other machines.** Originally it would have failed on most machines, because two existing gates refuse any mandate unless account follow-me is on. Both gates now admit this one shape.
- **Ordering.** Originally a late "turn on" could undo a newer "switch back". Now every write bumps a counter and each request names the exact setting it expects to find, so stale requests are refused, including the A→B→A case.
- **What another machine accepts.** Originally any list of emails. Now only that machine's own accounts, never lower waits, never off or watch-only, and never "without asking" on a machine not already set that way.
- **Restart.** Found in review: the existing route's restart was shaped like an update restart and could be skipped. Fixed for the existing route too.
- **Where the button lives.** Originally the old Subscriptions page; moved to the console Accounts page, which replaced it.
- **Consent.** Round 5 added a recorded per-machine consent flag. Round 6 dropped it: other machines' dashboards are not reachable from the operator's phone, and the PIN is agent-wide, so the flag would block the goal while guarding nothing.

## Iteration Summary

| Iteration | Reviewers who flagged | Design findings | Left behind | Spec changes |
|---|---|---|---|---|
| 1 | security, integration, decision-completeness, lessons, codex, clean-door | 14 | 9 | full rewrite: header-only guard, both delivery gates, target identity check, CAS, unversioned restart, honest authority section |
| 2 | integration (combined internal), codex, clean-door | 7 | 8 | monotonic generation (A→B→A), owner-consent mode check, console page, on-disk revision, outcome-unknown |
| 3 | combined internal, codex, clean-door | 5 | 4 | runtime-exact mode reading, local enable path, remote "without asking" only on unattended machines |
| 4 | combined internal, codex, clean-door | 8 | 7 | posture markers pass the lint, tick persistence, Finish restarting, button-specific preview, remote waits unchanged |
| 5 | combined internal, codex, clean-door | 4 | 5 | restart-only Finish operation, approval works after an account left the pool, consent flag (later dropped) |
| 6 | codex, clean-door | 5 | 4 | consent reasoning replaces the flag, Finish consumes its mandate, results carry the applied revision |

Standards-Conformance Gate: ran in round 1 (3 flags: fixed limits, hard-coded mandate author, no phone-completable reversal; all resolved). Rounds 2–6: not re-run; the spec's per-standard flags were covered by the lessons-aware lens of the combined internal reviewer.

Internal reviewers ran on claude-opus-5-5 (the authoring session's model) every round. Round 1 split the six lenses across three reviewers. Rounds 2–5 used one combined reviewer covering all six lenses. Round 6 ran externals only, at the cap.

## Proportion

⚠ Tier 2, six rounds (the cap). The spec is about 390 lines. Design findings ran 14, 7, 5, 8, 4, 5 and did not fall steadily after round 3. In round 6 the response was to cut (the consent flag was dropped) rather than add more machinery.

## Left behind

- Foundation gaps filed as feedback fb-ae274b03-db6 (not fixed here): the PIN-in-body fallback with no attempt limit on the existing relogin routes; any active peer counting as the operator machine for delivered mandates; hard-coded `author: 'justin'` defaults.
- Round-6 findings were applied but not re-reviewed (the cap was reached). Accepted risk: they were consistency fixes (Finish consumes its mandate; results carry the applied revision) with direct unit and integration tests.
- An update restart that is itself skipped by the per-version cap would also defer this setting. Accepted: it belongs to the update path.
- The delivered-mandate store never prunes; each tap adds one record per peer. This already exists for repair-cell and is not new here.
- Asking the agent to send the section's link when an account is added relies on the CLAUDE.md trigger. Accepted, because each uncovered repair still asks through the existing Home need.
- "Will still ask until N repairs / D days" on other machines whose waits are not zero: shown on the row, never changed remotely.

## Full Findings Catalog

Every finding, round by round, is preserved in this session's reviewer outputs and is summarised per round above. The resolution of each is reflected in the spec's sections §1–§7, Decision points, Frontloaded Decisions and Multi-machine posture.

## Convergence verdict

Converged at the round cap (6). No safety, security or data-loss finding is left unresolved: each was resolved in the spec, or filed as feedback where it belongs to the existing foundation. Open questions: none. The spec is ready to build.
