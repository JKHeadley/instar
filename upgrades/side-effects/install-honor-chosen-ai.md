# Side effects: the installer honors the chosen AI

## Change
`InstallFlowContext.chosenDoor` (from the answers file's `door`) is returned first by `impliedInstallDoor`, ahead of `runningInDoor` and a single detected door. `answersFileProblem` refuses a `door` that is not an `INSTALL_DOOR_LABELS` key.

## Who is affected
People creating an agent from the Mac app (which always sends `door`) and anyone running `instar install --answers` with a `door`. Before, a single detected door or the harness the installer ran in overrode the answer; now the answer wins, so a ChatGPT pick installs Codex and runs its sign-in. An interactive install without an answers file behaves as before.

## Rollback
Revert; the guess wins again.
