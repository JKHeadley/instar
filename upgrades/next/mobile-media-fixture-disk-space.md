# Upgrade Guide — vNEXT

<!-- bump: patch -->
<!-- internal-only -->

## What Changed

Three mobile media integration fixtures provide fixed healthy capacity to the existing upload guard. The native media fixture checks upload setup before sending chunks and has a dedicated case one byte below the real disk floor.

## Evidence

The M5 main run recorded upload refusals below the real volume floor. The dedicated test checks the 507 disk-floor response and the 403 returned if a chunk request uses the missing upload ID.
