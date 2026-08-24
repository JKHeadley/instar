# Side-Effects Review — Enforce Amendments 3 and 5 of the multi-machine standard

**Version / slug:** `ratify-multi-machine-amendments-2026-08-22`
**Date:** `2026-08-22`
**Author:** `echo`
**Second-pass reviewer:** `codex-cli — external adversarial lens, 4 rounds (9 → 4 → 2 → 0 findings)`

## Summary of the change

The operator ratified five amendments to *An Instar Agent Is Always a Multi-Machine Entity* on 2026-08-22 (topic 52222, all five approved). Two of them are deterministically checkable and are enforced here in `scripts/lint-machine-local-justification.js`, the report-first marker parser that grades `machine-local-justification:` markers in specs. **Amendment 3** narrows `physical-credential-locality` so it covers only a credential whose relocation is *prohibited* — the marker must now carry `prohibited-by="<authority>"` and `permanence=permanent|temporary`. **Amendment 5** adds a fourth taxonomy key, `migrating-to-unified`, permitted only with `ratified=<ref> tracking=<ref> expires=YYYY-MM-DD`, where an already-past expiry is itself a finding. The registry text for all five amendments lands in the same change (`docs/STANDARDS-REGISTRY.md`), with Amendment 4 as a new Substrate article. Amendments 1, 2 and 4 are declared UNENFORCED in the registry rather than given a guard they do not have.

## Decision-point inventory

- `gradeMachineLocalMarkers` (scripts/lint-machine-local-justification.js) — modify — grades marker presence/well-formedness; gains two per-key contracts.
- `TAXONOMY_KEYS` (same file) — modify — the closed taxonomy gains `migrating-to-unified` by operator ratification.
- `hasValidMarker` (A1 arm, same file) — modify — a marker now DEFENDS a machine-local posture only when well-formed for its key.

The lint holds no blocking authority anywhere: it ships report-first (exit 0 unless `--strict`), is not wired into CI as a blocking gate, and is not invoked by any runtime path.

## 1. Over-block

The narrowing makes 16 existing `physical-credential-locality` markers report findings, and 9 of those were the sole defence of their surface, so those surfaces now also report A1-undefended. **This is the intended effect of the amendment, not an over-block**: the operator's stated reason for Amendment 3 is that the key as written let a storage habit assert a physical constraint, and a narrowing that fails none of the cases it narrowed has narrowed nothing. It cannot over-BLOCK in the literal sense because the lint blocks nothing — total findings move 94 → 135, all report-only. The sweep to fix those 16 markers is separate work and is named as such rather than folded in here.

## 2. Under-block

The parser checks the PRESENCE and shape of a named authority, never its truth: `prohibited-by="because I said so"` passes the parser. That is deliberate and is the standing signal-vs-authority split — the `/spec-converge` integration reviewer holds the semantic authority to decide whether a stated prohibition is real. Likewise `ratified=`/`tracking=` are checked as existence-shaped refs (SHA / URL / dotted key), exactly as `operator-ratified-exception` already is, not resolved against the objects they name. Stating this rather than implying the parser judges truth.

## 3. Level-of-abstraction fit

The contracts live in the parser that already owns marker well-formedness, beside the identical existence-check `operator-ratified-exception` has carried since the lint shipped. No new file, no new invocation point, no new gate. Amendment 5's citation requirements were chosen *because* they reduce to that existing check — which is why 3 and 5 land enforced while 1, 2 and 4 cannot.

## 4. Signal vs authority compliance

Compliant, and unchanged in kind. The lint is a SIGNAL: cheap, deterministic, no LLM, report-first, non-blocking. The AUTHORITY over whether a posture is correct remains the `/spec-converge` reviewer. The change adds no blocking capability and does not move the lint toward one. `--strict` remains an opt-in capability used by this lint's own tests, as before.

## 4b. Judgment-point check (Judgment Within Floors standard)

No judgment point is added. Every new check is a deterministic parse of named fields plus one date comparison. Nothing here calls a model or infers intent from prose — and the one place where judgment genuinely belongs (is the named authority real?) is explicitly left with the reviewer rather than approximated in a regex.

## 5. Interactions

- **`docs/STANDARDS-REGISTRY.md`** — the amended article states the taxonomy this parser enforces. Both ends of the pair land in the same commit, so the prose and the parser cannot disagree.
- **`scripts/standards-coverage.mjs`** — classifies articles by the guard their prose names. The amended article names this lint for Amendments 3 and 5 ONLY, and declares 1, 2 and 4 unenforced. This is deliberate: *Cross-Store Coherence* records that naming a guard in prose made an article classify as ENFORCED by a guard measuring something else, and the enforcement ratio rising on an edit that built nothing was the tell. Reproducing that inside the article being amended for honesty would be the worst available outcome.
- **`tests/fixtures/spec-lint/A-good-defended.md`** — updated to the new contract. The pre-amendment bare form is preserved as `A-bad-credential-bare.md` so the case that used to pass is shown failing rather than deleted.
- **`docs/standards-registry-floor.json`** — `minArticleCount` 88 → 89 for the new Substrate article.

## 6. External surfaces

