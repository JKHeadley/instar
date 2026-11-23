# Upgrade Guide — vNEXT

<!-- bump: patch -->
<!-- internal-only -->

## What Changed

Classify thirteen account/quota/config dependencies newly reached through erased type imports as explicitly outside the Stage-B inbound-delivery canary. Every exclusion has a per-file reason. Certified sources, hashes, fingerprint and signed evidence remain unchanged; supported fingerprint writer/checker and publication gate stay intact.

## Evidence

The original checker refused thirteen unclassified members. Supported --write and --check pass after classification. All seven certified source hashes and the artifact binding are unchanged;21 existing Stage-B evidence/publication checks pass. Independent review concurs. No new canary, full-suite pass or live-install result is claimed.
