# Commitments Agent Contract Vocabulary

## Scope

Align generated agent guidance with the live `/commitments` API contract for one-time follow-up promises.

## Runtime Finding

Live verification showed the lifecycle works with the actual contract:

1. Create with `type:"one-time-action"`, `userRequest`, `agentResponse`, and `topicId` returns a `pending` commitment with the expected fields.
2. Direct lookup returns the same record.
3. Delivery transitions the commitment to `delivered`, sets `resolvedAt`, increments the version, and closes it from active follow-up.
4. PromiseBeacon delivery behavior is already covered by integration: delivered commitments stop scheduled beacon work and later fires are no-ops.

The rejected shape was the generated guidance: `type:"follow-up"` plus no `agentResponse`.

## Files

- `src/scaffold/templates.ts` — update new-agent Commitments guidance to use `one-time-action` and include `agentResponse`.
- `src/core/PostUpdateMigrator.ts` — update migrated Commitments guidance for existing agents.
- `src/data/builtin-manifest.json` — regenerated after template guidance changes.
- `tests/unit/PostUpdateMigrator-secretDropHardenedRetrieve.test.ts` — pin migrated guidance vocabulary.
- `tests/unit/commitments-agent-guidance-contract.test.ts` — pin template and migrator vocabulary together.
- `tests/unit/commitment-routes.test.ts` — cover the agent-facing create shape and deliver transition.
- `tests/e2e/commitments-api-lifecycle.test.ts` — cover create, lookup, deliver, lookup, and active-list closure through HTTP.
- `docs/specs/COMMITMENTS-AGENT-CONTRACT-VOCABULARY-SPEC.md` — durable contract note.
- `docs/specs/COMMITMENTS-AGENT-CONTRACT-VOCABULARY-SPEC.eli16.md` — plain-language overview.
- `upgrades/NEXT.md` — release-note entry for the next patch.

## Side Effects

Existing agents that receive migrated guidance will be taught the accepted route contract. Existing commitment records are not migrated and no stored status vocabulary changes.

The guidance still uses "open" as a human verb. The API status for a newly created one-time follow-up remains `pending`.

## Rollback

Revert the template/migrator and tests. Runtime commitment behavior is unchanged by this PR.
