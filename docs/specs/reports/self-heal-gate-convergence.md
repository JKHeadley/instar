# Convergence Report — SelfHealGate

## Cross-model review: codex-cli:gpt-5.5

Real GPT-tier and Gemini-tier external reviews ran against every changed reviewable body. Both returned real opinions in the final round. The live Standards-Conformance endpoint was attempted in every round but returned HTTP 400 with an empty body from the configured server checkout, so it is recorded as unavailable rather than silently treated as a pass.

## ELI10 Overview

Instar already has one system that measures whether self-started actions are getting out of hand, and another small object that remembers whether a failure episode has already been reported. What it lacks is one safe way for a feature to say, “Here is the repair I want to try, here are its limits, and here is when a person must be told.” SelfHealGate supplies that narrow contract without building another retry engine.

The first real user is a current warning-only feedback-factory repair. A development checkout with missing or stale generated defaults can repair that one local file, ask the existing supervisor to restart once, and verify the result on the next boot. Uncertain, malformed, unreadable, or unsafe filesystem state is not overwritten; it tells the operator immediately.

## Original vs Converged

The preserved draft made four foundational claims that source did not support: it described governor state as pool-shared durability, treated observe mode like a hard brake, equated governor admissions with per-episode repair attempts, and deferred the first real application. The converged design corrects all four.

Review then found deeper safety gaps. The final contract consumes the governor's real protected-sink token, atomically claims every episode transition, distinguishes typed filesystem severities, hardens the repair target against symlink/temp-file attacks, carries crash-safe reason-specific notice handoff, preserves canonical governor queue/policy semantics, and verifies restart on a genuinely different boot through a stable `required -> requested -> verified` handshake.

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec changes |
|---|---|---:|---|
| 1 | security, adversarial, GPT, Gemini | 6 | Added token consumption, transactional attempt claim, typed inspection, hardened mutation, notice ordering/dedupe, and fresh ownership fencing. |
| 2 | security, scalability, integration, decision-completeness, lessons-aware, GPT | 6 | Switched durable state to SQLite CAS, made all transitions revision-safe, defined governor queue continuation and canonical relief policy, aligned two-boot restart lifecycle. |
| 3 | GPT, internal panel | 6 | Fixed attempt-accounting order, split latency notice from terminal exhaustion, removed stale JSON language, clarified boot ordering, authority modes, and sync scope. |
| 4 | internal panel | 1 | Added explicit `pending-restart` outcome and healthy boot-two marker eligibility. |
| 5 | internal panel | 1 | Added boot incarnation and crash-safe stable restart request handshake. |
| 6 | six-perspective internal panel, GPT, Gemini | 0 | Converged; only non-material clarity notes were folded (v1 API narrowing, explicit outbox marker, fixed local key, elapsed telemetry). |

## Full Findings Catalog

### Foundation corrections

- Governor `resource: pool-shared` does not make its snapshot or admission globally durable; v1 now rejects pool-shared gate declarations.
- Observe mode always proceeds and is preserved exactly.
- Episode remediation attempts have separate persisted authority from governor admission windows.
- Feedback generated-defaults repair ships in this change as the real first consumer.

### Security and adversarial

- Direct remediation after minting a token bypassed the governor's consume-once sink authority. Resolution: consume the exact controller/target token and honor `proceed` semantics.
- Persist-before-side-effect was not concurrency-safe. Resolution: SQLite `BEGIN IMMEDIATE`, revisions, CAS on every transition, and monotonic terminal state.
- Catch-all inspection could overwrite malformed/unreadable/symlink state. Resolution: typed inspection and unknown-severity immediate notice/no repair.
- Existing file writing was not hardened against symlink and predictable-temp attacks. Resolution: anchored/no-follow exclusive temp, restrictive mode, fsync/rename, cleanup, and verification.
- Notice claim before enqueue could permanently lose a notice on crash. Resolution: stable-id `absent -> pending -> enqueued` transactional-outbox marker with retry.
- Ownership could change between detection and mutation. Resolution: eligibility/epoch checks at admission, token boundary, and transactional claim.

### Integration and lifecycle

- Governor enforce queues would otherwise discard later admission. Resolution: existing `onAdmitted` callback resumes only the bounded post-admission path; restart falls back to normal boot detection.
- Proposed relief/open-coalesce policy contradicted canonical taxonomy. Resolution: canonical hardware-bound relief/open-audited policy.
- Generated defaults require one restart/recheck, but the draft claimed current-process activation. Resolution: post-owner repair, existing restart authority, and next-boot verification.
- `healed: boolean` could not represent pending restart. Resolution: closed `healed | pending-restart | not-healed` outcome.
- Same-boot calls could falsely verify restart, and a crash could strand the request. Resolution: durable boot ID plus stable `required -> requested -> verified` handshake.

### Scalability and state

- Store capacity cannot evict active state and refill an attempt budget. Resolution: 256-row cap, only safely expired recovered rows prunable, otherwise fail safe.
- Every competing mutation—not only attempt claim—must be revision-safe. Resolution: CAS/transaction on detection, notices, attempts, results, recovery, exhaustion, restart, and prune.
- Local state was initially overclaimed as unified. Resolution: explicit hardware-local first consumer; future pool-wide authority is prose-only and requires separate convergence.

### Decision-completeness and lessons-aware

- All non-cheap choices are frontloaded; open questions are empty.
- The façade composes existing governor/latch authority rather than growing a second engine.
- The current first application is built now instead of being deferred.
- External reviewer clarity notes led to the authority table, terminology section, alternatives section, explicit outbox naming, fixed non-path dedupe identity, and sync-I/O telemetry.

## Convergence verdict

Converged at iteration 6. The final six-perspective internal pass reported zero material issues, and both external model families returned only non-material clarity observations. The spec is ready for the pre-approved build.
