# Keep the merge-check test independent of this computer

The merge checker has two supported verification modes. A repository can require GitHub Actions results or a complete local verification record. This test file exercises the Actions mode using a temporary fake GitHub command. It must never merge a real pull request or depend on the operator’s running verification service.

The test previously inherited the hosting agent’s selected mode. On a computer configured for local verification, its pretend pull request was looked up in the live local verifier. That produced a refusal for a missing local record before the Actions checks under test could run. Six assertions consequently failed even though the production checker was correctly refusing an unverified merge.

The correction explicitly selects the existing Actions mode in this test subprocess. It changes no production defaults, repository configuration, verification records, or merge permissions. The tests still require a refusal when no checks have run and still require complete producer-bound evidence before their fake merge can succeed. The separate local-mode suite remains unchanged and passes alongside this one.

This is a small, reversible test correction. Reverting it restores the environment dependency without changing shipped behavior. Both modes were tested together: all 24 assertions passed. The wider history-import verification still has to complete through the normal queue before those updates can merge.
