# Decision records now explain what their counters measured

The development commit gate already records two compact numbers for each
reviewed source change: how many source files were in scope and how many lines
changed. Those numbers are useful, but the record did not retain the concrete
file list or say whether the line count represented additions, deletions, or a
different basis. A later reader could see “three files, eighteen lines” without
being able to tell which files produced that result.

The gate now stores an additional `scope` object beside the existing counters.
It names the counting basis, lists the exact staged source files included, and
records added and deleted lines separately. The old `files` and `loc` fields
remain unchanged, so existing readers continue to work.

The new values come from the same staged-diff calculation the gate already
uses for tier signaling. There is no second calculation that can disagree with
the original counters. If that existing calculation cannot run, the gate keeps
its current fail-open behavior and records the same zero counts explicitly.

This changes evidence only. It does not change which files require review,
which tier is suggested, which trace is selected, or whether a commit passes.
A focused integration test runs the real hook in a temporary repository and
asserts the emitted record’s basis, file list, additions, and deletions.
