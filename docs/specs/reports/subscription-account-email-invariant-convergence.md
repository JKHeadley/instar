# Convergence Report — Subscription account email invariant and honest follow-me recovery

## Cross-model review: codex-cli:gpt-5.5

Real GPT-tier and Gemini-tier external reviews ran on the reviewable body. The
standards-conformance HTTP endpoint was also attempted, but the live server
correctly refused a spec path outside its configured checkout; that advisory
pass was unavailable for this isolated worktree and was not represented as a
successful constitutional result.

## ELI10 Overview

An account in the subscription pool must identify the provider account it
represents. Today the record can exist without its email, even though every
safe follow-me sign-in needs that email to make sure the new credential belongs
to the intended account. One malformed record therefore turns a correct login
into an unexplained failure.

The converged design makes email proof part of registration, repairs old
records from their own local credentials when possible, and quarantines gaps
that cannot be proved. It also names the real problem in API and dashboard
responses. Finally, repeated unchanged failures use a durable bounded retry
schedule and park instead of generating a request every minute forever.

The safety tradeoff is deliberate: the system may require an operator repair
when identity cannot be proved, but it never guesses an email or accepts a
credential without matching it to the intended account.

## Original vs Converged

The initial proposal required an email and added a simple retry counter. Review
turned both into authority-bearing designs:

- Caller-supplied email became a non-authoritative hint. A provider-specific
  oracle proves the slot tenant, with credential-epoch comparison preventing a
  credential swap between proof and commit.
- The write boundary became a complete-record commit owned by one registrar;
  generic pool mutation cannot create or clear identity.
- Existing malformed records became an explicit legacy/quarantine state with a
  bounded startup reconciliation barrier and a dedicated operator repair path.
- Peer data became corroboration only. It can reveal conflict but cannot
  substitute for local credential proof.
- The retry counter became a pair-scoped persisted state machine with one
  monotonic failure episode, semantic causal wakes, fixed-size evidence, and a
  finite outer wake budget.
- Exact API codes, messages, dashboard behavior, persistence ordering,
  multi-machine posture, rollback, maturation metrics, and controller
  registration tests were made explicit.

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec changes |
|-----------|-----------------------|-------------------|--------------|
| 1 | security, architecture, lessons, decision completeness, Codex, Gemini | 13 | Replaced caller authority with oracle proof; defined legacy quarantine, honest errors, and bounded retry ownership. |
| 2 | adversarial, scalability, multi-machine, Codex, Gemini | 9 | Added slot-epoch CAS, peer-conflict rules, persistence ordering, reconciliation barrier, and pair-scoped durable state. |
| 3 | architecture, decision completeness, Codex, Gemini | 7 | Retired raw email mutation, added module-private complete commit, formal transitions, causal wakes, and controller convergence. |
| 4 | adversarial, multi-machine, Codex, Gemini | 5 | Added authority expiry, evidence versions, outer wake cap, route classification, and repair action. |
| 5 | Codex, Gemini, internal decision review | 3 | Defined canonical comparison, exact running/degraded responses, duplicate registration semantics, and provider-risk migration. |
| 6 | Gemini | 0 | No behavior change. Three non-material maintainability/readability observations were catalogued. |

## Full Findings Catalog

### Identity authority and registration

- **Critical — security/adversarial:** A supplied email could become identity
  authority. **Resolution:** every path probes the provider oracle; supplied
  email is only a match-required hint.
- **Critical — architecture:** Generic `add`, `update`, or PATCH could bypass
  the invariant. **Resolution:** raw email mutation is retired and an
  oracle-owning registrar alone invokes the module-private complete commit.
- **High — adversarial:** Credentials could change after proof but before
  commit. **Resolution:** capture and CAS the credential ledger epoch, with one
  bounded re-probe and fail-closed second change.
- **High — multi-machine:** Peer consensus could launder stale or compromised
  identity. **Resolution:** peers only corroborate; local credential binding
  and oracle proof remain mandatory.
- **Medium — architecture:** Email comparison semantics were ambiguous.
  **Resolution:** one provider-scoped normalizer now defines display and
  comparison behavior without claiming mailbox alias equivalence.
- **Medium — compatibility:** Providers may later expose stable subjects.
  **Resolution:** adapters may record a subject; once available it becomes
  mandatory and existing email-only bindings require re-attestation.

### Legacy repair and persistence

- **High — compatibility:** Making the type required could hide malformed disk
  records. **Resolution:** persisted legacy records form an explicit union;
  complete accounts and `emailGaps` are separate read surfaces.
- **High — operational:** Startup repair could block or race all service
  traffic. **Resolution:** bounded concurrency and global deadlines apply;
  reads remain available while identity mutations cross an explicit barrier.
- **High — correctness:** Memory could advertise a repair that failed to
  persist. **Resolution:** write-before-memory/replication and typed persistence
  failures are required.
- **Medium — UX:** An unresolved repair had no safe mobile action.
  **Resolution:** a PIN-gated repair endpoint performs a fresh proof and the
  dashboard exposes its reconciliation state.

### Honest refusal surfaces

- **High — UX/safety:** All identity-resolution failures collapsed into a
  misleading generic 409. **Resolution:** missing, conflict, and not-found have
  stable codes and exact actionable text on enroll-start and matrix surfaces.
- **High — correctness:** First-peer-wins could conceal disagreement.
  **Resolution:** every valid holder must unanimously agree before resolution.
- **Medium — lifecycle:** A held login could be silently revived after repair.
  **Resolution:** held flows stay held; repair requires a fresh correctly bound
  sign-in.

### Retry and controller behavior

- **High — reliability:** The consumer retried the same refusal every minute
  forever. **Resolution:** attempts use 1m/5m/15m then park durably.
- **High — adversarial:** Alternating error classes or duplicate mandates could
  reset counters. **Resolution:** one pair-scoped episode counter has a
  monotonic lane and duplicate delivery cannot reset it.
- **High — lifecycle:** Arbitrary state/file hash churn could wake a parked
  episode. **Resolution:** identity wakes require a semantic unresolved-to-
  unanimous transition; other wakes require a changed set of valid,
  unexpired mandate IDs.
- **High — boundedness:** New evidence could still wake forever.
  **Resolution:** each evidence version wakes once and non-identity wakes have
  a maximum of three per rolling 24 hours.
- **Medium — architecture:** A parallel helper risked two retry authorities.
  **Resolution:** one `FollowMeConsumerController` owns start/stop; the old
  helper is removed or strictly delegated.

### Final external observations

- **Non-material — Gemini:** Single-writer ownership is a scaling dependency.
  The spec already refuses multi-writer topology until a durable lease or
  transaction exists and states the exact migration trigger; no present
  behavior change was required.
- **Non-material — Gemini:** A custom circuit-breaker adds maintenance cost.
  The alternatives section already evaluates generic libraries and records why
  domain-specific causal wakes and persisted pair evidence require a small
  explicit state machine; the implementation remains bounded and testable.
- **Non-material — Gemini:** Terminology is dense. The spec already opens with
  a reader model, supplies an ELI16 companion and glossary, and includes a
  concrete lifecycle example. No authority or acceptance criterion changed.

## Convergence verdict

Converged at iteration 6. The final round produced no material finding that
required a spec change, and `Open questions` contains no unresolved operator
decision. The spec is ready for approval and implementation.
