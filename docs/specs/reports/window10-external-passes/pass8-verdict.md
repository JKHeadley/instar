# External review pass 8 — reviewer's verbatim final answer

Pass 9 found this archive held seven files while I had told it there were eight and to audit me
against them — the SECOND time the archive lagged my claim about it, two passes after the first.
The fix for unauditability is only as good as the discipline of keeping it current, and that
discipline failed twice. Exploration logs are NOT kept; only the final answer block, verbatim.

---

```text
FINDINGS —

Critical severity: empty. Minor severity: empty. Nit severity: empty.

1. SEVERITY: major — The repository’s required standards-coverage gate rejects the current state. `node scripts/standards-coverage.mjs --check` reports stale audits for both Building and The Substrate. This is a present CI failure, not expiry-dated remainder.

2. SEVERITY: major — The baseline machinery remains only partly load-bearing. All three baseline files are absent from `origin/main`, so this change takes the unconstrained `establishing` path. Future CI is correctly pinned, but the current establishment is a promise reviewed manually, not historically enforced protection. Moreover, rebaseline admission still accepts multiple new rows, arbitrary integer `from` values, and optional evidence; only one row needs `to === current.length`.

3. SEVERITY: major — The enforcement-gap lint still overclaims malformed-record and freshness validation. Truthy non-string `shape`, `shapeDescription`, and `evaded.how` values pass; empty-string matched evidence/action passes. Current data demonstrates the missed staleness: `outsidePopulation.count` remains 86 while the live baseline is 82, and several verdicts end at 199 orphans while the executable result is 200. The lint nevertheless reports clean because its digest covers the article, not cited guard/data changes.

4. SEVERITY: major — Deferral resolution still permits manufactured evidence beyond the explicitly dated bare-reference residual. “Comments do not resolve” is false for unhandled comment syntaxes, binary rejection is only a NUL-byte test, and compound markers resolve if any token appears. The registry itself is also stale at 199/217 versus the reproduced 200/217. The path-plus-hash remainder is dated, but these additional mismatches are not.

5. SEVERITY: major — The invisible-payload repair closes U+200B, not the claimed class. The route regex accepts other invisible/default-ignorable whole bodies, including U+200E, U+2061, and U+FE0F. No regression test for this route change is committed. The incident-specific case is fixed, but “invisible payloads are now refused” is overstated.

MECHANISM-CHECK —

(a) PARTIAL — Verified event-pinned base SHA selection, extraction into `RUNNER_TEMP`, all three `<PREFIX>_BASE_FILE`/`_BASE_REQUIRED` bindings, no Git invocation in the checker, hash-chain verification, canonical dates, jailed path-plus-SHA retirement evidence, and duplicate live-gap IDs. It remains partial because this change is establishing, rebaseline admission is not exact, and referent resolution remains mention-based with incomplete comment/binary classification.

(b) CLOSED — The two `--update-baseline` writers preserve `rebaselines`; the current 103→137→199→200 chain validates. Genesis permits adding a hash to a pre-chain base row only when every other field is byte-equivalent. This closes the producer’s history-destruction defect, although authenticity still depends on the pinned base after establishment.

(c) CLOSED for the three specifically named corrections — Seven archive files exist; `R-8` no longer resolves through `assets/demo.gif`; `countdown` and `sweptAt` now use `canonicalDate`. This does not close the broader stale-data and malformed-schema findings above.

(d) PARTIAL — Verified the U+200B-only body is refused before sending with a diagnostic JSON body, and verified 400 is terminal in both the shell’s recoverability table and `recovery-policy.ts`. The broader invisible-only input class remains open because several zero-width/default-ignorable characters survive the regex.

MY-ACCOUNT-CHECK —

The trajectory table matches all seven archived verdicts exactly:

- Pass 1: 5 major, 1 minor
- Pass 2: 7 major, 2 minor
- Pass 3: 6 major, 2 minor
- Pass 4: 4 major, 2 minor, 1 nit
- Pass 5: 4 major, 2 minor
- Pass 6: 4 major, 1 nit
- Pass 7: 5 major, 1 nit

No numerical discrepancy. The archive now has seven files, though the repository cannot independently authenticate that the late-added pass 1–6 files were contemporaneous.

MAGNITUDE-METRIC —

I retain LOAD-BEARING ENFORCEMENT INTEGRITY: defects allowing a green mechanism or constitutional record to certify protection, freshness, resolution, or closure it has not established. It remains decisive because convergence depends on these ratchets and records, not raw editorial counts.

TRAJECTORY —

No. The archived major stream is 5→7→6→4→4→4→5. On the chosen metric, passes 4–7 were four load-bearing defects each. Pass 8 still has four: historically unconstrained/inexact baseline admission; malformed and stale gap records passing clean; manufactured deferral resolution; and incomplete invisible-payload enforcement. The decisive tail is therefore 4→4→4→4→4, flat rather than declining. The stale family audits are an additional acceptance blocker.

COHERENCE —

No. Several specific repairs are real, especially the pinned CI wiring, preserved rebaseline history, archive completion, and R-8 correction. But the current system simultaneously reports clean gap machinery with stale counts, calls partial schema checks malformed-record enforcement, calls mention-matching resolution, and calls a narrow zero-width list invisible-payload coverage. Its own required family-audit gate also remains red.

VERDICT —

reject. Closure is blocked by the four still-load-bearing defects identified above and by the stale Building/Substrate audits. The load-bearing magnitude remains flat, and several remaining defects lack expiry-dated named work.
```
