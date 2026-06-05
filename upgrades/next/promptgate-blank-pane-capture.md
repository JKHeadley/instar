<!-- bump: patch -->

# PromptGate detects Gemini modals above blank pane fill

## What to Tell Your User

Nothing user-visible. Gemini sessions should get stuck less often at known safe/default CLI prompts.

## Summary of New Capabilities

- PromptGate now trims trailing blank terminal-fill rows before applying its detection window, so Gemini modals still match when a 50-row pane leaves the prompt text near the top with blank rows below it.
- The existing safe-default and safe-reject handlers are unchanged; this only makes the detector feed them the meaningful pane tail.
- Regression tests cover both the default blank-filled pane shape and the existing small-pane shape for the `npx instar` install modal and execution-approval safe-reject modal.

## What Changed

PromptGate normalizes captured pane output by removing trailing blank rows before slicing to the configured detection window. This preserves interior blank lines inside modals while preventing terminal height padding from hiding the actual prompt.

## Evidence

Reproduction: a default-height pane capture can contain the Gemini or `npx instar` modal text followed by enough blank terminal-fill rows that the old tail-window slice only inspected blank rows.

Observed before: the safe-default and safe-reject matchers were not reached for that blank-filled capture shape, even though the modal text was visible in the pane.

Observed after: focused regression tests cover both blank-filled default-pane captures and the existing small-pane captures. The default-pane tests now detect the `npx instar` install prompt with `Enter` and the Gemini execution-approval modal with the safe-reject key `2`, while the existing small-pane tests still pass.
