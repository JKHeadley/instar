<!-- bump: patch -->

## What Changed

Automatic repository inventory uses a restricted set of discovery and committed-history queries. It skips uncommitted-edit checks that could run programs configured by a discovered repository.

## What to Tell Your User

Development agents still find local projects and flag commits that may exist on only one machine. The inventory now marks the state of uncommitted edits as unmeasured. If you are about to move or retire a machine, check those edits separately in the repositories you trust.

## Summary of New Capabilities

Repository inventory distinguishes committed-history observations from unmeasured working-tree state.
