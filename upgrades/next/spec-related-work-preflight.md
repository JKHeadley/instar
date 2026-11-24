<!-- internal-only -->

# Related-work evidence before implementation

## What Changed

Instar's spec convergence stamp and existing development commit gate require a related-work section. The section records what was checked and how the spec will reuse, extend or set aside relevant work. The commit gate checks the reviewed version in Git's staging area.

## Evidence

The convergence writer tests cover valid evidence, missing evidence and edits after review. The development integration fixture exercises the actual commit gate using different staged and working copies. The installed migration fixture checks that the updated writer receives the helper.
