# Guardian activity counts without a model

The guardian review uses an existing report to see which monitoring jobs ran, failed, or were skipped. This draft adds a separate scheduled job that collects and formats those counts directly. It reads the same local report as the guardian review, calculates totals from the individual job records, and saves a plain-text copy. It also shows each job's consecutive failures and quota skips. Missing per-job run counts are visible in the output.

The new schedule starts disabled, and closing the scheduler's script gate skips the job without launching a model. Running the script only reads monitoring data and saves a report. The current guardian review still owns interpretation, including whether jobs contradict each other or leave a monitoring gap. The two can be compared on the same data before changing how the current review runs. No live schedule changes are part of this draft.
