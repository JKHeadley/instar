# Let a Finished Check Reach Its Exact Merge Request

The test line can finish every required check successfully and still fail to hand the change to the merge system. The merge system regularly scans the oldest one hundred pull requests written by its signed-in account. When the queue grows past that size, a newer request is missing from that scan. The current handoff treats missing from the scan as missing altogether, even when it already knows the exact request and commit that passed. That happened to two finished fixes, which needed manual merges.

This repair reads the exact request directly when the test line hands it over. It uses the same signed-in GitHub account and the same ownership and readiness checks as ordinary scans. The old scan remains bounded for normal discovery; it is simply no longer the source of truth about whether a specifically named request exists.

Reading the request does not authorize a merge. The author, repository, current commit, draft state, holds, required reviews, complete test result and final safe-merge checks still apply. If the direct read fails or finds a different commit, the system waits rather than choosing another request. Tests will cover both the successful handoff and those refusal boundaries. This candidate does not change the running server until it is reviewed, published, completely verified and released through the normal process.

GitHub sometimes needs a moment to check whether a change can merge. If it answers that it is still unsure, the merger looks again twice for the same change. If GitHub stays unsure or the change moves, the merger waits for its next regular scan. All required checks still apply.
