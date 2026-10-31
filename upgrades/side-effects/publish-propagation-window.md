# Side-effects review: npm propagation window

## Trigger and change

The 1.3.1528 and 1.3.1529 publish jobs both printed `+ instar@<version>` and then failed their post-publish smoke check after 15 minutes of registry 404 responses. Version 1.3.1528 appeared shortly afterward. Increase the bounded wait to 45 minutes and report elapsed time once a minute. The clean install and CLI version checks remain unchanged.

## Risk review

1. **Over-block:** A package that never appears can occupy a release job for 30 minutes longer. This is bounded, and a failed clean install still fails immediately after propagation.
2. **Under-block:** A delay longer than 45 minutes can still cause a false failure. A bound is necessary so an unavailable registry cannot hold release jobs forever; the observed delay exceeded 15 minutes, so 45 minutes gives substantial room. Each `npm view` call now has a 15-second timeout so one hung lookup cannot defeat the overall deadline.
3. **Level of abstraction:** The post-publish smoke script owns the wait because it consumes the registry listing. The workflow's publish step and package version resolver are unchanged.
4. **Signal versus authority:** The 404 is a provisional signal while a successful `npm publish` may still be propagating. The smoke script retains authority to fail only at the bounded deadline or on an actual clean-install/version mismatch. This follows `docs/signal-vs-authority.md`.
5. **Interactions:** The longer job can delay later releases through the workflow's serialization. It does not retry `npm publish`, create another version, or change the release commit logic.
6. **External surfaces:** A progress line every minute makes a slow registry visible in the job log without exposing credentials or package contents. The existing clean install and `--version` assertion still catch a bad package.
7. **Multi-machine posture:** This is one GitHub Actions release job for the shared npm package. All machines consume the same verified version; no machine-local state or cross-machine message routing changes.
8. **Rollback:** Restoring the old deadline restores the false-failure risk. No persistent state or migration is changed.

## Verification

`node --check scripts/post-publish-smoke.mjs`, the focused smoke test, and the PR's CI and Mac verifier check the changed release script. The npm workflow itself is the final consumer on the next publish.

## Independent second pass

Concur with the review. The reviewer confirmed that the exact-version lookup, clean install, and CLI version assertion remain required. They identified an existing unbounded `npm view` invocation; this patch adds a 15-second timeout per lookup so the overall wait remains bounded.
