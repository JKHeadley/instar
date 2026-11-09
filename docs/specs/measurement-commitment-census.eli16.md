# Count commitments without mistaking records for results

The new measurement view lists features, decisions, scheduled jobs, work items
and model capabilities. Its work-item list currently comes from the initiative
tracker. Instar also keeps commitments in an existing promise tracker. Some of
those commitments describe important corrective work, yet they do not appear in
the measurement census. This change includes that existing source instead of
creating another list for the same responsibility.

A commitment will remain visible even when it has no measurement attached. It
will keep its status and source identifier without copying conversation text
into the shared census. A completed or withdrawn record is not
silently removed because a simple filter guesses it no longer matters. The
count is a count of tracking records, and the screen will explain that several
records can describe the same work. It is not a count of unique successful
outcomes or a decision that every routine promise needs an improvement contract.

Commitment records will not borrow an initiative's measurements because their
names or numbers happen to match. This change does not add a way to write a
baseline, decide whether a feature should advance, or enable a control. Missing
or unreadable source information stays a gap, and ordinary services keep working.
Large lists keep the existing response limits and show how many rows were omitted.
Older machines can still contribute the records they know about, while the view
flags the commitment source they cannot yet report instead of treating it as zero.
Tests use isolated records; no production history is manufactured. The stronger
baseline and promotion proposal remains paused for its separate review decision.
