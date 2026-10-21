<!-- internal-only -->

## What Changed

- **Step the version past 1.3.1384, which the registry has staged and will not accept.** The publish for the `/health` job-failure fix (PR #2275, merge `477d50324`) failed twice with `npm error code E409 — 409 Conflict … Cannot publish over previously staged version "1.3.1384"`. The tarball built and its provenance was written to the sigstore transparency log; the registry refused the final write because 1.3.1384 is already staged there from an earlier attempt. `npm view instar@1.3.1384` returns 404, so it is claimed but not published — unusable and not re-publishable. Setting `package.json` to 1.3.1385 makes the next publish target a version with no staging claim, which is the documented behaviour ("otherwise it publishes `package.json`'s version"), not a workaround.
- **Nothing is unpublished and nothing is deprecated.** 1.3.1384 is simply skipped. No release ever carried that number, so no install, lockfile or pin can reference it.

## Evidence

Observed on the registry and in the workflow logs, twice:

- **Attempt 1** (run 39649230045, 18:31:52Z): tarball built as `instar-1.3.1384.tgz`, provenance published to the transparency log (`logIndex=3361060380`), then `npm error code E409 … Cannot publish over previously staged version "1.3.1384"`, exit 1.
- **Attempt 2** (same run re-run, 18:37:43Z): identical failure, same error, so the staging claim did not clear on its own in the six minutes between them. Re-running was tried first because a staged version often clears by itself; it did not.
- **Registry state:** `npm view instar@1.3.1384` → `E404 No match found for version 1.3.1384`; `npm view instar versions` ends `…1.3.1381, 1.3.1382, 1.3.1383`. So 1.3.1384 is claimed and unpublishable, and `latest` is still 1.3.1383 — the `/health` fix is merged but NOT deployed.
- **`package.json` on `main` was still 1.3.1383**, because the workflow's version-bump commit only lands after a successful publish. So nothing had to be un-done; this change moves it straight to 1.3.1385.


## Correction — 2026-10-21 12:01 PDT: 1.3.1384 published itself

The staging claim cleared on its own about twenty minutes after the last failed attempt, and the
registry **finalised the earlier staged upload**: `instar@1.3.1384` is now published. So the
claim above that 1.3.1384 is "unusable and not re-publishable" is no longer true, and the reason
for this change has moved — but the change itself is still required, for a different reason.

**Why it is still needed.** `package.json` on `main` is 1.3.1383 while the registry now holds
1.3.1384. The publish workflow bumps only when `package.json` *equals* the published version;
otherwise it publishes what `package.json` says. 1.3.1383 ≠ 1.3.1384, so the next run would try
to publish 1.3.1383 — a version that already exists — and fail again. Setting 1.3.1385 puts
`package.json` ahead of the registry, which is the state the workflow expects.

**What the published 1.3.1384 actually contains**, read from the tarball rather than inferred
from the number: `dist/server/jobFailureCurrency.js` is present and `staleJobFailures` appears
twice in `dist/server/routes.js`, so it carries the `/health` job-failure fix (#2275). It does
**not** carry the `checkInAt` writer (#2277): `checkInAt: input.checkInAt` appears 0 times in
`dist/monitoring/CommitmentTracker.js`. That is consistent with which upload the registry
finalised — the one built from `477d50324`, before #2277 merged. So #2277 still needs a release,
and this change is what lets the next one happen.
