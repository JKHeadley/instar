# JobRunHistory row-cap dedup — ELI16

When a scheduled job fails, Instar writes a compact history row so the dashboard
and later debugging sessions can answer: what ran, when did it fail, and why?
Those rows have a hard 2 KB cap so one noisy job cannot grow the ledger without
bound. The cap is correct, but the old fallback had two bad side effects.

First, if the failure message itself made the row too large, the cap logic could
drop the `error` field entirely. That kept the file small but threw away the
one field a debugger most needs. A row that only says "this job failed" without
the failure text forces the next agent to rediscover the same problem from logs,
if those logs still exist.

Second, every capped row reported a fresh degradation. During a retry loop, one
job can fail again and again with the same oversized error. Today that means
the health page fills with many copies of the same JobRunHistory degradation,
drowning the single underlying issue that actually needs attention.

This change keeps the row cap but makes it diagnostic. Bulky non-diagnostic
fields still go first, such as output summaries or reflection data. If the row
is still too large and the error is the large field, JobRunHistory now keeps the
beginning and end of the error with an omission marker in the middle. The stored
row still fits under 2 KB, still has its capped-row flag, and still tells a
human why the job failed.

The degradation report is now grouped by job slug and cap condition for a
rolling one-hour window. The first capped row for a slug emits the normal
DegradationReporter event. Repeated capped rows for the same slug inside that
window update the event count instead of appending another health event. A
different slug, or the same slug after the window expires, still emits a new
event because it may be a separate problem.

This is a Tier 1 change because it is small, local, and reversible. It does not
add a new scheduler authority, change whether jobs run, change retry behavior,
or touch external APIs. It only changes how oversized history rows are stored
and how the existing degradation signal is shaped. The rollback is a normal
code revert; existing rows remain readable JSONL either way.

The guard is unit coverage on both edges: small errors remain exact, oversized
errors keep both head and tail, same-slug repeats inside the window produce one
health event with count three, a different slug emits separately, and an expired
window emits separately.
