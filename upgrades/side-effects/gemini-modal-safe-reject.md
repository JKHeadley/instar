# Side-effects Review: Gemini Modal Safe Rejects

## Change

This Tier-1 change extends the existing Prompt Gate deterministic modal path.
It does not introduce a new policy engine or a new execution surface.

Touched surfaces:

- `src/monitoring/PromptGate.ts`: adds narrow Gemini CLI matchers for the
  observed `npx instar@... Ok to proceed? (y)` install prompt and for Gemini
  execution-approval modals with an explicit reject option.
- `src/commands/server.ts`: logs execution auto-rejects before sending the
  reject key, and reports them through `DegradationReporter`.
- `tests/unit/PromptGate.test.ts`: covers the install-confirm match and
  near-miss, plus the execution-approval reject boundary.

## Overreach / Underreach

The install matcher is deliberately under-broad. It accepts only the captured
package-runner shape for `instar@x.y.z`, because the live miss was `instar`
itself. It does not auto-answer unrelated package installs such as `left-pad`.

The execution matcher is also narrow. It only auto-rejects when the terminal
shows the known `Allow execution of:` modal and a reject option. If the UI shape
changes or the reject option is missing, normal relay/classification remains the
fallback. There is no auto-approve path.

## Safety Boundary

Install confirmations and execution approvals are not the same class.

An `npx instar@... Ok to proceed? (y)` prompt confirms the package runner's
default for an Instar command the agent already invoked. Accepting it unblocks
the intended tool path.

An execution-approval prompt asks whether arbitrary command text may run. The
command can be malformed, unrelated to the task, or unsafe. The live Gemini
cycle proved this with a shell-comment command. Auto-approving that class would
turn model output into code execution. This change therefore only supports
safe-reject for execution approvals.

## Observability

Auto-rejects are intentionally visible. Before sending the reject key, the
server writes a `[PromptGate] Auto-rejected execution approval...` warning with
the rejected command text and emits a `PromptGate.executionApprovalAutoReject`
DegradationReporter event.

This is not just debugging convenience. It is part of the safety design: when a
mentee appears to stall or pivot, the mentor can see that the framework rejected
an execution prompt and why.

## Signal vs Authority

The new matchers are deterministic authority only for two tightly-scoped UI
shapes:

- safe-default for `instar@...` package-runner install confirmation;
- safe-reject for Gemini execution approval with an explicit reject option.

Everything else remains signal for the existing Prompt Gate relay/classifier
flow. The change does not add an LLM prompt filter, does not broaden yes/no
auto-approval, and does not treat generic `Ok to proceed?` text as authority.

## Adjacent Systems

- Telegram/Slack prompt relay: unchanged for prompts that do not match the new
  exact shapes.
- AutoApprover: unchanged. Execution safe-reject uses the pre-classifier
  auto-dismiss path, not the auto-approve path.
- DegradationReporter: receives one observable event per execution auto-reject.
  The event is intentional and mentor-facing; it should not be treated as a
  failure of Prompt Gate.

## Rollback

Revert the three code/test changes and remove these upgrade artifacts. Runtime
state does not need migration. Existing agents would return to relaying or
waiting on these Gemini prompts.

## Verification

- `npm test -- --run tests/unit/PromptGate.test.ts` passed, 57 tests.
- `npx tsc --noEmit` passed.

