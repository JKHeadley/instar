# Release retry with a concurrent note — plain English

An Instar release has two final steps after npm accepts the package: record the version in Git and tag the code that produced it. A pull request can merge during those steps. If that pull request adds a note for the next release, Git may mistake the old note directory for a renamed directory when the release consumes its notes. The final push then fails even though users can already install the new npm package. This happened for versions 1.3.1534 and 1.3.1535.

The release job now marks the exact release cut that npm received with the version tag before retrying the main branch push. If another pull request moves main, it rebases the release commit with Git's directory rename inference disabled. That keeps the new pull request's note in the next-release directory. It does not suppress a real conflict in a shared file, and it does not force-push main.

The local recovery tool uses the same rebase setting when it has deliberately kept a tag on a published release cut. A real Git test reproduces the note race and checks three outcomes: the new note survives, the released note is consumed, and the tag remains on the published cut. The workflow also has a source-level check for the order of tagging and rebasing.

A version tag may no longer be an ancestor of main after a concurrent code merge. The tag still identifies the published cut; main contains that release metadata plus the later pull request. An advisory that looks only for reachable tags can overstate unreleased work in this case. The actual package version and next-release notes remain authoritative for the next publish. A conflicting rebase still needs a human or agent to resolve it before main advances.
