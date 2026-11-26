# Destructive-operation lint: report incomplete scans

> A clean lint result should mean the source paths the scanner enumerated were actually inspected.

## The problem

The source safety lint looks for direct destructive file and Git operations. A file that could not be read or parsed was previously skipped, while the command could still exit successfully. That made an incomplete scan look like a clean one. Issue #2190 asks the checker to say when it could not inspect its target, and to refuse to certify that run as clean.

## What already exists

The checker already reports definite destructive-operation violations and exits nonzero. It already handles the case where no TypeScript file parses at all. The development and release gates call this checker; they need a reliable distinction between “inspected and clean” and “could not inspect.”

## What changes

The checker records each enumerated target file or directory it could not inspect, prints its path and the cause, and exits with code 2 if there was no definite violation. A definite violation still exits with code 1 and the incomplete paths are also reported. Brief read errors get two short retries, so a file being written at the same moment need not cause a false alarm. Missing optional target directories still contain no files and do not count as a scan failure.

## Safeguards and decision

This is a deterministic completeness rule, not a judgment about the developer's intent. It does not broaden the destructive-operation patterns. The tests cover a genuinely unreadable file, forced read and parse failures, an unlistable directory, a transient read that succeeds, a definite violation alongside an unreadable file, and a clean tree. A revert restores the previous behavior without migrating state.

The decision for this narrow, reversible fix is whether the scanner should refuse to call an incomplete scan of its enumerated targets clean. The normal lint chain treats that refusal as a failure. The pre-push gate currently treats code 2 as a warning, and explicit missing paths can be dropped before enumeration; both limits are recorded in the side-effects review. Developers who receive a code 2 must repair the named read, parse, or directory listing and rerun the lint.
