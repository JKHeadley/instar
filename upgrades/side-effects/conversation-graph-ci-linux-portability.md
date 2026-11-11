# Side-effects: held-file identity includes the change time; two exported types are written out

## Summary

Two source changes, both found by the first GitHub Actions run of PR #3013 (Ubuntu, ext4, pnpm-style type layout):

1. **Held-file identity.** The held-original rebind proof (`openHeldOriginalRow` → `assertCurrent`) and the held stage proof (`finalizeHeldOriginalStage` → `assertCurrent`) decided "same file" from `dev` + `ino` only. On ext4 a file that is deleted and created again usually gets the same inode number straight away (measured on Mama PC WSL ext4: unlink then create reused the inode; tmpfs and APFS did not). So a replaced held file passed the identity check on Linux. `tests/integration/graph-source-held-promotion.test.ts` caught it: it deletes and recreates the held catalog with the same bytes and expects the proof to refuse, which it did on macOS and not on CI. The code was wrong, not the test. Both proofs now also record the file's change time (`ctimeNs`, from a bigint `lstat`) when the proof is taken and refuse if it differs. A newly created file always has a new change time. This is the same identity the paged-history reader in the same file already uses (`dev:ino:size:mtimeNs:ctimeNs`). The change time is kept in a separate map, so the stage proof's existing hash (which includes the `files` rows) is unchanged.
2. **Declaration emit.** `createGraphWitnessServer` and `ConversationGraphDefault.router` had inferred types that TypeScript cannot name in a declaration file when `@types/express-serve-static-core` sits in a nested store path (TS2883 on CI). They now carry explicit types (`{ app: express.Express; service: GraphWitnessService }` and `Router`). No runtime change.

3. **CI integration job bound.** `.github/workflows/ci.yml` Integration Tests `timeout-minutes` 50 → 70, the E2E job's bound. Main's own run 42878286348 was cancelled at 50 minutes, and this release adds about 15 minutes of multi-machine graph suites; PR #3013's first run was cancelled at 50 minutes with 137 of 874 files left.

Decision point: change 1 tightens an existing refusal; it adds no new authority and no new path.

## 1. Over-block
Any metadata change to a held file while a proof is open (including an extended attribute written by a backup or indexing tool) now refuses the proof. A held file whose metadata changes in place (chmod, an in-place write, a hard-link count change) between taking the proof and checking it is now refused. Before, an in-place write was refused through the content checks and a chmod was not refused. No code path changes the metadata of held files while a proof is open; the 21 held-row and stage tests (`graph-source-held-promotion`, `graph-source-promoted-transfer-bridge`, `graph-source-sender-promotion`) and five more held-path suites pass on macOS. A refused proof is reopened by the caller, as after any other change.

## 2. Under-block
None added. On Linux this closes the gap where a replaced file with a reused inode number passed. Other `dev`/`ino`-only checks in the same file (held session files, sender stage files, adopted files) are unchanged in this commit; they also compare content hashes, so a reused inode with different bytes is still refused there.

## 3. Level-of-abstraction fit
The change sits in the two identity checks that the failing test exercises, in the module that owns them.

## 4. Signal vs authority compliance
Follows `docs/signal-vs-authority.md`: the same check keeps the same authority; it now has one more field to compare.

## 5. Interactions
None with other proofs; the change time is captured and compared inside each proof only.

## 6. External surfaces
No wire, page, file format or API change. The declaration files (`dist/*.d.ts`) now name the two types explicitly.

## 7. Multi-machine posture
Machine-local.

## 8. Rollback cost
Revert the commit. No state or format change.

## Class-Closure Declaration
Defect class: platform-dependent file identity. Closure: the two proofs the CI run exercised. The other `dev`/`ino` comparisons in `ConversationGraphReplication.ts` also hash the content, so a same-number replacement with different bytes is still refused there.

## Evidence
- CI run 42885633127 (Integration Tests, Unit Tests shards 3/4): `graph-source-held-promotion.test.ts:54` "expected [Function] to throw".
- Mama PC WSL: on ext4, unlink then create in the same folder reused the inode number; on tmpfs it did not.
- After the change, on macOS: `graph-source-held-promotion` 14/14, `graph-source-promoted-transfer-bridge` 2/2, `graph-source-sender-promotion` 5/5. An earlier draft that kept the change time inside the stage `files` rows broke those three suites (the rows are hashed, and bigint cannot be hashed). That is why the change time now sits in its own map.
- UX assertions job (CI run 42885633111): TS2883 at `src/server/graphWitnessServer.ts:6` and `src/server/ConversationGraphDefault.ts:66`.

## Second-pass review
See the **Reviewer:** paragraph in `upgrades/side-effects/conversation-graph-release-harness-review.md` dated 2026-11-10 for the CI-portability fixes.