None. No HTTP route, no CLI command shipped to agents, no message, no notification, no scheduled job. The lint is a repo dev script; end-user agents never invoke it.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface is added. The operator-facing consequence of this change is the registry text itself, which was written for a reader making a decision, and the five plain-English questions the operator answered before it was written. Finding messages name the amendment and quote the offending marker so an author can act without reading the parser.

## 7. Multi-machine posture (Cross-Machine Coherence)

`unified` — trivially. The lint is a stateless pure-function parser over repo files with no durable state, no per-machine state, no generated URL, and no notification. Running it on any machine over the same tree produces the same findings. The one non-pure input is the current date, used solely for the expiry arm; it is injectable (`today`) and defaults to `new Date()`, so a machine with a skewed clock reports a different expiry verdict — an acceptable and visible divergence for a report-only signal, and the reason the parameter exists rather than reading the clock inline.

## 8. Rollback cost

Near zero and purely additive to revert. Removing `migrating-to-unified` from `TAXONOMY_KEYS` and deleting the two grader functions returns the parser to its prior behaviour exactly; the fixtures and tests revert with them. Because the lint blocks nothing, a revert cannot strand anyone's work — the only effect is that the two amendments become documented-only like the other three. The registry text and the parser must be reverted together or the article names a guard that no longer checks what it claims.

## Conclusion

Ship. The change is the mechanical half of an operator-ratified constitutional amendment, adds no authority, has no runtime or external surface, and is covered both directions by tests (well-formed markers pass; the narrowed case, each missing citation, and an expired posture each fail). The honest caveat that belongs with it: the registry edit itself cannot merge until the standards direction guard has an approver key installed in protected main — that gate is the operator's and is named in the PR rather than worked around.

## Second-pass review

**Run, and it changed the change.** An external model was given the diff with instructions to REFUTE — contradiction, over-claim, loophole, subject-drift — not to approve. Four rounds; nine findings; convergence when a full re-review returned NO NEW FINDINGS. Full record: `docs/specs/reports/standards-family-convergence-2026-08-22.md`. The six that altered the constitutional text:

1. **`proxied-on-read` contradicted the new survivability clause** — the article enumerated a posture its own Rule forbids, each citable against the other. Now annotated operational-only and named in the Rule.
2. **The new key was RENEWABLE, not self-terminating** — proven by this change's own first-draft fixture, which used `expires=2099-01-01` and passed. Closed in two steps: a 180-day horizon, then `since=` plus a 360-day total-lifetime cap after the lens observed a per-declaration horizon is renewable.
3. **The same loophole re-created one key over** — round 3 gave the TEMPORARY credential barrier a deadline but no lifetime cap, reintroducing on the older key what had just been closed on the newer. Now identical contracts. Worth naming: a fix patterned on another fix inherited the defect that pattern had already been corrected for.
4. **Erasure authority is not only the operator** — the carve-out now covers a lawful erasure obligation, the `Fails.` line no longer re-narrows it, and a PROPAGATION condition requires a permitted deletion to reach every duplicate, summary and index the duplication rule created.
5. **Two over-claims** — "ENFORCED" read as covering semantics the parser cannot check (now "deterministically CHECKABLE marker contracts", with the boundary in the same sentence); and three days of compressed message text extrapolated to "any hardware" (now scoped to its sample).
6. **The continuity test begged the question for dual-purpose records** — resolved by a precedence rule (a bounded store may age its COPY, never hold the ONLY copy) plus, in round 4, a requirement that a replacing summary OMIT the erased material.

The lint changes in this artifact's §1–§8 above are the mechanical half of findings 2, 3 and 5; the tests were extended in step with each round (13 → 16 → 20 → 21).

## Evidence pointers

- `tests/unit/lint-machine-local-justification.test.ts` — 21 tests, all passing, including the withdrawn-defence arm (a bare credential marker must leave its posture reading UNDEFENDED, not merely reportable), the self-terminating arms (expired, beyond-horizon, and past-total-lifetime each fail separately), and the TEMPORARY-barrier contract (exit ref, re-review date, and `since` each tested missing).
- Sweep before/after over `docs/specs/**`: 94 findings → 135 (`+19` credential markers now needing an authority and permanence, `+11` postures thereby left undefended, `+19` permanence findings). Report-only; no build state changes.
- `node scripts/lint-registry-tree-parentage.mjs` — clean, 89 articles, 40 bidirectional relations.
- `node scripts/standards-coverage.mjs --check` — the Building and The Substrate area audits are RECORDED and current (`docs/audits/standards-area-audit-2026-08-22.json`). The ONLY remaining failure is the direction guard, which requires an operator-signed ratification per changed article; the approver key pinned in protected main is an empty placeholder. Named in the PR, not worked around.
- `node scripts/lint-registry-insertion-placement.mjs` — clean, 89 articles, 78 declaring a placement.
- `node scripts/generate-standards-registry-asset.mjs` — canary accepts; 0 unrecognized article sections.

## Class-Closure Declaration (display-only mirror)

The class is "a taxonomy key whose contract the parser cannot check." Both keys amended here are closed against it: each new requirement was chosen so it reduces to an existence check the parser already performs. The class is NOT closed for Amendments 1, 2 and 4, and that is stated in the registry as an unenforced sub-obligation with a dated countdown rather than left for a reader to discover.
