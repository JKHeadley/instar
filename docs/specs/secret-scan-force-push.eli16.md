# Keep secret scanning reliable when main is rewritten

A normal push lets the scanner compare the previous main commit with the new one. A rewritten branch can leave the old commit outside the new history or unavailable to the runner. The existing scan can then stop before checking files and still show the advice meant for a detected credential. That leaves a maintainer with both an incomplete scan and an inaccurate reason for it.

When a main push arrives without a usable ancestor, the workflow instead scans the Git history reachable from the exact new head. It also checks the current files whose paths the scanner normally excludes. This can take longer, but it preserves the scan when the previous boundary is unreliable. An operational error still makes the check fail. The workflow advises reviewing and rotating a credential only when the scanner itself reports a finding. Disposable tests cover each output without using a real credential.
