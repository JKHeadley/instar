# Side-Effects Review - Commitments guidance payload migration

**Version / slug:** `commitments-guidance-payload-migration`
**Date:** `2026-07-27`
**Author:** `instar-codey`
**Second-pass reviewer:** `not required`
**Tier:** 1 (small migration parity bugfix; ELI16 + side-effects, no converged spec)
**Parent principle:** Migration Parity / Commitments & Follow-Through - deployed agents must receive corrected instructions, not only new installs.

## Summary of the change

Existing agent `CLAUDE.md` files could contain a stale `/commitments` curl payload:

```text
-d '{"userRequest":"<what you promised>","type":"follow-up","topicId":TOPIC_ID}'
```

That payload is rejected by `POST /commitments` because `agentResponse` is required and `follow-up` is not an accepted commitment type. The shipped template already emits the accepted body. This change adds the missing `PostUpdateMigrator.migrateClaudeMd` in-place rewrite so already-installed agents get the corrected instruction on update.

## What changed

- `src/core/PostUpdateMigrator.ts` now rewrites only the exact stale commitments payload to the accepted `agentResponse` + `one-time-action` payload.
- `tests/unit/PostUpdateMigrator-commitmentsGuidancePayload.test.ts` covers an already-installed Commitments section with the old payload, proves the migration is idempotent, and includes a negative control proving customized guidance without the exact stale payload is byte-preserved with no upgrade recorded.
- The existing `tests/unit/commitments-agent-guidance-contract.test.ts` remains the source-string guard against re-documenting the rejected type in shipped guidance.

## Decision-point inventory

- API compatibility: keep `POST /commitments` strict. The doc was wrong; the API contract is correct.
- Migration shape: rewrite the exact stale payload in place instead of appending a duplicate Commitments section.
- Scope: fix only the confirmed stale commitments payload. The drift grep did not show another commitments-body drift requiring scope expansion.

## 1. Over-block

No block/allow surface - over-block is not applicable. The closest over-correction risk is documentation mutation: the migration only matches the exact stale `-d` payload. It does not rewrite arbitrary commitment examples, user prose, or already-correct docs. If an agent customized the section without that exact stale string, the migration leaves it alone.

## 2. Under-block

No block/allow surface - under-block is not applicable. The closest under-correction risk is a differently-mutated local doc remaining stale. The migration key is the exact stale line reported and reproduced; broad fuzzy rewriting would risk damaging custom instructions. The test covers the known deployed shape.

## 3. Level-of-abstraction fit

Correct layer: `migrateClaudeMd` is the established migration parity path for awareness/doc changes in existing agents. The fresh template was already fixed, so changing `src/scaffold/templates.ts` again would not reach already-installed files.

## 4. Signal vs authority compliance

Required reference: `docs/signal-vs-authority.md`.

No block/allow surface. No judgment or heuristic authority is introduced. The migration is deterministic string replacement. The route continues to enforce the live commitment contract.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. This is an exact literal migration for an already-confirmed stale doc payload, not a runtime decision over competing live signals.

## 5. Interactions with existing primitives

- `CommitmentTracker` and `PromiseBeacon` are unchanged.
- `POST /commitments` validation remains strict: `type`, `userRequest`, and `agentResponse` required; type must be `config-change`, `behavioral`, or `one-time-action`.
- The migration composes with the existing additive Commitments section migration: missing sections are still added; present-but-stale sections are now corrected.

No shadowing, double-fire, race, or feedback loop is introduced. The only write is the existing migrator's local file write.

## 6. External surfaces

No external API behavior changes. No new routes, no new config, no new network calls, no new messages, and no automatic commitment creation. The only user-visible effect is that an agent's local guidance now contains a working curl example after update.

## 6b. Operator-surface quality

No operator surface - not applicable. The change does not touch dashboard renderers, approval pages, grants, revokes, or forms.

## 7. Multi-machine posture

Machine-local by design for the physical edit, because each agent has its own installed `CLAUDE.md` on disk and `PostUpdateMigrator` runs locally during that agent's update. The behavior is fleet-wide by release distribution: every machine that installs the fixed package runs the same local migration. It emits no user-facing notices, holds no durable runtime state, and generates no URLs, so there is no one-voice gating, topic-transfer, or link-survival issue.

## 8. Rollback cost

Trivial. Remove the migration block and the regression test. Docs already corrected by a released migration would remain corrected, which is the safe state. No persistent runtime state is changed.

## Migration parity

- New agents: already receive the accepted payload from `src/scaffold/templates.ts`.
- Existing agents: now receive an in-place rewrite on update when their installed `CLAUDE.md` contains the stale payload.
- Idempotency: proved by running the migration twice and asserting the second pass changes nothing.
- Customization preservation: proved by feeding a locally customized commitments curl that does not contain the exact stale payload and asserting byte-identical output plus no commitments-guidance upgrade record.

## Drift grep

I grepped the installed agent docs, the fresh template, and the migrator source for the stale commitments payload and accepted fields. The installed docs and template already contain `agentResponse` and `one-time-action`; only the new migration test fixture contains the literal rejected `follow-up` payload. I also checked the live `POST /commitments` route contract and the adjacent deployed-agent curl examples; no additional commitments-body drift showed up, so scope stayed narrow.

## Tests

- Failing-before proof: `npx vitest run tests/unit/PostUpdateMigrator-commitmentsGuidancePayload.test.ts` failed against `origin/main` plus this test file and without the migrator change.
- Passing after fix: `npx vitest run tests/unit/PostUpdateMigrator-commitmentsGuidancePayload.test.ts tests/unit/commitments-agent-guidance-contract.test.ts`.
- Touched suite: `npx vitest run tests/unit/PostUpdateMigrator-commitmentsGuidancePayload.test.ts tests/unit/commitments-agent-guidance-contract.test.ts tests/unit/commitment-routes.test.ts`.
- Lint: `npm run lint`.

## Conclusion

Clear to ship as a Tier 1 migration parity repair with audited risk-floor override. The live contract stays strict; deployed docs catch up to the contract; idempotency and source-string guards cover recurrence.

## Second-pass review

Not required. This touches migration machinery, but not outbound/inbound message block/allow, dispatch, session lifecycle, context exhaustion, compaction, coherence gates, trust decisions, or a sentinel/guard/gate/watchdog authority.

## Evidence pointers

- `tests/unit/PostUpdateMigrator-commitmentsGuidancePayload.test.ts`
- `tests/unit/commitments-agent-guidance-contract.test.ts`
- `tests/unit/commitment-routes.test.ts`

## Class-Closure Declaration (display-only mirror)

This fixes an agent-authored-artifact defect: installed agent guidance contained a stale rejected command.

- `defectClass`: `novel` (nearest existing class: migration parity/documentation drift)
- `closure`: `guard`
- `guardEvidence`: `ratchet` - `tests/unit/PostUpdateMigrator-commitmentsGuidancePayload.test.ts` drives the stale installed payload through `migrateClaudeMd` and asserts the accepted body appears; `tests/unit/commitments-agent-guidance-contract.test.ts` guards the source template/migrator guidance against documenting the rejected type again.
