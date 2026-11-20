# Side-Effects Review — metered key confinement (Gemini pay-per-use lane, slice A)

**Version / slug:** `gemini-payg-key-confinement`
**Date:** `2026-11-20`
**Author:** `Echo (build lane echo-gemini-payg-build)`
**Spec:** `docs/specs/gemini-payg-metered-lane.md` §4.1, §4.2, §4.4, §4.5, §4.6, FD-G9, FD-G27 (approved 2026-11-20, PR #3564)
**Tier:** 2 (secrets; fleet-wide script change). Size: 6 source/script files + 2 tests, ~450 LOC.
**Second-pass reviewer:** see the end of this file.

## Summary of the change

Slice A of Run 1: the fence that keeps pay-per-use provider keys where they belong, shipped before any paid call exists.

1. `src/core/meteredSecrets.ts` (new): the single list of metered vault names (`gemini_api_key_payg` plus the three bench keys found in the vault on 2026-11-20) and the reserved `metered_` prefix, with fail-closed send/receive predicates.
2. `filterSecretsForSync` takes `{ recipientMachineId, designation }`; `SecretProvisioner.provisionAll` now filters **per peer inside its loop**. A metered key goes only to the door's designated machine. With no designation (today, everywhere) or a pending transfer, it goes to no peer.
3. `SecretShareHandler` strips and counts metered names that arrive at a machine that is not the designated spender (an older sender syncs the whole vault). Unknown designation → strip. Logs carry a count, never a name or value.
4. `secret-get.mjs` refuses metered names at the top of the script (exit 3, `refused: metered key — readable only by its door`), before vault resolution and the plain-config fallback, in every branch including `--run`. The literal list is pinned to `METERED_SECRET_NAMES` by a template-drift test. The script is already always-overwritten on update.
5. `buildProviderEnvFlags('google', {kind:'api-key'})` now throws instead of emitting `GOOGLE_API_KEY` (no production caller; mirrors the openai refusal).
6. `scripts/lint-metered-secret-readers.js` (new, in `npm run lint`): fails on a NAMED read of a metered key (vault `.get`, secret helpers, `secret-get.mjs <name>`, `process.env.<name>`) outside the future one reader. Labels (keyRefs, refusal lists) are not reads.
7. A value-based child-env canary across the five frameworks' headless adapter env builders. It does not cover the interactive tmux session launch env; that holds because the door never puts the key in `process.env` (the key is read only inside `withKey`, a later slice).

**FD-G27 (bench spend outside the gate).** The paid reader behind the ~$48 bench spend is the scheduled `security-review` job ("Instar security review (multi-model)", topic 141385). Its prompt ran `GEMINI_API_KEY=$(node .instar/scripts/secret-get.mjs metered_gemini_bench) gemini -m gemini-4-argon -p …`, putting the key straight into a CLI env. Evidence: a pool session listing on 2026-11-18 21:25 UTC (tmux `echo-job-security-review-mwmmkba8`, on the Studio's old identity `m_03b30f5b…`). The job is not in any reachable machine's job list today (the Studio's home was re-paired as `m_9a4a7b73…`). This release **stops** that path (spec: "moves it … or stops it. Exempting it is never an option"): the recipe now gets exit 3 and an empty key, the CLI has no Gemini sign-in, and the job's own Step 1 rule reports Gemini as unreachable instead of failing. No reader of `metered_openrouter_bench` or `metered_groq_bench` was found (transcript search on the Mama PC, both job lists, the instar source).

## Decision-point inventory

- `filterSecretsForSync` / `SecretShareHandler`: new deterministic drop/strip of metered names — refusal-only, the safe direction.
- `secret-get.mjs`: new refusal for metered names.
- `buildProviderEnvFlags` google api-key: emit → refuse.
- `lint-metered-secret-readers`: build-time refusal of a named read.

## 1. Over-block

- Any session that legitimately printed a metered key loses that ability. The only such use found is the security-review recipe above, which is the spend FD-G27 exists to stop. Its Gemini voice is unreachable until the lane is live; the job's prompt already reports a missing family.
- The `metered_` prefix covers every future vault name with that prefix. A non-metered secret deliberately named `metered_…` would be refused; the prefix is reserved for this purpose and documented in the list module.
- The lint could flag a test fixture or doc string that looks like a read; tests (`*.test.ts`) are excluded, and labels do not match the patterns.

## 2. Under-block

- Any process running as the agent's OS user can still decrypt the vault directly (stated honest limit, spec §4.2). This closes the realistic paths: a session printing or exporting the key, and the sync fan-out.
- Copies already synced to peers before this release stay where they are: the receive strip never deletes, by the existing "a receive refusal never deletes anything" rule. The production key is minted only after this ships (FD-G26), so it was never sendable.
- The lint matches named reads only; whole-vault consumers enumerate every key (pinned to names/ciphertext by a test).

## 3. Level-of-abstraction fit

Each fence sits at the one chokepoint for its path: the sync filter is the only outbound path, the share handler the only inbound one, `secret-get` the only session read path, and the env builders the only child-env construction. The list lives in one module every fence imports (secret-get keeps a pinned literal because it runs without the TypeScript build).

## 4. Signal vs authority compliance

Blocking authority here is the secrets ruled exception (master Rule 86; spec D5): an exact name-membership test whose miss — a leaked paid key — cannot be recalled. No heuristic, no pattern guessing on values.

## 4b. Judgment-point check

No competing-signals decision: exact membership in a fixed list plus a reserved prefix.

## 5. Interactions

- `provisionAll` previously skipped everything when the filtered set was empty; it now skips per peer, so a peer whose filtered set is empty gets no command (no empty batch, no result row).
- The receive strip runs after the existing local-only refusal and Secret Drop strip, so a refused namespace still refuses the whole batch first.
- `metered_*` caps/keyRef labels in `routingSpendView`, `llmBenchCoverage` and the PostUpdateMigrator awareness text are untouched; they are labels.

## 6. External surfaces

- A new script exit code (3) and message for metered names.
- `buildProviderEnvFlags('google', api-key)` throws (no production caller).
- New lint in `npm run lint`.
- Feature-evidence context for secret sync gains `droppedMetered` (a count).

## 7. Multi-machine posture

Replicated code; the fences are per-machine by design and together implement the spec's "metered key machine-local to the designated machine" posture (`machine-local-justification: physical-credential-locality`). The designation source is wired in a later slice; until then every machine drops metered keys for every peer, the fail-closed state the spec requires before go-live.

## 8. Rollback cost

A revert restores whole-vault sync and printable metered keys; no data migration and no state written. Nothing to repair.

## Second-pass review

(appended below by the independent reviewer)

### Reviewer verdict (independent subagent)

Concur with the review. I checked the code myself, not just the artifact. The 9 related unit test files pass (95 tests), and the new lint is clean on the current repo.

Checked and found sound:
- **secret-get.mjs:** the refusal runs right after argument parsing, before the vault, `--names`, the plain-config fallback and `--run`. A key given after `--` is never the keyPath (positional args come only from before `--`), so it exits 2. A leading dot (`.gemini_api_key_payg`) or a different case gets past the refusal but matches no vault leaf and no config path, so no value prints. `--names` and the not-found listing show names and lengths only.
- **Sync:** `buildSecretShareCommand` in `provisionAll` is the only whole-vault outbound path I found. I grepped every `encryptForSync` caller (pairing, job bundles, identity handover, live-tail). None of them carries vault contents, and there is no pull-on-miss handler. In `server.ts` neither the provisioner nor the inbound handler is given `meteredDesignation` or `selfMachineId`, so metered keys go to no peer and are stripped on every receiver. That is the fail-closed state §7 describes.
- **Receive strip:** it checks the first dot segment of each top-level key before `store.set`, so it cannot be bypassed by nesting.
- **provisionAll shape change:** the `/secrets/sync-now` route and the boot push only count or ignore the result, so returning per-peer rows changes nothing for them.
- **Signal vs authority:** an exact name or reserved-prefix match on a key that cannot be recalled once leaked fits the secrets ruled exception.

Minor notes (none blocking):
1. `scripts/lint-metered-secret-readers.js` matches quoted literals only. A read through the exported constant, such as `store.get(GEMINI_PAYG_SECRET_NAME)`, is not flagged. That is the most likely way a real future misuse would be written. Consider adding the constant identifiers (`GEMINI_PAYG_SECRET_NAME`, `METERED_SECRET_NAMES`) to `NAME`, or flagging any import of `meteredSecrets.ts` outside the allowlist.
2. The child-env canary covers the headless adapter env builders only, not the interactive tmux session launch env. It holds today because the door never puts the key in `process.env`. The artifact should not suggest the canary covers every child process.
3. When the designation is wired in a later slice, both server.ts construction sites must get both deps. If the handler misses `selfMachineId`, the designated machine silently strips its own key. Give that wiring its own test.
4. Copies of the bench keys already synced to peers stay in their vaults (under-block section). They can no longer be printed on updated machines, but a peer still on an older build can still print them until it updates.

### Folded after review
- Note 1: the lint now also flags reads through `GEMINI_PAYG_SECRET_NAME` / `METERED_SECRET_NAMES[...]` (tests added).
- Note 2: canary scope stated precisely in the summary.
- Note 3: carried into slice D's plan — both server.ts construction sites get `meteredDesignation` and `selfMachineId`, with a wiring test that the designated machine keeps its own key.
- Note 4: accepted; an older peer can still print a bench key it already holds until it updates.
