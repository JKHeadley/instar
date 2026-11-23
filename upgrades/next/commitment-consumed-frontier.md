# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Added an opt-in, machine-local receipt for commitment-detection source and batch consumption. Collection and the separate skip gate default off. Exact source ranges and completed-run acknowledgements must agree; registered actions are independently rechecked, and uncertain or missing history retains normal review. The original recent-message body and bookmark behavior stay in place. No automatic historical backfill or live activation is included.

## What to Tell Your User

A disabled safety mechanism is available for future token-saving work. It records which messages were actually reviewed before allowing any unchanged-input review to be skipped. This update does not turn it on or promise savings.

## Summary of New Capabilities

Internal opt-in receipt collection and a separately disabled unchanged-input skip gate. No new operator action or public endpoint.

## Evidence

Focused unit, HTTP integration and restart lifecycle checks cover exact source evidence, invalid acknowledgements, action restoration, archived retries, concurrent admission, standby demotion and callback replay. Full test:all remains assigned to throughput; targeted checks do not establish a full-suite result or live savings. Design and overview: docs/specs/commitment-consumed-frontier.md and its .eli16.md companion.
