# ELI16: the updater's path probe is marked as deliberate

A test counts places where the code quietly ignores an error, so new ones get a
second look. A recent updater change added one such place on purpose: it tries a
few possible locations for a program and simply moves on when one is missing.
That pushed the count one over the limit, so the main branch went red and every
waiting change was held. This change labels that spot as deliberate, with the
reason, so the count is back under the limit. Nothing about how the updater
behaves changes.

## What changes for people

Nothing anyone can see. The updater finds npm in the same order as before and
behaves the same when it cannot find it. The only visible effect is that the
test line starts moving again: while the main branch was red, every pull request
that did not fix this test was held in place, including work that has nothing to
do with the updater.

## Why not just raise the limit

Raising the limit would make room for the next quiet error-swallow to slip in
unnoticed. Labelling this one spot, with a written reason a reviewer can check,
keeps the limit honest.
