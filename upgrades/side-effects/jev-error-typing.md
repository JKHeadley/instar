# Side-Effects Review — typed Jev failures on the shared gateway

**Version / slug:** `jev-error-typing`
**Date:** `2026-11-14`
**Author:** `Echo`
**Second-pass reviewer:** `not required (observability-only provenance fields; no gate, block, session or messaging decision changes)`

## Summary of the change

Tier 1 (2 files of runtime/test change, ~90 LOC; one review pass, first commit attempt). CMT-1678 / Jev plan priority 3. The catch around `askJev` in `src/core/JevFirstDecision.ts` discarded the error, so every `jev-error` provenance row (14 rows 11-08..11-14, commitment-detect 13/110 errors) had `jevMs: null` and no cause. The gateway now:

- measures elapsed time around `askJev` with the injected clock (`deps.now`, default `Date.now`) and writes `jevElapsedMs` on success and failure (`jevMs` from Jev's own answer is kept as is);
- classifies a thrown `askJev` error with the new exported `classifyJevFailure` into a fixed enum `jevFailureKind`: `timeout` (AbortError/TimeoutError), `http` (message exactly `^Jev HTTP (\d+)$`, number kept in `jevHttpStatus`), `invalid-body` (SyntaxError from JSON parsing, or a returned answer object that cannot be read), `transport` (anything else);
- never writes the error message text.

The `onJevCall` metrics hook is left alone: passing the kind would change its signature and the metrics consumer, which the brief rules out.

## Decision-point inventory

None changed. `handoffReason`, `reason`, the selected answer, the incumbent fallback and every stage/band/model are byte-for-byte the same decisions as before; the change only adds three fields to the recorded context.

## 1. Over-block

No issue identified: nothing is blocked or rejected; the added fields cannot change any decision.

## 2. Under-block

Classification is by error name/message shape. A transport that throws a differently-named abort (not AbortError/TimeoutError) would be counted as `transport`, not `timeout`; `jevElapsedMs` close to the point's `timeoutMs` still reveals it. An injected `askJev` other than `createJevAsk` that formats HTTP failures differently lands in `transport`. Both are visible in the data, not silent.

## 3. Level-of-abstraction fit

Right layer: the gateway is the single place every Jev-first point (commitment-detect, PromptGate) records its provenance row, so typing here covers all callers at once. The transport (`createJevAsk`) is unchanged; its error shapes are what the classifier reads.

## 4. Signal vs authority compliance

Pure signal. It adds evidence to an audit row and holds no authority (`docs/signal-vs-authority.md`).

## 5. Interactions

- `JudgmentProvenanceLog` stores the context object as-is; the new keys are small scalars, well inside the row budget, and contain no free text, so the scrubber has nothing new to scrub.
- `/jev-first/summary` reads `handoffReason` and is unaffected; it does not yet aggregate `jevFailureKind` (a later reader can).
- `now()` is called twice more per Jev call; tests that inject `now` (none of the existing suites do) see those reads.

## 6. External surfaces

Three new fields in local decision-provenance rows. No routes, config, messages or other agents affected.

## 7. Multi-machine posture

Machine-local by design: each machine writes its own provenance rows for the decisions it makes; the fields travel wherever those rows already travel.

## 8. Rollback cost

Revert the commit. Rows written meanwhile keep three extra fields that older readers ignore. No migration.
