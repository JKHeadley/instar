# Side-effects review — isolated undeclared-template test

## Summary

Tier1 narrow reversible test-only correction, one existing test plus ELI16/release/side-effects records. The full verifier found a deterministic unit cleanup failure and dirty tree on constitutional PR2842. Existing PR2801 proposes raw source cleanup; this repair instead avoids source mutation altogether. No production guard, lint policy, authority or declaration floor changes.

## Decision points

No runtime decision changes. The same exact lint implementation must pass a real-tree check, pass a declared/hash-pinned Python fixture and refuse a newly undeclared Python fixture by name.

## 1. Over-block

No new runtime refusal. Test temp cleanup uses the existing SafeFsExecutor on a unique directory under os.tmpdir, not the repository.

## 2. Under-block

The negative fixture remains substantive: exact shipped script, real filesystem traversal, nonempty initial declared population, exact undeclared filename assertion. Real-tree lint executes before and after the negative test. No skip, mock lint response, ceiling relaxation or timeout increase.

## 3. Level of abstraction

Isolation belongs in the faulty test rather than weakening SourceTreeGuard or allowing arbitrary deletion of a source path. No new fixture registry or production root override.

## 4. Signal vs authority

Per docs/signal-vs-authority.md, production authority is untouched. The existing deterministic declaration invariant is exercised unchanged.

## 5. Interactions

The test never writes a file in the source tree, so parallel source readers and post-verification dirty-tree checks remain valid. Unique mkdtemp paths avoid collisions across test processes. afterEach cleans directories recorded immediately after allocation, including failed assertions. No pre-existing source file can be deleted as cleanup.

## 6. External surfaces

No product-facing change, API, scheduler, activation or message. Real-tree lint subprocess uses process.execPath, matching the verifier's supported Node process rather than whichever node occurs first in PATH.

## 6b. Operator-surface quality

No UI. Release note explains that verification no longer writes a test file into source. No full-suite or deployment claim.

## 7. Multi-machine posture

No product state introduced. The test uses each runner's existing temporary-storage owner and runs the same checker on every machine. Temporary data is disposable and has no agent continuity role.

## 8. Rollback cost

Revert this test-only commit. No production state, migration or config repair.

## Verification

Actual failing canonical peer run and failed isolation identified the prior cleanup defect. Corrected focused unit test passes against the real source tree and isolated negative population. Full verification remains required after publication.

## Second-pass review

**Reviewer:** /root/review_history — independent native Codex fresh-eyes reviewer.

Concur. Exact lint, valid content-pinned population and specific undeclared-Python failure preserve the negative proof. Real-tree checks remain before and after. Guarded cleanup touches only tracked temporary directories, including assertion-failure paths. No production-tree mutation, weakening or bypass found.
