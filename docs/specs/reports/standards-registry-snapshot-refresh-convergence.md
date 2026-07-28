# Convergence Report — The constitution is read from the build that ships it

## Cross-model review: codex-cli:gpt-5.5

RAN. A real GPT-tier external pass ran through the agent's codex CLI on **every one of the ten
rounds** — no round degraded, none was skipped, and the spec body changed between every pair of
rounds so none was delta-skipped.

**Internal-reviewer posture, disclosed rather than implied:** the six internal reviewer perspectives
(security, scalability, adversarial, integration/multi-machine, decision-completeness,
lessons-aware) were applied by the authoring agent as sequential lenses, **not** spawned as parallel
independent subagents, because this session operates under a standing instruction not to spawn
subagents unprompted. That is a REDUCED-INDEPENDENCE posture and is recorded as such: the genuinely
independent reads in this convergence are the ten cross-model passes and the ten
Standards-Conformance Gate runs, not the internal lenses. A reader weighing this spec should
discount the internal findings accordingly.

**Standards-Conformance Gate:** ran on rounds 1 and 2 (1 finding then 0). Both runs reported
`standardsChecked: 22` — which is the very defect this spec fixes, so the constitutional pass
covered roughly a quarter of the constitution. Recorded honestly rather than counted as a clean
pass.

## VERDICT: convergence-failed (10-iteration cap reached)

**This spec did NOT converge and no `review-convergence` tag has been written.**

The criterion is zero MATERIAL findings in a fresh round. Ten rounds ran; **every one produced new
material findings.** Round 10's own summary reads *"No serious blockers. The core move — immutable
versioned runtime data shipped beside the code that reads it, with no fallback to mutable install
state — is architecturally sound"* — and it still raised five findings, two of which changed the
design (the resolver's return contract, and making `articleCount` diagnostic-only instead of
invalidating).

So the honest state is: **the architecture is sound and the specification is not yet precise
enough to hand an implementer.** Those are different claims and the cap exists to stop me
collapsing them. Human input is required before a retry, per the skill's own rule.

## ELI10 Overview

We keep our rules in one document, and a tool grades whether each rule is really enforced. That
tool was reading a copy with 22 rules while the real document had 81 — so its headline figure
(4.55% enforced) was arithmetic over a quarter of its subject. The true figure is 54.3%.

This spec was supposed to fix the copy. Review established that the copy could never have been
fixed: the file it copies FROM is not in our published package at all, so the existing update
machinery has been failing on every ordinary installation since it was written. My root cause was
wrong, and the fix I had written and tested would have done nothing on any machine but my own.

What the spec now says is: stop keeping a copy. Ship the document as part of the build, beside the
code that reads it, and read it from there. No copy, no updater, no "did someone edit this?"
question, no fallback, no drift.

## Original vs Converged

| | draft 1 | final |
|---|---|---|
| Root cause | a too-cautious update policy froze the copy | the file being copied FROM is unpublished; the copy was never reachable |
| Mechanism | always-overwrite migration + backups | a build artifact under `dist/data`, read module-relative |
| Fallback | legacy copy when the asset is absent | **none** — resolver and data ship together, so a missing asset is a broken install |
| Validity floor | refuse a zero-article registry | `sha256` against same-build generated meta; count is diagnostic only |
| Packaging proof | assert the path appears in `package.json` `files` | extract a real tarball and compare bytes; verify inside the lifecycle publish already runs |
| Mechanism count | six (copy → updater → customised-policy → old-vs-broken → fallback → degraded-trust) | one resolver |
| Contract | "STOP" (unspecified) | a typed discriminated union that never throws |

The single largest change: draft 1 ADDED a migration; the final spec DELETES one.

## Iteration Summary

