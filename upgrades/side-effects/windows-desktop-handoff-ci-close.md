# Windows companion CI close race: side effects

## Over-block

The Windows CI test requires the prepared companion process to exit within five seconds with code zero. A slow runner can fail a valid implementation; the five-second bound matches the production installer's stopped-state window.

## Under-block

An unrelated clean exit immediately after the signed commit request could look like success. The test first proves signed prepare returned a token, then sends that token in the commit request to the same process handle; it does not claim to prove screen capture or live WSL interop.

## Level of abstraction

The test uses an actual Windows companion and the shipped PowerShell requester. Production Task Scheduler remains the authority for replacement; CI only checks the process behavior.

## Signal versus authority

Per `docs/signal-vs-authority.md`, loss of the final TCP reply is only a signal. A clean exit of the exact prepared process is required before CI accepts it. The production installer still waits for Task Scheduler's stopped state.

## Interactions

PowerShell treats native stderr as a terminating error on the runner. The test catches that error around commit only, then checks process exit and code. It clears the native exit status only after all checks pass, since the runner uses that status when finishing the step. Prepare still requires a valid token. The release-note headings now match the publishing invariant.

## External surfaces

This changes CI and release note text. No user API, desktop control path, or companion secret handling changes.

## Multi-machine posture

CI runs on a disposable Windows runner. The production Windows companion remains machine-local to Mama PC; no state is replicated. The release note describes the same fleet package behavior.

## Rollback cost

Revert the CI assertion if it hides a genuine failure; no agent state migration is needed. A Windows live screen/input/Stop check remains required before marking Mama PC ready.

## Second-pass review

**Reviewer:** Astra

Astra raised one P2: a caught `powershell.exe` failure leaves `$LASTEXITCODE`
nonzero and can still fail the GitHub step. The test now clears it only after
the exact prepared process exits successfully and no explicit refusal is
returned. Astra found no other P1/P2 in the narrow acceptance check; the
live WSL and desktop checks remain separate release gates.
