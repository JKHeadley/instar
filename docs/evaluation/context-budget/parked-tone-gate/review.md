# Tone-gate submission receipt review

## Cross-model review ran

GPT-6.2 Astra completed all three independent passes through the Codex CLI. Six Claude Sonnet perspectives reviewed each round. The first lessons-aware response was unusable and was retried successfully against its frozen input. Gemini was detected as unauthenticated. The optional Anthropic clean-door pass was disabled by config. Round snapshots, complete reviewer outputs and the conformance responses are in this directory.

## Overview

The benchmark needs a receipt for the exact bytes the tone gate hands to Codex. The first implementation is now a synthetic test of the existing transport, using a local fake child. The receipt distinguishes a writable completion signal from evidence of what any model saw. Live traffic and production storage are outside the current implementation scope.

## Iteration summary

| Round | Standards conformance | Design findings and changes |
| --- | --- | --- |
| 1 | Ran, 102 standards and 6 flags | Bound source provenance and verdict selection to attempts, moved scanning and persistence off the dispatch path, reserved memory before copying, and limited implementation to synthetic custody. |
| 2 | Ran, 102 standards and 3 flags | Used the existing spawn injection seam with production source unchanged, gated replay on a sealed snapshot, pinned the scorer control, specified failure eligibility, and clarified expiry and ownership checks. |
| 3 | Ran, 102 standards and 0 flags | Review still found cross-attempt attribution, file substitution and error parity concerns. The post-round draft binds selected attempts to full receipt digests, rejects duplicate IDs from distinct dispatches, and adds error parity, late-error and cleanup checks. These edits have not been independently reviewed. |

## Proportion

Small synthetic pilot. Used all three rounds allowed by the spec-converge skill for a small change. The separate research fixture and adjacent scorer tests passed 73 checks during review. Those tests predate the proposed integration harness and do not verify it.

## Verdict

Convergence failed at the small-spec cap with receipt integrity and cleanup findings in the last reviewed snapshot. No convergence or approval tag was written. The working draft incorporates proposed fixes and needs another independent round before scope or caps are treated as approved. Production custody and source authorization remain separate prerequisites.

## Authorized additional round

The Chief of Staff authorized exactly one extra independent round as operator delegate in handoff 0dd69aba-ea37-4328-8be4-fecfcb2e55fa. The synthetic-only draft snapshot has SHA-256 9934224b9d6fd6e65f5b59317329baf8b9fbc0a57a910745582dc6423b28d31e. Six Claude Sonnet perspectives and GPT-6.2 Astra returned results. Standards conformance ran across 102 standards with two advisory flags about the fixture count limits. The reviewer outputs and frozen spec are in this directory.

The independent pass accepted the direction of dispatch identity and full-file binding, and raised three material findings:

- A selected receipt can already be committed when a late stdin error arrives. The sealed index needs to bind eligibility decided after drain, alongside the digest. Test that a valid diagnostic receipt remains ineligible for replay.
- The cap must be checked against UTF-8 byte length before allocating an encoded copy. Test a prompt whose string length fits but encoded length does not, while forwarding every byte to the fake child.
- Define storage, replay eligibility, and reservation release for a successful write with no verdict, separately from the whole-receipt drop for an excluded verdict.

Internal reviews also flagged fail-safe observer attachment and error propagation under the wrapper. The complete findings remain available in the round-four outputs.

Final disposition is parked under the delegate's instruction. No approval or convergence tag, live configuration, production source change or implementation. Leave the round-four spec unchanged as the reviewed snapshot.
