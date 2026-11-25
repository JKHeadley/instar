# Infrastructure activity report side effects

The disabled activity schedule gains one authenticated local read for infrastructure over the 48 hours used by the Infrastructure Overseer. The shared calculator writes count summaries to the existing reports directory. It does not modify schedules, review findings, or remote services.

The calculator produces evidence under [Signal vs Authority](../../docs/signal-vs-authority.md). The current Infrastructure Overseer continues interpreting conflicts, divergence, and scheduling recommendations. There is no new block or allow surface. An explicitly empty category response saves zero totals at the time of the local check. Invalid or unavailable input still fails the scheduled report, and output already saved for other categories remains available.

The saved November 25 infrastructure response contained eight jobs, 967 runs, 34 failures, and three jobs with skips. The fixture stores only the count fields and job slugs. The saved report and scheduler test compare those totals and check the existing no-model path. The report is supplementary, so the comparison measures parity of counts and does not establish net savings under the live schedule.

Disable the shared script schedule or revert this patch to restore the preceding three-category report. Existing saved reports need no migration. A separate review is not required for this local, disabled evidence projection.
