# Release-note review for latest Codex model defaults

The release fragment describes the launch behavior in commit 1856975d3. The notes also become input to release publication and agent upgrade messaging, so their wording needs to match the scope of the committed change.

## Claims checked

- The family resolver reads the packaged reviewed catalog and selects the latest eligible release. The note says “latest reviewed” because a model announcement or a local probe does not change that catalog. A missing catalog falls back to the built-in balanced model.
- An exact configured pin remains in force as the model request. The resolver logs stale-pin warnings, and the existing older-CLI compatibility and quota checks continue to govern which model launches. The note makes those checks explicit.
- The authenticated config route publishes the new runtime value only after the save succeeds. Its success response identifies the scope as the receiving machine. The note carries that same scope.
- The launch paths read the default when starting a session. The change includes no actuator for moving an existing session. The note tells readers that open conversations keep their model.

## Publication effects and evidence

The fragment introduces no executable behavior, permissions, data writes, or new notification path. It supplies the text that the existing release workflow assembles for publication. The launch behavior, rollout checks and downgrade procedure are documented in the [launch side-effects review](latest-codex-model-defaults.md). The [convergence report](../../docs/specs/reports/latest-codex-model-defaults-convergence.md) records the focused configuration and launch evidence. Complete exact-head verification remains with the release verifier.
