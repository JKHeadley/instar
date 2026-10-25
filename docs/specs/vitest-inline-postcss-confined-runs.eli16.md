# Test runs inside the feedback executor's sandbox no longer fail before they start (plain-English overview)

Governing spec: `docs/specs/feedback-triage-and-execution.md` §4 (converged and approved). The executor checks its sandbox before every fix attempt. One of those checks runs a known-good unit test inside the sandbox, and it must pass.

## What was wrong

When the test tool (Vitest, built on Vite) starts, it looks for a style-processing (PostCSS) config. It searches the project folder, then every parent folder. The sandbox deliberately blocks reads of the agent's home folder around the fix workspace. On this agent the home folder is itself an Instar checkout with a `package.json`. Vite tried to read that file, got "operation not permitted", and stopped with an error instead of moving on.

So the known-good test failed every time inside the sandbox. The executor would have stopped every fix attempt at this check ("the sandbox cannot be enforced") on the first try after the operator approved it.

## What changes

Each Vitest config now says outright that there is no PostCSS config (`css: { postcss: {} }`), so Vite never searches parent folders. Instar has no CSS in its tests, so nothing else changes.

Measured on the Mac Studio, with the executor's own sandbox code: the check failed before the change (exit 1, EPERM on the agent home's `package.json`) and passed after it (47 of 47 tests).

## What does not change

The sandbox policy is unchanged; nothing is unblocked. Test behaviour outside the sandbox is unchanged.

## What you need to decide

Nothing.
