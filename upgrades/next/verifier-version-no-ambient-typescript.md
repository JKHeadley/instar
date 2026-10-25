<!-- bump: patch -->
## What Changed

- **The local verifier's version fingerprint no longer depends on a neighbouring folder.** `computeVerifierVersion()` (`src/localVerify/verifierVersion.ts`) hashed `typescript:<version>`, read by Node's module lookup from the installed package. That lookup walks up through parent folders, and from `.instar/shadow-install/node_modules/instar` it reaches the agent home's own `node_modules`, which an unrelated `npm ci` empties and refills. The fingerprint therefore flipped between two values across server restarts (`vh2:25b6e0cc…` with typescript 5.9.3 found, `vh2:da61a7a1…` with it absent), and every flip voided every pending local-verify record (`verifier-mismatch`), so PRs re-tested after each restart. The input is removed: nothing outside the package is read any more. The skip ratchet already loads its parser from the PR's own worktree (PR #2326), so the TypeScript version was never a property of the verifier. The salt and prefix move to `local-verify-verifier-v3` / `vh3:`, so records written under `vh2` re-verify exactly once and can never collide with a `vh3` value.

## What to Tell Your User

Nothing to do. On a maintainer agent, pull requests waiting on the local test run no longer lose their green result every time the server restarts; after this update each pending result is re-checked once, and from then on only a real change to the verifier, its policy or Node starts the checks over.

## Summary of New Capabilities

None. A fix to an existing fingerprint; no new routes, config or state.

## Evidence

- `tests/unit/localVerify/LocalVerifyService.test.ts`: new case "an ambient typescript install above the package does not change it (the 2026-10-24 flip)" plants `node_modules/typescript/package.json` two levels above a fake install root and inside it, with two versions, and asserts the computed version is unchanged — fails against the previous source at the first planted assertion, passes with the fix. Existing cases updated to `vh3:`; the "typescript changes it" assertion removed.
- Reproduction before the change: identical files, policy and node with `typescriptVersion` null vs `'5.9.3'` produced exactly the two hashes seen alternating in the index.
- `tests/unit/localVerify/{LocalVerifyService,runVerifyMain,mergeLineWiring}.test.ts` 78/78; `npx tsc --noEmit` clean; `npm run lint` clean.