| Round | Cross-model | Conformance gate | Material findings | What changed |
|---|---|---|---|---|
| 1 | ran (MINOR, 6) | ran (1 flag) | 6 | **Root cause disproven** — `docs/` is unpublished; whole design rewritten |
| 2 | ran (MINOR, 5) | ran (0 flags) | 3 | Zero-article floor too weak → generated expectation; no fall-through on invalid; verify the tarball not the manifest |
| 3 | ran (MINOR, 4) | not re-run | 4 | Self-contradiction (rule fixed in one place, stale in two); hash mismatch made invalid; "generation prevents drift" softened |
| 4 | ran (**SERIOUS**, 5) | not re-run | 4 | Three sections still contradicted §3.1; absent-vs-broken discrimination; package-root circularity; pipeline named |
| 5 | ran (**SERIOUS**, 5) | not re-run | 5 | Meta file was both anchor and optional; `--dry-run` cannot prove bytes; committed-vs-generated decided |
| 6 | ran (MINOR, 5) | not re-run | 3 | **Simplification** — runtime data as runtime data; six mechanisms deleted |
| 7 | ran (**SERIOUS**, 5) | not re-run | 5 | Remnants of three superseded designs still present → **clean rewrite**; `src/data` wrong for compiled code → `dist/data` |
| 8 | ran (MINOR, 4) | not re-run | 3 | Build ordering; one shared parser; TS-direct mode |
| 9 | ran (MINOR, 5) | not re-run | 5 | Publish-lifecycle gap; `files` overclaim softened; **count rationale technically wrong**; TS-direct checked not asserted |
| 10 | ran (MINOR, 5) | not re-run | 2 material + 3 refinements | Typed resolver contract; count made diagnostic-only; lifecycle invariant asserted |

Rounds 4, 5 and 7 landed on SERIOUS. In each case the cause was the same: I was applying findings by
patching individual sections, so the document accumulated contradictions between superseded designs.
Round 7 named it and the spec was rewritten clean.

## What the process actually caught (the reason this is worth its cost)

1. **A wrong root cause**, believed confidently, with 8 passing tests behind it.
2. **A fix that was inert** on every machine but the author's — and a green suite that proved nothing
   because it ran in the wrong environment.
3. **Six mechanisms** that existed only because of one bad early choice.
4. **A safety floor that would not have caught the actual bug** (refusing zero articles when the real
   defect was 22 well-formed ones).
5. **A fallback that would have restored the exact behaviour being removed.**
6. **A check on a symbol instead of the state** — asserting the packing list rather than the package —
   inside a spec whose parent principle is "Verify the State, Not Its Symbol".
7. **A technically confused justification** (claiming the article count catches a truncation that
   hashes identically — not a real SHA-256 failure mode).
8. **An assertion about developer workflows** that I had not checked, and which turned out true only
   by luck.

Twice, the finding was something **my own written memory note already said** — once for the
unpublished `docs/` directory, once for anchoring to a published data directory. I had both notes and
walked past both. That is this spec's own §12 argument: a lesson in memory is not a mechanism.

## Full Findings Catalog

Every round's findings and their resolutions are recorded inline in the spec, attributed by round
number (e.g. "round-7 finding 2"), including the ones that overturned earlier decisions and the ones
that deleted whole sections. §2 preserves the three wrong turns in full rather than tidying them
away, and §10's alternatives table records each rejected option with the argument against it.

## What is needed from the operator

Three options, and this is a genuine decision rather than a formality:

1. **Accept the cap verdict and approve anyway** — the architecture is sound per the final external
   read, and the remaining findings have all been applied. Applying `approved: true` would let the
   build proceed on a spec that never earned a clean round. That is your call to make knowingly,
   which is exactly what the cap exists to force.
2. **Authorise a retry** — run further rounds. The trend suggests continued precision findings rather
   than design changes, so this may not terminate cheaply.
3. **Split it** — the resolver + generator is the load-bearing half and is now precisely specified;
   the packaging-lifecycle invariants and the lint are separable. Converging a smaller surface is
   likelier to reach a genuinely clean round.

No tag has been written. `/instar-dev` will refuse to build from this spec until both
`review-convergence` and `approved: true` are present, which is the correct state.
