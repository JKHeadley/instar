# Side-effects review for managed native launch binding

Tier 1 for this isolated, unused production startup primitive. The disposable lifecycle now reserves an Instar launch identity before starting Codex and binds the native identity afterward. No live launch code invokes the new admission operations.

## Decision-point inventory

A pending reservation excludes other workers. Binding is a single SQLite transaction. Native IDs cannot collide with another managed claim or a reserved launch identity. A failed pending launch keeps a non-actuating classification.

## Over-block

Pending, aborted and mismatched workers receive no managed directive. The existing claim is preserved. This commit does not remove a prior action claim to permit a replacement.

## Under-block

The bind operation accepts an already verified identity from its caller. Live startup must prove admission, current custody, exact process and launch authority before calling it.

## Level of abstraction and signal versus authority

The store serializes verified startup facts and cannot infer authorization. The enrolled native identity authorizes only the same action under the existing decision checks.

## Tests, impact and rollback

Unit cases cover reservation, pending and abort behavior, native ID collision and pause through the original key. The native lifecycle exercises reservation before launch and receipt of the native ID before releasing the worker. No live database or default is changed. Revert removes the unused binding path.
