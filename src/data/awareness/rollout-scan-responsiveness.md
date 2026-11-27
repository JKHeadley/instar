---
title: Release checks keep the agent available
---
Feature and release discovery runs asynchronously, so reading canonical specifications or falling back to local files should not freeze health responses or lease renewals. The existing featureRollout.canonicalRefScan switch still selects canonical discovery; no lease grace or restart policy changes are implied. A canonical read failure is diagnosed before a complete local fallback is applied. When investigating a stall, correlate timestamped logs/server.log with featureRolloutScan operations in the safe Git audit. Do not claim a configured switch or a passing local test proves an installed machine has completed a responsive scan.
