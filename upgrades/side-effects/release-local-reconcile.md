# Side-Effects Review — release-local: unfinished-release preflight and --reconcile

**Version / slug:** `release-local-reconcile`
**Date:** `2026-10-20`
**Author:** `Dawn`
**Second-pass reviewer:** `Echo (requested on the PR)`

## Summary of the change

After the 1.3.1362 incident (published, never landed; main rebuilt by hand in 76d5a6098):

- **(1) Preflight.** A new preflight compares npm latest with main's package.json. If npm is ahead, a real run refuses (a dry run warns), naming the version and both remedies. An unreadable npm answer stops a real run.
- **(2) `--reconcile <version>`.** It rebuilds the cut:
  - the guide verbatim from `npm pack`;
  - the fragments at the version's `gitHead` deleted, if still on main;
  - package.json and the lock bumped.
  
  Then it hands off to the existing `--push-only` landing: a cut re-check, a hooks-on commit, an atomic push.
- **New lib helpers:** `npmAheadOfMain`, `unfinishedReleaseMessage`, `consumedFragmentsAt`, `bumpVersionJson`.
- **Spec:** one paragraph (wording only, after approval), with a matching ELI16 paragraph.

**Round 2 (Echo's review at 77ed9249f).**
- **Fragment safety:** `--reconcile` deletes a fragment only if its blob on main equals its blob at gitHead AND its text is in the released guide (`fragmentReleasedIn`). Otherwise it stops and names the file.
- **Signals that don't depend on npm:** a per-clone in-flight marker (written before publish, cleared on landing; a failure clears it only if this run wrote it and nothing can have reached npm), and a remote `v*` tag ahead of main.
- **Auth args:** the preflight's `npm view` uses the npm auth args.
- **Cleanup:** the tarball temp dir is removed in a `finally`.
- **Limits:** the marker is per clone. A release left in flight on ANOTHER machine is caught only by the npm and tag signals.

## Decision-point inventory

- **Preflight: npm ahead of main** — add — a stop on a real release (a dry run warns).
- **`--reconcile`** — add — operator-invoked. Its stops: not ahead, not on npm, no gitHead, gitHead not on main, no guide in the tarball.

---

## 1. Over-block

- **Deliberately unlanded version.** A real release is refused whenever npm latest is ahead of main's package.json, even if that version was deliberately left unlanded. Intended: cutting on top of it would bury its notes and fragments. The `resolve-publish-version` "stale package.json" path still exists for CI.
- **npm unreachable.** It refuses when npm latest can't be read. Step 5 already fails closed on the same read; this just stops earlier, before anything is mutated.

## 2. Under-block

- **Non-latest dist-tag.** An unfinished release published under another dist-tag (not `latest`) isn't caught. instar publishes to `latest` only.
- **Inexact fragment set.** `--reconcile` deletes the fragments present at gitHead. If the original run consumed a different set (for example a fragment added after gitHead but before the publish), the rebuilt cut differs. The cut rule still guarantees it is only a cut. The guide comes from the tarball, so the notes are exactly what shipped.

## 3. Level-of-abstraction fit

It reuses the `--push-only` landing (cut rule, hooks, atomic push) instead of a second landing path. The helpers are pure or injected and tested.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface over agent behaviour; deterministic stops on the operator's own irreversible actions.

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. "npm ahead of main" is an enumerable comparison.

## 5. Interactions

- **CI.** publish.yml is unchanged. If CI runs with npm ahead, it bumps from npm as before; the local tool now refuses instead.
- **`--reconcile` and `--push-only`.** `--reconcile` ends in the `--push-only` flow, so all of its checks apply. A hooks-refused commit leaves the rebuilt cut for `--push-only` to finish (tested).

## 6. External surfaces

- **npm:** reads only (`npm view`, `npm pack` of an already-published version).
- **GitHub:** a push of main and a tag, as with `--push-only`.

## 6b. Operator-surface quality

Not applicable.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local BY DESIGN. The preflight is the cross-machine guard: a release published from ANY machine that never landed is now visible to every machine that tries to release next.

## 8. Rollback cost

Revert the PR.

## Conclusion

It makes a buried release impossible to miss, and it automates the hand rebuild through the existing safe landing path.

## Evidence pointers

- `tests/unit/release-local-steps.test.ts` (74): the real CLI with a bare remote, a fake registry and a tarball; 10 of 10 mutations were caught.
- The real 1.3.1362 tarball guide equals main's hand-rebuilt guide, and the fragments at gitHead 7cdc5d571 are exactly `threadline-core-push-config-alias.md`.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable.
