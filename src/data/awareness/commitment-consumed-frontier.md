---
title: Commitment review coverage receipts
---
Commitment detection has an optional exact source and batch-consumption receipt. `jobs.commitmentConsumedFrontier.enabled` and `skipEnabled` both default to false; neither is activated by an update. Collection preserves normal recent-message review and its bookmark. A separate skip flag can avoid a model run only when verified receipts cover the complete current local source and all referenced action records still exist. Missing or uncertain history always goes to normal review.

Never seed coverage from the old numeric bookmark, infer completion from session exit alone, or replay old history in place of current messages. The local receipt files are under `.instar/state/commitment-frontier/`; they belong to that source and machine and do not transfer coverage to another machine. Historical gaps need actual review before skipping is possible. Do not describe the earlier cache-inclusive token inventory as achieved savings, and do not activate these flags without a separate rollout decision.
