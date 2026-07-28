# Side-effects review — Gemini interactive modal autofill

## What changed

`PromptGate` now has a structural matcher for known Gemini CLI framework modals
that block autonomous sessions:

- loop detection: sends the explicit "keep loop detection enabled" option when
  visible, otherwise sends `Enter` for the live default path Justin observed;
- workspace trust: sends the explicit trust/yes/allow option when visible,
  otherwise sends `Enter`;
- install confirmation: sends `Enter` to accept Gemini CLI's highlighted/default
  response.

These matches run before the generic question, selection, and LLM prompt
detection paths. The existing server wiring already consumes `autoDismissKey` by
sending that key to the tmux session and skipping the relay/classifier pipeline.

## Why

The failure mode is a real autonomy wedge. Instar detected the Gemini modal and
forwarded it to Telegram, but the Gemini CLI process stayed blocked waiting for
keypress input in the pane. YOLO mode does not suppress these Gemini CLI modals.

Loop detection is a safety rail, so the auto-answer keeps it enabled. Workspace
trust is part of normal agent operation in the bound project. Install-confirm is
handled as Gemini CLI's own highlighted/default decision, not as a broad "yes to
any install" rule.

## Risk

Blast radius is limited to prompt detection. There is no schema, database,
configuration, route, migration, Telegram adapter, or session-spawn change.

The main risk is false positive auto-answering. The patterns are constrained to
Gemini-specific modal text or Gemini/MCP/tool install context, and the generic
non-Gemini install fixture proves a plain install question does not receive an
auto-answer. Existing broad prompt patterns still handle unrelated questions and
confirmations the same way they did before.

The second risk is semantic drift if Gemini CLI changes its wording. The loop
modal uses the live phrase Justin observed ("A potential loop was detected") and
falls back to `Enter` when no numbered row is visible. Workspace and install
patterns also accept option rows where Gemini renders numeric choices.

## Framework generality

Claude Code and Codex CLI behavior is unchanged. Their existing Prompt Gate
patterns still run after this new Gemini-specific matcher, and the new matcher
requires Gemini-specific loop/trust/install context before it emits an
`autoDismissKey`.

This fix is explicitly for `gemini-cli`, and it reaches Gemini sessions through
the same provider-neutral `PromptGate` and `SessionManager.sendKey` abstraction
already used by Claude optional-survey dismissal and manual Telegram prompt
responses.

## Tests

- Unit: `tests/unit/PromptGate.test.ts` covers Gemini loop detection with
  numbered options, the live no-option loop modal shape, workspace trust,
  install confirmation, and a generic non-Gemini install question that must not
  auto-answer.
- Unit: existing `InputClassifier` and `AutoApprover` tests stay green, proving
  the normal classification and approval layers were not widened.
- Focused run: `npm test -- --run tests/unit/PromptGate.test.ts tests/unit/InputClassifier.test.ts tests/unit/AutoApprover.test.ts`
  passed with 95 tests.
- Integration: `npm test -- --run tests/integration/stall-recovery-e2e.test.ts`
  passed with 12 tests.
- E2E: `npm test -- --run tests/e2e/gemini-loop-driver-lifecycle.test.ts tests/e2e/gemini-capacity-policy-lifecycle.test.ts`
  passed with 4 tests.
- Type/lint: `npm run lint` passed.

An attempted broader session-management e2e smoke was not used as acceptance
evidence: `tests/e2e/session-management-e2e.test.ts` hit the existing respawn
fixture timing/session-loss path (`waitFor timed out after 15000ms`) while 30/31
tests passed under a longer timeout. That file does not exercise this PromptGate
matcher and the failure was in tmux respawn injection, not modal detection.

## Rollback

Revert the PromptGate matcher and tests. No persisted state or migration is
introduced. Rollback restores the previous behavior where Gemini CLI modals are
detected/relayed but may remain blocked until a human presses the key in the
terminal.
