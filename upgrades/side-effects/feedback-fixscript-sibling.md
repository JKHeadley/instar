# Side-Effects Review — Copy the fix script's declared siblings; stop a chain's success masking its failure

## Summary of the change

`depsCache.buildNatives()` copied `scripts/fix-better-sqlite3.cjs` into the cache and ran
`npm rebuild … && node scripts/fix-better-sqlite3.cjs`. That script's line 31 is
`require('./resolve-node-binary.cjs')`, and node resolves a relative require from the SCRIPT's own
directory — which held only the one file. So the script exited 1 with `Cannot find module` after the
rebuild had already succeeded, and every attempt reported `deps-install-failed: native rebuild failed
(exit 1)`. Three changes: copy a declared sibling set; SKIP the script when a sibling is unavailable
rather than run it to a certain failure; and make `rebuildFailureTail` prefer the failing half of the
chain over the succeeding half.

## Decision-point inventory

- `buildNatives()` script copy — **modify** — copies `FIX_SCRIPT_SIBLINGS` as well.
- `buildNatives()` command assembly — **modify** — gates the `&& node …` on runnability, not presence.
- `rebuildFailureTail()` — **modify** — adds module-resolution patterns; prefers stderr over stdout.
- `FIX_SCRIPT_SIBLINGS` — **add** — a declared constant, ratcheted by a test.

## 1. Over-block

The only new refusal-shaped behaviour is SKIPPING the fix script when a declared sibling is missing.
That cannot wrongly fail a build: it removes a step that, in exactly that state, is a guaranteed
`exit 1`. The rebuild's own exit status still decides success, unchanged. A skip is strictly more
permissive than today's certain failure, and strictly less permissive than pretending the script ran.

## 2. Under-block

Could skipping hide a genuinely broken binary? The script's job is to verify-and-repair; the rebuild
is what produces the binary. Skipping removes a verification, so the honest answer is: yes, in the
missing-sibling case we lose that extra check — but today that case produces NO binary at all because
the whole attempt aborts. Losing a check in a state that is currently a hard failure is a strict
improvement, and the state is unreachable in practice while the ratchet holds (the sibling ships in
the same repo as the script).

What this does NOT do is widen what trusted code injects: the sibling is read from the same
`sourceRepoPath` at the same `baseSha` as the script, never from the feedback branch or report.

## 3. Level-of-abstraction fit

Alternatives: copy the whole `scripts/` directory (widens injected surface for one need); drop the
fix script from the command (loses verification permanently, not just in the degraded case); or
rewrite the script to inline its helper (changes a shared script used elsewhere, for a caller-side
packaging bug). Copying a declared, ratcheted set is the narrowest fix that matches the real cause.

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface.

`rebuildFailureTail` is pure text selection over output already produced and decides nothing. The
runnability gate chooses whether to append a command, not whether to permit anything.

## 4b. Judgment-point check (Judgment Within Floors standard)

None added. A literal list, a boolean `every`, and a regex over existing output.

## 5. Interactions

- **Shadowing:** none; the rebuild's exit status remains the single determinant.
- **Double-fire:** none; `buildNatives` runs once per `ensure()`.
- **Races:** the copied files live in the per-hash cache directory, discarded with it on failure.
- **Feedback loops:** the tail text feeds the `deps-unavailable` reason read by operators and the
  status route. This change makes that text name the real cause — it was previously reporting npm's
  success line, which is how the first real run of the observability fix still needed hand forensics.

## 6. External surfaces

- **Install base:** strictly better; an executor that could never get past deps now can.
- **External systems:** none. The rebuild's network allowlist is unchanged.
- **Persistent state:** one extra small file inside the per-hash deps cache.
- **Operator surface (Mobile-Complete Operator Actions):** no operator action added or touched; the
  visible change is a `deps-unavailable` reason that names the actual failure.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface added. The one operator-visible string becomes accurate rather than misleading.

## 7. Multi-machine posture (Cross-Machine Coherence)

None. The deps cache and attempt tree are machine-local; nothing replicates or takes a lease.

## 8. Rollback cost

Revert one commit. The symptom returns as `native rebuild failed (exit 1)`.

## Conclusion

Proceed. It fixes the actual remaining blocker with a before/after proof, adds a ratchet so the class
cannot silently reopen, and corrects a reporting heuristic that its own first production run exposed.

## Second-pass review (if required)

Not required — Tier 1: a copy loop, a boolean gate, and a regex, plus tests.

## Evidence pointers

- Proven end-to-end in the real sandbox, two cache copies, same command
  (`npm rebuild better-sqlite3 && node scripts/fix-better-sqlite3.cjs`) and the same confined env:
  - **fix script only (as shipped):** `EXIT=1`, `Cannot find module` at
    `scripts/fix-better-sqlite3.cjs:31:37` — the exact `require('./resolve-node-binary.cjs')` line.
  - **fix script + sibling:** `EXIT=0`.
- The production signal that led here: attempt 4 (12:31Z) reported
  `native rebuild failed (exit 1): rebuilt dependencies successfully` — the compile had succeeded
  (the `HOME` fix landed in #2259 working), and the tail had mis-picked the successful half's line.
- `resolve-node-binary.cjs` requires only node builtins (`node:fs`, `node:os`,
  `node:child_process`), so copying it is complete rather than the first step of a chain.
- Tests have teeth, verified by reverting: the copy and skip tests fail on the shipped copy logic
  (`2 failed | 40 passed`), and the tail test fails when the module-resolution patterns and the
  stderr preference are reverted (`1 failed | 41 passed`). All 42 pass with the fix.

## Class-Closure Declaration (display-only mirror)

The class is "files the injected fix script needs that trusted code must copy alongside it". Today
that is exactly `resolve-node-binary.cjs`. The class is closed by a RATCHET rather than by inspection:
a test parses the real script's own `require('./…')` calls and fails if any is absent from
`FIX_SCRIPT_SIBLINGS`, so a future third sibling breaks CI instead of the pipeline.
