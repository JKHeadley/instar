# Side-Effects Review — Standards False-Claim Guard

**Version / slug:** `standards-false-claim-guard`
**Date:** `2026-07-31`
**Author:** `echo`
**Tier:** `1` (single build script + its unit tests; no runtime surface, no new authority)
**Second-pass reviewer:** `not required at Tier 1 — the PR is the review surface`

## Summary of the change

`scripts/standards-coverage.mjs` already answers "does this standard NAME a resolvable guard?".
It cannot answer "does this standard CLAIM one?". This adds that second question, scoped to
standards the script has already classified `documented-only`.

- **`detectEnforcementClaims(article)`** — matches assertions of a specific running mechanism
  (`a scheduled <x> audit/job/check`, `walks the list`, `checked/runs/fires on a cadence`,
  `fails the build`, `enforcement is`, `is enforced by`, `on every machine daily`) over the
  Rule / In-practice / Applied-through fields. Prescriptive framing within 60 chars before a match
  (`must`, `should`, `shall`, `needs to`, `ought to`, `is required to`) is excluded.
- **`falseClaimCount` + `falseClaims[]`** on the report, and a per-standard `FALSE CLAIM —` line on
  stderr naming the matched phrases.
- **`STANDARDS_FALSE_CLAIM_CEILING`** floor (default **1**, the measured count) checked in
  `--check`.
- Four tests in `tests/unit/standards-coverage-ratchet.test.ts` pinning both sides of the boundary.

Files: `scripts/standards-coverage.mjs`, `tests/unit/standards-coverage-ratchet.test.ts`.

## Decision-point inventory

- Claim detection over an article's prose — **add** — read-only classification of a markdown field;
  decides a COUNT, never an action.
- `falseClaimCeiling` comparison in `--check` — **add** — can fail a CI build. This is the only
  authority the change carries.

---

## 1. Over-block

The realistic over-block is a standard flagged for *describing a requirement* rather than asserting
a fact. Two structural mitigations, neither of them threshold-tuning:

- **Scope.** The detector runs ONLY over articles already classified `documented-only`. An article
  that asserts machinery *and* cites a resolvable guard is never examined. There is no
  configuration that widens this — it is a property of where the call sits in the loop.
- **Prescriptive exclusion.** A negative lookbehind drops a match preceded by `must` / `should` /
  `shall` / `needs to` / `ought to` / `is required to` within 60 characters, which is the shape a
  requirement takes ("must be checked on a cadence by machinery").

Measured over the live registry: **1 flagged of 22 gaps / 81 standards.** The one flagged is
verified false by hand (Cross-Store Coherence — its named daily audit does not exist; of its three
enumerated invariants, one has a per-message delivery-time fail-safe and two have no checker).
Zero false positives across the other 21.

Blast radius if it over-blocks anyway: a CI failure with a message naming the standard and the
exact phrases. The fix is a one-word prose edit or a `STANDARDS_FALSE_CLAIM_CEILING` bump. No
runtime behaviour, no agent action, no user-facing surface.

## 2. Under-block

Under-blocking is the expected and accepted state. The pattern list is deliberately narrow —
precision over recall — so a standard asserting machinery in wording not covered (e.g. "this is
policed continuously") is missed. That is the safe direction: a missed false claim leaves the
status quo (an ordinary gap), while a false positive would fail a build for a rule that is honest.

The ceiling starting at 1 rather than 0 is also deliberate under-blocking: it accepts the existing
false claim rather than failing a build for a pre-existing condition the check has only just become
able to see. It remains load-bearing at 1 — a *new* standard claiming an unnamed guard fails
immediately.

## 3. Level-of-abstraction fit

Correct layer. The question "is this standard's self-description honest?" is a property of the
standards registry, and the registry parser is the only component that already has each article's
fields in memory and its guard-resolution verdict. Putting it anywhere else would mean re-parsing
the constitution.

It is deliberately NOT in `StandardsEnforcementAuditor` (the library the `/conformance` route
serves): that surface is observe-only and non-gating by design, and this needs to fail a build.
The two implementations already disagree by one article (81 vs 82), recorded rather than averaged;
adding a gating check to the non-gating side would deepen that.

## 4. Signal vs authority compliance

This is a **brittle, low-context filter with build-failing authority**, which is exactly the shape
*Signal vs. Authority* warns about. Justification for why it is acceptable here rather than a
signal:

- The domain is **not** agent behaviour or message content — it is a fixed, human-authored,
  version-controlled document of 81 articles. The input is bounded and inspectable, not adversarial
  or open-world.
- The authority is **a CI failure on a docs file**, not a blocked action, message, or session. The
  cost of a wrong verdict is one prose edit; nothing is lost and nothing is delayed for a user.
- The same file already carries two comparable deterministic gates (the enforced-ratio floor and
  the zero dangling ceiling) with the same shape and authority.

Had this needed to judge *meaning* rather than *presence of an assertion pattern*, the correct
implementation would be an LLM gate per *Intelligent Prompts*. It does not: it reports a phrase
match to a human, who decides.

## 4b. Judgment-point check (Judgment Within Floors)

No judgment point is delegated. The check reports a count and the matched phrases; a human decides
whether to build the guard or amend the prose. The ceiling is an operator-visible constant with an
env override.

## 5. Interactions

- **Enforced-ratio floor** — independent. A false claim is also counted as a gap, so it already
  depresses the ratio; this adds a *distinct* signal, it does not double-count into the ratio.
- **Dangling-ref ceiling** — disjoint by construction: dangling means a citation that does not
  resolve; false-claim means no citation at all.
- **`/conformance/coverage`** — untouched. That route continues to report `documented-only` for the
  same article; the two surfaces will now differ in *detail* (this one names it a false claim),
  which is the intended asymmetry between a gating build check and an observe-only route.

## 6. External surfaces

None. No route, no config file, no user-visible message, no network call. The only new surface is
one env var (`STANDARDS_FALSE_CLAIM_CEILING`) and additional stderr lines in CI output.

## 6b. Operator-surface quality

The failure message names the standard, the matched phrases, and the two acceptable resolutions
("must either NAME the guard that runs it, or stop claiming it"). It teaches the required shape
rather than only reporting a number, per the refusal-message convention used elsewhere in the file.

## 7. Multi-machine posture

Not applicable. A build-time script over a git-tracked file; no state, no per-machine posture, no
replication, no lease interaction.

## 8. Rollback cost

Near zero, and there are three independent levers:

1. `STANDARDS_FALSE_CLAIM_CEILING=<n>` in the environment — no code change.
2. Revert the commit — the two prior floors are untouched by it.
3. Delete the `CLAIM_PATTERNS` entries — the check degrades to reporting 0 and passes.

No migration, no persisted state, nothing to un-write.

## Conclusion

Ship at Tier 1. The change is one build script and its tests; its only authority is a CI failure on
a documentation file; its precision is structural rather than tuned; and its default ceiling cannot
fail any build that passes today.

## Evidence pointers

- Finding that earned it: `docs/findings/2026-07-31-constitution-asserts-an-audit-that-does-not-exist.md`
- Live measurement: `total=81 … gap 22 false-claims=1 dangling=0`, with
  `FALSE CLAIM — "Cross-Store Coherence Is an Invariant" asserts running machinery ("A scheduled
  coherence audit", "on every machine daily", "walks the list") but names no resolvable guard.`
- Boundary verification against the real script on temp fixtures: claim-without-guard → exit 1;
  claim WITH a resolvable guard → exit 0; prescriptive "must" → exit 0; ordinary unguarded standard
  → exit 0.
