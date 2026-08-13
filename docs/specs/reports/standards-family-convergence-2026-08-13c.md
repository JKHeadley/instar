# Standards area audit — 2026-08-13c (the merge model)

**Why a third audit today.** The first covered applying six rulings; the second covered ruling 4a as
*archival retirement*. The operator then re-ruled the retirement model itself — **MERGE, not
archive** — which amends every area again. An audit written before the change it covers is the
stale-evidence defect the ratchet exists to catch, so this change gets its own.

**Evidence classes are labelled throughout.** `BEHAVIOUR-PROVEN` = a check was executed and its
result observed. `INSPECTION-VERIFIED` = text was read and judged. They are not interchangeable.

---

## The change

Nothing is retired. All 25 previously-retired standards are LIVE, full text intact, each declaring
itself a named subsection of its parent and stating the specific tripwire it contributes; each parent
names every child and that child's tripwire. Retirement records and forwarding markers are gone, and
the redirect lint with them. Two new rules the operator ordered are built: insertion-time tree
placement, and bidirectional standard-to-code references.

## The operator's own test, and whether it is met

His words are the bar: *"if the lower level standards are retired, the higher level standards may not
have the level of specificity needed for the development process to avoid the pitfalls that the
retired standards represent."*

`INSPECTION-VERIFIED`: a developer reading a parent now meets each child by name **and the specific
tripwire it carries**, then can read the child's full text. The specificity exists at both altitudes.
Whether every tripwire is faithfully summarised at the parent is a reading, not a check — and it is
the single thing here no lint can verify. Called out rather than folded into the pass.

## Structural verification — BEHAVIOUR-PROVEN

| property | result |
|---|---|
| articles | **88** (87 + the new bidirectional-reference rule) |
| enforcement ratio | **0.7386** (up from 0.7356 — the new article carries a real guard) |
| dangling refs / unrecognized sections | **0 / 0** |
| parentage relations | **13, all resolving and bidirectional** |
| retirement records / forwarding markers | **0 / 0** — the archival model is fully removed |
| merged children / parents naming them | **25 / 16** |
| articles declaring a tree placement | **77 of 88** (was 30) |
| typecheck | exit 0 |

## The design decision, and the measurement behind it

The ruling says "named subsections". This is implemented as declared, bidirectionally-enforced
parent-child relations rather than physical `####` nesting. **Measured before choosing: 13 of the 25
have a parent in a different family.** Relocating them would move articles across family boundaries
and rewrite every area's denominator and committed floor — and the ruling says the coverage lint stays
and nothing leaves the live surface. The deviation is stated in the matrix rather than buried.

## Independent fidelity lens — ACCEPTED-WITH-FINDINGS

Run against Justin's quoted words, not against the ruling's summary. Six findings; two rated HIGH.

- **Specificity preserved** — SATISFIED. "Substantive preservation, not merely the appearance of it."
- **Enforcement no longer triggers retirement** — SATISFIED; the disputed premise is abandoned.
- **Placement lint grandfathers too much** — UNDERREACH, MEDIUM. **Acted on:** the lint now also
  requires a placement when a grandfathered article is *modified*, which drove declarations from 30
  to 77 and shrank the baseline from 57 to 11.
- **Back-references only partially delivered** (23 of 50; rule says *all* infrastructure) — UNDERREACH,
  HIGH ×2. **Acted on:** the honest ratio is now stated in the article itself, with a dated countdown
  and owner `ACT-1768`, rather than a ratchet that prevents regression while implying delivery.
- **"Superseded incident" wording** — OVERREACH, LOW. **Acted on:** reworded across all 25 — a
  structure preventing the original failure is a reason the rule is *enforced*, not a reason it is
  obsolete, which is precisely the operator's worry.

## Three defects in the new placement lint, and how each was caught

Recorded because the pattern matters more than the fixes.

1. Its parent regex matched the bolded phrase `**named subsection**` instead of the parent name —
   caught by running it.
2. It referenced an undefined `ROOT`, threw, and the `catch` reported a **clean pass it never
   earned** — caught by asking why "clean" appeared. The catch now fails loudly on a programming
   error instead of degrading to inert.
3. Its diff parser looked for `### Title` context lines that `-U0` never emits — caught by a
   **positive control** (edit a grandfathered article, expect a failure). Nothing else would have
   found it; it reported clean three times for three unrelated reasons.

## Coverage limitations, stated

- Fidelity of each of the 25 parent summaries to its child's actual tripwires is
  **inspection-verified**, by one lens, in one session. It is the highest-value thing to re-review.
- The back-reference lint checks that a cited file names *a* standard, not the *right* one, and
  covers only registry-cited files while the rule says all infrastructure. Both named on the article.
- 11 articles still declare no placement. Shrink-only, and the number is stated rather than implied.

## Verdict

**Accepted for all six areas.** Six findings, five acted on, one accepted with its reason. The
structural guarantees are behaviour-proven and lint-enforced; the judgment-bearing claim — that the
parents carry the specificity — is labelled inspection-verified and is not summarisable as more.
