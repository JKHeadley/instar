# Upgrade Guide — vNEXT

<!-- bump: patch -->
<!-- internal-only -->

## What Changed

Instar's existing state registry check now inventories the current writers and planned canonical owners for job definitions and project lifecycle. It verifies that each enrolled kind and scope declares one planned owner and that derived project digests use a registered materializer. It detects additional direct writes to protected stores when the destination can be resolved in the source file.

## Evidence

The state registry lint passed over the real source tree. Twenty-four focused tests passed and exercise direct and aliased writes, malformed or overlapping declarations, an independent write to the digest, and a genuine projection. The runtime paths and installed authorities are untouched.
