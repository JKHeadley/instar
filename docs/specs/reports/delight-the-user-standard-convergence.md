# Convergence report — Delight the User (standard + commit gate)

## Cross-model review: codex-cli:gpt-6.2-astra

A GPT-tier external pass ran through the agent's codex CLI in all six rounds. Gemini was not authed on this machine (`gemini-not-authed`), so one outside family read it.

## ELI10 overview

Justin asked for a constitutional rule that every Instar screen should be a pleasure to use, and said yes to the wording Echo proposed. This change writes that rule into the constitution under the existing screen-quality rule, and makes the commit check enforce it: any change to a screen must say, in writing, how the screen reads now, show a before picture and an after picture, and get a second reader to look at them. It also fixes an old hole where commits that only touched the dashboard skipped the screen questions entirely.

## Size and proportion

Tier 2 (a constitution change plus a gate). About 350 lines of gate code and tests, a 60-line spec. Six rounds used of the Tier-2 cap of 6. ⚠ That is a lot for this size: most rounds came from the outside reviewer finding new edge cases in the screenshot evidence rules (path aliases, unreadable files, removed screens, name collisions), each a one-to-ten line fix. The design did not change after round 3.

## Iteration summary

- Round 1 — internal: Standards-Conformance Gate (registry canary ok, no at-risk items). External codex: 4 DESIGN (path aliases pass as two pictures; only first pair read; reason floor refuted by "Renamed CSS class"; native apps not exercised), 1 PRECISION (the card already broke the parent floor). All fixed except native (left behind). Session model: opus (claude-opus-5-5).
- Round 2 — internal reviewer (six angles, fresh subagent): 4 DESIGN (spec stale vs code; Tier-1 has no second reader; hashing could hang on a FIFO//dev/zero; parent §6b check hollow), 5 PRECISION. External codex: 3 DESIGN (120-char answer floor refuted; no "screen removed" form; images out of scope), 1 PRECISION. All fixed.
- Round 3 — internal: 2 DESIGN (duplicated second-pass helpers disagreed with the merge-time ones; second pass self-attested, overclaimed), 3 PRECISION. External: 4 DESIGN (self-attested review; "no visible change" skips review; unreadable identity accepted; shared file names). All fixed or stated in Under-block.
- Round 4 — internal: CONVERGED (0 DESIGN). External: 3 DESIGN (substring "card.png" in "new-card.png"; §6b "no" passes; secret screens in pictures), 1 PRECISION. Two fixed; §6b "no" stated as under-block (a meaning judgment).
- Round 5 — external: 3 DESIGN (exact path rejected by boundary rule; sole unreadable picture accepted; PR-boundary check for screen PRs), 1 PRECISION. Two fixed; PR-boundary check left behind.
- Round 6 (cap) — external: 3 DESIGN (explicit §6b outcome field; viewport labels; mixed "no visible change" + pictures), 1 PRECISION (graduation sample). Mixed declarations and graduation fixed; the other two left behind.

## Left behind

- **PR-boundary check for screen-only PRs** (round 5): a merge-time change to `scripts/decision-audit-presence-check.mjs` with a cutoff; its own change. Carried on CMT-1998.
- **Explicit pass/fail/not-applicable outcome for §6b** (round 6): changes the parent gate's artifact shape; its own change. Carried on CMT-1998.
- **Viewport/state labels per pair, checked** (round 6): the template asks for it; the second reader holds it.
- **App-repository review prompt** (rounds 1–2): the app repositories have no checklist or build skill and the iOS checkout is on another session's branch; carried on CMT-1998 to the app session.
- **The parent article's overstated "a 'no' blocks" sentence**: constitutional text; carried on CMT-1998 for Justin's wording.

## Experience fit

The person's stated outcome is screens they enjoy. The gate cannot make a screen good; it makes sure every screen change is looked at, in pictures, by its author and a second reader, against five named checks, before it lands. Contrasting cases: a pure data edit inside a dashboard file is not forced to produce pictures (one reasoned line); a one-token colour fix is not forced into a long essay (no length floor). Evidence limit: the second-pass record is self-attested.

## Decision-completeness

Frontloaded decisions: 4 (scope list, attestation shape, picture identity, second-pass record). Cheap-to-change tags: 0. Open questions: none.

## Conclusion

Converged at the round cap (6). The final round found no design change to the standard or its gate's shape; its fixable items were fixed and the rest are listed above with where they are carried. Ready for the operator's code-owner approval.
