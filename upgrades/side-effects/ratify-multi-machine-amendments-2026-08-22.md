# Side-Effects Review — Enforce Amendments 3 and 5 of the multi-machine standard

**Version / slug:** `ratify-multi-machine-amendments-2026-08-22`
**Date:** `2026-08-22`
**Author:** `echo`
**Second-pass reviewer:** `not required (Tier 1 — report-first dev script, no runtime surface)`

## Summary of the change

The operator ratified five amendments to *An Instar Agent Is Always a Multi-Machine Entity* on 2026-08-22 (topic 52222, all five approved). Two of them are deterministically checkable and are enforced here in `scripts/lint-machine-local-justification.js`, the report-first marker parser that grades `machine-local-justification:` markers in specs. **Amendment 3** narrows `physical-credential-locality` so it covers only a credential whose relocation is *prohibited* — the marker must now carry `prohibited-by="<authority>"` and `permanence=permanent|temporary`. **Amendment 5** adds a fourth taxonomy key, `migrating-to-unified`, permitted only with `ratified=<ref> tracking=<ref> expires=YYYY-MM-DD`, where an already-past expiry is itself a finding. The registry text for all five amendments lands in the same change (`docs/STANDARDS-REGISTRY.md`), with Amendment 4 as a new Substrate article. Amendments 1, 2 and 4 are declared UNENFORCED in the registry rather than given a guard they do not have.

## Decision-point inventory

- `gradeMachineLocalMarkers` (scripts/lint-machine-local-justification.js) — modify — grades marker presence/well-formedness; gains two per-key contracts.
- `TAXONOMY_KEYS` (same file) — modify — the closed taxonomy gains `migrating-to-unified` by operator ratification.
- `hasValidMarker` (A1 arm, same file) — modify — a marker now DEFENDS a machine-local posture only when well-formed for its key.

The lint holds no blocking authority anywhere: it ships report-first (exit 0 unless `--strict`), is not wired into CI as a blocking gate, and is not invoked by any runtime path.

## 1. Over-block

The narrowing makes 19 existing `physical-credential-locality` markers report findings, and 11 of those were the sole defence of their surface, so those surfaces now also report A1-undefended. **This is the intended effect of the amendment, not an over-block**: the operator's stated reason for Amendment 3 is that the key as written let a storage habit assert a physical constraint, and a narrowing that fails none of the cases it narrowed has narrowed nothing. It cannot over-BLOCK in the literal sense because the lint blocks nothing — total findings move 73 → 122, all report-only. The sweep to fix those 19 markers is separate work and is named as such rather than folded in here.

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

## Second-pass review (if required)

Not required. Tier 1: one dev script, report-first, no decision authority, no runtime surface, at the declared risk floor.

## Evidence pointers

- `tests/unit/lint-machine-local-justification.test.ts` — 13 tests, all passing, including the withdrawn-defence arm (a bare credential marker must leave its posture reading UNDEFENDED, not merely reportable) and the self-terminating arm (a fully-cited but expired marker is a finding).
- Sweep before/after over `docs/specs/**`: 73 findings → 122 (`+19` credential markers now needing an authority and permanence, `+11` postures thereby left undefended, `+19` permanence findings). Report-only; no build state changes.
- `node scripts/lint-registry-tree-parentage.mjs` — clean, 89 articles, 40 bidirectional relations.
- `node scripts/lint-registry-insertion-placement.mjs` — clean, 89 articles, 78 declaring a placement.
- `node scripts/generate-standards-registry-asset.mjs` — canary accepts; 0 unrecognized article sections.

## Class-Closure Declaration (display-only mirror)

The class is "a taxonomy key whose contract the parser cannot check." Both keys amended here are closed against it: each new requirement was chosen so it reduces to an existence check the parser already performs. The class is NOT closed for Amendments 1, 2 and 4, and that is stated in the registry as an unenforced sub-obligation with a dated countdown rather than left for a reader to discover.
