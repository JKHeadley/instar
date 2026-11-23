# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Real search tests prepare their checksum-pinned model before test workers start and load it locally during the suite. A reusable machine-local cache survives clean dependency installs. Preparation errors fail visibly, and tests release owned models and server resources. Version-policy and session-readiness tests wait for actual completion instead of fixed short sleeps. Production behavior is unchanged.

## What to Tell Your User

The checks used to validate updates are less dependent on download timing and machine load. Search checks still use the real model and database extension.

## Evidence

The unchanged search tests passed with a completed cache. Deliberately delayed version and terminal fixtures reproduced their old timing failures. The saved full-run reports were incomplete, so no precise historical cause or complete-verification success is claimed from those comparisons. Raw-report retention is tracked separately as ACT-517.
