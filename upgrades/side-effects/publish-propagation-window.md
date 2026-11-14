# Side-effects review: npm propagation window

## Trigger and change

The 1.3.1528 and 1.3.1529 publish jobs both printed `+ instar@<version>` and then failed their post-publish smoke check after 15 minutes of registry 404 responses. Version 1.3.1528 appeared shortly afterward, and 1.3.1529 took about 26 minutes. Increase the bounded wait to 45 minutes and report elapsed time once a minute. A local clean install then hung in cloudflared's optional post-install download. Match the production updater by disabling lifecycle scripts during the install and bound that install to 15 minutes; retain the package-file and CLI-version assertions.

## Risk review

1. **Over-block:** A package that never appears can occupy a release job for 30 minutes longer. This is bounded, and a failed clean install still fails immediately after propagation.
2. **Under-block:** A delay longer than 45 minutes can still cause a false failure. A bound is necessary so an unavailable registry cannot hold release jobs forever; the observed delay exceeded 15 minutes, so 45 minutes gives substantial room. Each `npm view` call now has a 15-second timeout so one hung lookup cannot defeat the overall deadline.
3. **Level of abstraction:** The post-publish smoke script owns the wait because it consumes the registry listing. The workflow's publish step and package version resolver are unchanged.
4. **Signal versus authority:** The 404 is a provisional signal while a successful `npm publish` may still be propagating. The smoke script retains authority to fail at the bounded visibility deadline, on an install failure or timeout, on missing compiled CLI files, or on a CLI-version mismatch. This follows `docs/signal-vs-authority.md`.
5. **Interactions:** The longer job can delay later releases through the workflow's serialization. It does not retry `npm publish`, create another version, or change the release commit logic.
6. **External surfaces:** A progress line every minute makes a slow registry visible in the job log without exposing credentials or package contents. The clean install and `--version` assertion still catch a missing dist or wrong package. `--ignore-scripts` skips package and dependency lifecycle scripts, matching `UpdateChecker.applyUpdate()`: a local smoke attempt hung in cloudflared's optional binary download even though the package and CLI were present. This smoke does not prove lifecycle scripts or native bindings work; separate test tiers cover runtime behavior.
7. **Multi-machine posture:** This is one GitHub Actions release job for the shared npm package. All machines consume the same verified version; no machine-local state or cross-machine message routing changes.
8. **Rollback:** Restoring the old deadline and script-running install restores the false-failure and optional-download hang risks. No persistent state or migration is changed.

## Verification

`node --check scripts/post-publish-smoke.mjs`, the focused smoke test, and the PR's CI and Mac verifier check the changed release script. The npm workflow itself is the final consumer on the next publish.

## Independent second pass

The reviewer concurred with the longer wait and identified an existing unbounded `npm view` invocation; this patch adds a 15-second timeout per lookup. On the second pass, they agreed the script-disabled install fits this smoke's package and CLI purpose, but found that this artifact still described the install as unchanged and omitted the new timeout failure path. Both statements are corrected above.

Final reviewer verdict: **Concur with the revised review; no remaining concern.**
