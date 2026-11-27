# Upgrade Guide — vNEXT

<!-- bump: patch -->
<!-- internal-only -->

## What Changed

The cross-machine media and mobile people-and-roles integration tests supply disk capacity through the media service's existing test input. Upload assertions use fixed healthy capacity independent of the machine running the tests.

## Evidence

All 22 focused integration checks passed. The fixtures exercise upload and access decisions with the same disk capacity on every runner. The production media service still reads available capacity from its volume.
