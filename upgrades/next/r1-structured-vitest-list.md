<!-- bump: patch -->
<!-- internal-only -->

## What Changed

Hardened the contributor-side pre-push smoke tier so only a valid structured empty Vitest list is
reported as having no affected tests. Empty, malformed, old rendered, or schema-changed list data
now fails loudly instead of becoming a reassuring local pass, while valid affected sets still run
and valid oversized sets retain the existing CI-backed breadth skip.

A list timeout remains non-blocking because protected CI is the exhaustive merge authority and
local disk contention must not veto a push. The timeout outcome now says `SKIPPED`, records that
zero tests ran, and explicitly states that the local tier did not pass.

## Evidence

- Focused parser and decision controls: 20 tests passed, including empty, malformed, old rendered,
  schema mismatch, genuine zero, genuine affected, breadth skip, and timeout cases.
- Committed pre-push smoke entrypoint: selected 3 files / 73 cases and passed all 73 tests.
- Full repository lint and the instar-dev Tier-1 side-effects gate passed.
