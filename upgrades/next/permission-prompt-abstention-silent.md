# Permission-prompt resolver: an unanswered menu is announced even under blank padding and a status line

## What Changed

- `src/core/paneText.ts`: `meaningfulNonBlankTail(text, n)` (last n non-blank rows).
- `src/core/SessionManager.ts`: the resolver pre-gate and its evaluate capture read non-blank rows (`captureMeaningfulNonBlankTailMaybeAsync`, 80-row physical window); the pre-gate regex is the exported `RESOLVER_PREGATE_RE`.
- `src/monitoring/PermissionPromptAutoResolver.ts`: Layer 3 (`detectPersistingMenu`) ignores trailing transient lines (`stripTransientTrailer`: retry-wait line, permission-mode status bar) and uses a 12-line bottom window; it audits `menu-observed` on first sight and `menu-unanswered-terminal` on the raise. Layer 2 is unchanged.

## What to Tell Your User

If one of my sessions gets stuck on a menu I will not answer for you (a model-switch question, a confirmation for a risky command), you now get one attention notice after it has sat there for about a minute, even when the menu is not at the very bottom of the screen. Nothing is answered for you: I still only ever auto-approve the one harmless prompt I was built for.

## Summary of New Capabilities

- A parked menu under blank padding or a status line is noticed and announced once.
- `logs/permission-prompt-resolver.jsonl` records every menu the resolver saw and declined to answer, so a silent stall is no longer indistinguishable from a quiet session.

## Evidence

Live 2026-10-19 reproduction on the Mac Studio (fixture `tests/fixtures/claude-code-model-switch-menu-pane.txt`): against the deployed dist the pre-gate was false and both detectors returned null; with this change Layer 3 matches, Layer 2 still declines, one defect after `LAYER3_PERSIST_TICKS`, two audit rows, no key sent. `tests/unit/permission-prompt-resolver-abstention-silent.test.ts` (10 tests) plus the existing resolver and wiring suites (57) pass.
