# JobRunHistory cap enforcement is an outcome, not a defect — ELI16

JobRunHistory keeps one compact record for every scheduled job run. Each record
has a deliberate 2 KB limit so a job that prints a huge error cannot make the
history ledger grow without bound. When a record is too large, Instar removes
bulky optional fields first and shortens a large error in the middle while
keeping its beginning and end. That behavior is the designed storage path, not
an emergency fallback.

The previous implementation treated every use of that designed path as a
degradation. It said the “full row” path had broken and sent a bug to the
feedback system. A one-hour in-memory dedup reduced short bursts, but it reset
after a restart and expired every hour. The local durable backlog consequently
held 299 forwarded reports for successful 2 KB enforcement. The rows themselves
were healthy: each fit the cap, carried `truncated: true`, and preserved the
useful ends of the error.

This change fixes the class, not just that one noisy job. The standards registry
now says that successful, expected capacity enforcement is an observable
outcome rather than a degradation. Bounded writers register a versioned contract
and return one shared typed result: within-budget, condensed, or
invariant-failure. A blocking lint checks the registry, exact source marker,
typed outcome, and revision-bound failure annotation. It does not guess meaning
from English words. If required fields still cannot fit after every transform,
JobRunHistory rechecks the final bytes, refuses the oversized write, and emits a
real, explicitly-bound degradation.

JobRunHistory no longer emits a defect when it successfully fits a row. It still
writes `truncated: true` on every affected row, and job statistics now expose
`budgetCondensedRuns`, so the behavior remains durable and measurable across
restarts. Unit tests cover exact preservation and the lint. Integration tests
reopen the ledger through multiple process-shaped instances. The end-to-end
test crosses both restarts and the old one-hour boundary, proving three capped
runs remain queryable while zero degradation events and zero feedback
submissions occur. An adversarial test makes the essential identity fields alone
larger than 2 KB and proves the final-byte recheck refuses the row and emits one
bounded diagnostic instead of writing invalid data.

Rollback is a normal code revert. There is no schema migration: the new stats
field is computed from the existing optional row flag, and old readers already
ignore additive response fields. Genuine write failures still use the existing
error path; only the category error around successful budget enforcement is
removed.
