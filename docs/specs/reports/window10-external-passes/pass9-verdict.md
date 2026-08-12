# External review pass 9 — reviewer's verbatim final answer

Pass 9 found this archive held seven files while I had told it there were eight and to audit me
against them — the SECOND time the archive lagged my claim about it, two passes after the first.
The fix for unauditability is only as good as the discipline of keeping it current, and that
discipline failed twice. Exploration logs are NOT kept; only the final answer block, verbatim.

---

```text
FINDINGS —

1. SEVERITY: major — The three historical ratchets do not constrain this change. Their baseline files are absent from `origin/main`, and with `*_BASE_REQUIRED=0` all three lints report clean on the establishing path. The internal hash chain is not independently immutable: its tail can be deleted or the chain recomputed. Thus this change can establish the very history it claims to preserve.

2. SEVERITY: major — Comment exclusion remains bypassable for future admissions. `withoutComments()` does nothing for Python and other unhandled languages, and its shell rule misses valid comments beginning after punctuation: `true;# CMT-999999` remains unchanged and resolves. The fact that no current resolution depends on those extensions does not protect a new marker introduced with such a comment. Deliberately declining blanket widening was therefore not sufficient; the resolving corpus must be restricted to handled forms or all admitted comment syntaxes handled.

3. SEVERITY: major — The invisible-payload regression test is detached from production. `tests/unit/telegram-reply-invisible-payload.test.ts` defines its own copy of the regex instead of invoking the route or importing a shared predicate. Removing or changing the guard in `src/server/routes.ts` leaves the test green. Both-direction examples are good, but they do not prove route enforcement.

4. SEVERITY: major — The repository’s required coverage gate rejects the current state. `node scripts/standards-coverage.mjs --check` reports stale audits for both Building and The Substrate.

5. SEVERITY: major — The convergence evidence is incomplete. The archive contains exactly seven files, `pass1-verdict.md` through `pass7-verdict.md`; no committed pass-8 verdict exists anywhere in repository history.

6. SEVERITY: minor — Current self-description is stale again. The live resolver reports 201 unresolved of 217, while `scripts/lint-deferral-referent-resolves.mjs` and tooth (E) of *Verify the State, Not Its Symbol* still assert 137/217 and 63%.

7. SEVERITY: minor — “Malformed gap” remains broader than the validated schema. The newly typed `shape`, `shapeDescription`, `evaded.standard`, `evaded.how`, and matched evidence are improved, but fields including `gap.id`, `evaded.atMoment`, and `sweep.method` remain untyped or unchecked. The family also says every record identifies the fingerprint evaded, while all five live records use the `hadNoFingerprint` exception.

Critical severity is empty. Nit severity is empty.

MECHANISM-CHECK —

(a) PARTIAL — The named injections are closed: the three prose legs require trimmed strings with minimum lengths, and matched `evidence`/`action` requires a trimmed string of at least ten characters. Other record fields remain structurally unchecked, so the broader malformed-record claim is not closed.

(b) PARTIAL — When a pinned historical baseline exists, the code now rejects multiple fresh rows and requires `from === baseIds.size` and `to === current.length`. For this change, all three baselines take the establishing path, so that admission logic supplies no historical constraint.

(c) CLOSED — Resolution accumulates token indexes across the corpus and declares a compound marker resolved only when every id-shaped token has been seen.

(d) CLOSED — Binary exclusion now checks for any NUL byte or more than 5% C0 non-text bytes in the first 8 KiB. It remains explicitly and accurately described as a heuristic.

(e) PARTIAL — Production uses `\p{Default_Ignorable_Code_Point}`, `\p{Cf}`, and `\s`, and the committed examples cover refusal and preservation directions. The test duplicates the predicate and therefore does not regression-test production wiring.

MY-ACCOUNT-CHECK — Passes 1–7 match the archived verdicts exactly: `5 major + 1 minor`; `7 major + 2 minor`; `6 major + 2 minor`; `4 major + 2 minor + 1 nit`; `4 major + 2 minor`; `4 major + 1 nit`; `5 major + 1 nit`. The discrepancy is pass 8: the claimed `5 major` cannot be checked because `pass8-verdict.md` is absent. The archive has seven files, not eight.

MAGNITUDE-METRIC — I keep LOAD-BEARING ENFORCEMENT INTEGRITY: defects that let a guard, ratchet, test, or evidence archive certify a condition it has not established. That remains the critical metric because these defects contaminate every downstream conclusion drawn from a clean result.

TRAJECTORY — Magnitude is not genuinely declining. Retrospectively applying the metric gives roughly `4 → 4 → 5 → 4 → 4 → 4 → 4` through the seven archived passes: the early defects move among reachability, population, freshness, schema, and manufactured coverage, while passes 4–7 remain at four. Pass 8’s claimed four load-bearing defects is unauditable because its verdict is missing. Pass 9 has three load-bearing defects: unbound establishing ratchets, comment-based false resolution for new admissions, and a production-detached regression test. Even granting the interested account for pass 8, `4 → 3` after five flat passes is one improvement, not yet a defensible cross-pass decline. Raw major findings are also flat at the claimed `5 → 5`.

COHERENCE — No. The registry is markedly more candid about residuals, and repairs (c) and (d) are real, but its enforcement account still reports shrink-only history without historical constraint, claims comments cannot resolve markers while admitted comment syntaxes can, and presents a duplicated predicate as route regression evidence. The stale family audits and missing eighth verdict independently prevent the repository from supporting its own convergence account.

VERDICT — reject. Closure is blocked by the unconstrained establishing baselines, comment-based resolver admission bypass, production-detached invisible-payload test, stale Building/Substrate audits, and missing committed pass-8 verdict. These blockers are not converted into expiry-dated named work, and the load-bearing stream has produced only one lower pass after a long plateau—not a genuine cross-pass decline.
```
