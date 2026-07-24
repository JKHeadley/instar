# Side-Effects Review — Throughput GitHub runtime repair

**Version / slug:** `throughput-github-runtime-repair`
**Date:** `2026-07-24`
**Author:** `instar-codey`
**Second-pass reviewer:** `Aquinas (review_security_identity)`

## Summary of the change

The Throughput route moves from a bare GitHub CLI subprocess to authenticated
GraphQL, while `src/core/githubRuntime.ts` becomes the shared explicit-token,
absolute-executable boundary for the CI poller and Green-PR watcher. The same
runtime environment is threaded through the real `safe-merge` child. Search
cardinality and Pacific timezone correctness are made explicit invariants.

## Decision-point inventory

- `buildThroughputSeries` identity resolution — **modify** — only environment or
  agent-vault identity is accepted.
- Throughput Search pagination — **modify** — reported and fetched counts must agree
  and remain at or below the provider ceiling.
- `resolveGhExecutable` — **add** — only known absolute, executable files qualify.
- `DefaultMergeRunner` process admission — **modify** — explicit GitHub runtime is
  required before contract probing or actuation.
- `CiFailurePoller` GitHub read — **modify** — uses the shared cached runtime.

---

## 1. Over-block

A legitimate install with a working machine-global `gh auth login` but no
`GITHUB_TOKEN` and no vault `github_token` is now refused. This is intentional:
the ambient login cannot prove agent identity. A 30-day window with more than 1,000
merged PRs is also refused rather than partially charted; a different data source
would be needed to support that volume honestly.

## 2. Under-block

An explicit token can still belong to the wrong GitHub principal if the operator
stores the wrong value. This layer proves explicit selection, not semantic
ownership. GitHub may also change its GraphQL schema or Search ceiling; those
changes fail the route closed through schema/count validation rather than render
incorrect data.

## 3. Level-of-abstraction fit

Identity and executable selection are centralized at the server process boundary,
below all three consumers. Throughput uses the higher-level GraphQL interface
because it needs structured read data, while the two legacy CLI consumers reuse the
lower-level runtime primitive. The existing `safe-merge` authority continues to own
merge judgment and execution; this change does not create a parallel merge gate.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [ ] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context (LLM-backed with recent history or equivalent).
- [x] Yes, with deterministic structural invariants — explicit identity,
  executable-file status, and complete provider cardinality are enumerable safety
  floors, not brittle proxies for intent.

The new refusals answer structural questions with exact evidence. They do not infer
user intent or choose among competing live signals. Green-PR judgment remains with
the existing eligibility ladder and `safe-merge`.

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic is added at a competing-signals decision point. Token
presence, executable path shape, HTTP/schema validity, Search cardinality, and
timezone conversion are hard invariants with enumerable outcomes.

## 5. Interactions

- **Shadowing:** explicit-runtime admission runs before GitHub reads or merge
  contract probing. It intentionally shadows ambient CLI identity; later safety
  checks run unchanged once admission succeeds.
- **Double-fire:** no new scheduler or action is added. The Green-PR watcher and CI
  poller retain their existing cadence and lease gates.
- **Races:** the five-minute cache is process-local. A token rotation can coexist
  with the old value until the TTL expires; GitHub rejects a revoked value, and no
  caller falls back to ambient auth.
- **Feedback loops:** Throughput is read-only. CI writes the existing failure ledger
  and Green-PR retains the existing act path; this change adds no feedback edge.

## 6. External surfaces

GitHub receives direct GraphQL requests from Throughput with an explicit bearer
identity. The route's unauthenticated failure is now specifically
`github-auth-unavailable`; other failures retain the generic unavailable response.
No secret value is logged or returned. There is no new database, file format, URL,
notification, or operator action. Existing installs must supply `GITHUB_TOKEN` or
the vault secret for live data.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No dashboard renderer, form, or operator action is changed. The existing Throughput
tab is verified separately after deployment at desktop and phone widths.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN:** executable location and server environment are
machine-specific security truths. Each fleet server independently requires its
agent-scoped explicit identity and resolves its own executable. The output contract
is identical across machines; a misconfigured peer fails closed rather than
borrowing that host's global GitHub seat. No user-facing notices are emitted, no new
durable state can strand during topic transfer, and no URLs are generated.

## 8. Rollback cost

Pure code rollback: revert and ship a patch. No migration, state cleanup, or agent
reset is required. The rollback window restores the known Throughput 503 and ambient
CLI-identity hazard on affected machines, but does not corrupt data.

## Conclusion

The first review found that fixing only Throughput left the actual `safe-merge`
child outside the identity boundary. It also found Search truncation, repeated vault
resolution, relative-PATH acceptance, and fixed-offset day bucketing. All were
folded into this change with behavioral tests. The design is clear to ship subject
to the independent second-pass reread and green ceremony.

## Second-pass review (if required)

**Reviewer:** Aquinas (`review_security_identity`)
**Independent read of the artifact: concur**

Concur with the review: the shared runtime closes the prior identity and PATH
gaps through the real `safe-merge` act path, all three consumers fail safely, and
the cadence, lease, rollback, multi-machine, and self-action conclusions match the
final code and behavioral tests.

## Evidence pointers

- `tests/unit/github-runtime.test.ts`
- `tests/integration/throughput-github-auth.test.ts`
- `tests/unit/throughput-routes.test.ts`
- `tests/unit/green-pr-automerge-wiring.test.ts`
- `tests/unit/merge-runner.test.ts`
- `tests/unit/CiFailurePoller.test.ts`

## Class-Closure Declaration (display-only mirror)

`defectClass: unbounded-self-action`, `closure: guard`,
`guardEvidence: { enforcementType: ratchet, citation:
tests/unit/self-action-convergence.test.ts, howCaught: the touched CI and Green-PR
controllers retain lease/cadence admission and no new trigger edge; missing identity
settles each tick to a bounded no-action refusal, while the existing convergence
ratchet detects a controller whose steady-state action can grow without a settling
brake }`.

The production incident is an ordinary runtime identity defect, not an
agent-authored prompt/config/skill defect. The declaration is present because this
repair modifies existing self-triggered controllers.
