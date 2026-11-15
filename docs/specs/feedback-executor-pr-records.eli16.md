# Feedback executor PRs carry the records every instar PR carries (ELI16)

The feedback executor turns problems people report into fix pull requests on its own. A sandboxed session writes the fix and a test, the executor checks the test fails before the fix and passes after it, and then it opens the PR. Two independent reviewers then look at the change.

Every instar PR also has to carry two small files before GitHub's checks let it merge. One is a decision record that says which source files the change covers and how it was checked. A person's PR gets it automatically from a local check that runs when they commit. The other is a short release note, so the change actually ships in the next release.

The executor's commits never go through that local check, so its PRs had neither file. Two of them (#3159 and #3168) passed both reviewers and still could not merge.

Now the executor writes both files itself, from its own trusted code, just before it commits. The decision record says plainly that the feedback executor wrote it, that the usual local check did not run, and which checks the executor did run. The release note is built from the problem summary. Any text that came from outside the executor is flattened to one plain line first, so it cannot add headings, comments or code to the note. A design-draft PR gets neither file, because its review requires it to be exactly one file.
