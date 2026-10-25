# Side-Effects Review — local-verify verifier version no longer hashes an ambient TypeScript resolution

**Version / slug:** `verifier-version-no-ambient-typescript`
**Date:** `2026-10-24`
**Author:** Echo (instar-dev agent)
**Second-pass reviewer:** independent general-purpose subagent (Claude), see "Second-pass review"

## Summary of the change

Tier 1 (a narrow bug fix in one function; a revert fully undoes it). Size: 3 source/test files (`src/localVerify/verifierVersion.ts`, `tests/unit/localVerify/LocalVerifyService.test.ts`, a one-token stub in `tests/unit/localVerify/mergeLineWiring.test.ts`) plus 3 artifacts; about 50 lines changed. Effort: one review round, one commit attempt (stated for the proportion signal; nothing out of line).

Problem (found 2026-10-24): `computeVerifierVersion()` hashed `typescript:<version>`, where the version was read from `typescript/package.json` as resolved by Node's lookup from the installed verifier (`createRequire(<install dir>/noop.js)`). That lookup walks UP the parent chain from `.instar/shadow-install/node_modules/instar` and lands in the agent home's own `node_modules` (`/Users/dabombstudio/.instar/agents/echo/node_modules`), a mutable folder that an unrelated `npm ci` empties and refills. So the verifier version flipped between two values (`vh2:25b6e0cc…` with typescript 5.9.3 found, `vh2:da61a7a1…` with it absent) with the state of a folder that has nothing to do with the verifier, and every flip voided every pending local-verify record (`verifier-mismatch`), forcing PRs to re-test after each server restart. Reproduced with a throwaway script: identical files + policy + node, only `typescriptVersion` null vs `'5.9.3'`, produced exactly the two observed hashes.

Since PR #2326 (commit 1f1d3ae91) the skip ratchet resolves its parser from the run worktree `npm ci` just installed, so the parser is a property of the PR's tree, not of the verifier. The input had therefore stopped describing anything the verdict depends on, and was only a source of flips.

The change: the `typescript:` input is removed from the hash entirely (no `createRequire`, nothing ambient is read); the salt becomes `local-verify-verifier-v3` and the prefix `vh3:`, so every record written under `vh2` is distinguished cleanly once (it re-verifies, exactly as any input change does) and no `vh2` value can collide with a `vh3` value. The `typescriptVersion` test-override field is removed from `VerifierVersionInputs`. Tests: the existing hash tests now assert `vh3:` and drop the typescript-changes-it case; a new test builds a fake install under a fake agent home (`<home>/shadow-install/node_modules/instar`), plants `node_modules/typescript/package.json` two levels above the package root and inside it, with two different versions, and asserts the computed version never changes (this test fails against the old source at the first planted assertion, and passes with the fix).

## Decision-point inventory

- `verifier-mismatch` check (`runVerifyMain.ts` → `checkVerifierVersion`, and the boot-time record trust in `LocalVerifyService`) — pass-through — the equality check is untouched; only the set of inputs feeding the compared value shrinks by one input that was never a property of the verifier.

No decision point is added, removed or re-weighted.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

No block/allow surface of its own. The one effect in that direction: every record written under `vh2` is treated as a verifier change exactly once after the first server restart on this release (the same thing every earlier release did, by design, and the same thing the flip did on every restart). No legitimate record is rejected beyond that one-time re-verify.

---

## 2. Under-block

**What failure modes does this still miss?**

A change to the `typescript` version used by the skip ratchet no longer changes the verifier version. That is correct, not a miss: the ratchet loads the parser from the run worktree (`loadTypescript(fromDirs)`), so a PR that changes the pin is itself classified harness-changing by the toolchain rule in `policy`/`classify` (spec §"Harness-changing PRs": a lockfile or manifest change to `typescript` is on the list) and is verified with its own harness. The fallback resolution from the verifier's own install (no devDependencies) remains ambient and is the very thing this change stops hashing — it affects a run only when the worktree has no typescript, which the verify's `npm ci` makes impossible for a tree with the pin.

Still not covered (unchanged by this PR, stated for honesty): the node version remains an input, which is correct (the child is spawned with the same node), and a node upgrade still re-verifies everything once.

---

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. The verifier version is a content hash whose whole job is "same verifier code and policy → same value". A value that depends on a directory outside the package violates that contract at the lowest layer, so the fix belongs exactly where the hash is computed. The alternative (keep a toolchain pin but hash the declared `devDependencies.typescript` from the package's own `package.json`) was considered and rejected as more code for no verdict-relevant information: the installed package carries no devDependencies and the ratchet does not use the verifier's typescript anyway.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [x] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context.
- [ ] ⚠️ Yes, with brittle logic — STOP.

The `verifier-mismatch` equality check is a deterministic invariant (an enumerable domain: the bytes of the verifier and the values the server passes), not a judgment. This change removes an input from it; it adds no detector and no authority.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The verifier version is an invariant ("same code → same value"); this change makes the invariant hold where it previously did not.

---

## 5. Interactions

- **Shadowing:** none. The hash is computed in one place and compared in two (child start, boot-time record trust); both see the same new value.
- **Double-fire:** none. One one-time re-verify of `vh2` records at the first boot on this release, as for any verifier change.
- **Races:** none new. The child still recomputes at start and refuses on a mismatch, so a dist replaced under a running old server is still caught (that server passes a `vh2`/old value, the new child computes `vh3`).
- **Feedback loops:** the merge line (`LocalVerifyService`) re-queues records whose verifier version changed; this change makes that happen once per release instead of once per restart, which is the intended direction.

---

## 6. External surfaces

- Other agents on the same machine: none (the local verifier is repo-gated to an instar source checkout).
- Install base: none; `GET /local-verify/record` carries the new `vh3:` prefix in `verifierVersion` (an opaque string to every consumer; grep found no reader that parses the prefix: the three `vh2:` literals in tests were opaque stub values, updated to `vh3:`).
- External systems: none (no GitHub status text changes).
- Persistent state: existing `vh2` records in the index stay on disk and simply stop being trusted, as any verifier change does; no migration.
- Timing/runtime: the change removes a dependency on an uncontrolled runtime condition (the state of a sibling `node_modules`); it adds none.
- **Operator surface (Mobile-Complete Operator Actions):** no operator-facing actions.

---

## 6b. Operator-surface quality

No operator surface — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local by design**, unchanged: the local verifier runs on the serving-lease holder with an instar source checkout; its records are per-machine and its `verifierVersion` describes the verifier installed on that machine. Removing the ambient input makes the value a function of the installed package, node and policy only, so two machines on the same release and node now agree instead of diverging with each machine's agent-home folder. No user-facing notices, no durable state that follows a topic, no generated URLs.

---

## 8. Rollback cost

- **Hot-fix release:** revert the commit; the salt returns to `v2`/`vh2`. Records written under `vh3` then re-verify once. No data to clean, no agent state to repair.
- **Data migration:** none.
- **Agent state repair:** none.
- **User visibility:** none beyond the one-time re-verify in either direction.

---

## Conclusion

A one-input removal that makes the verifier version honest about what it measures: the verifier, not a neighbouring folder. The review confirmed the dropped input stopped carrying verdict-relevant information at PR #2326 and that the salt bump cleanly separates old records. No design change resulted from the review. Clear to ship.

---

## Second-pass review

**Reviewer:** independent general-purpose subagent (Claude), one round (2026-10-24)
**Independent read of the artifact: concur**

The reviewer re-derived the diagnosis from the `origin/main` source (probed Node's lookup from a fake `<base>/shadow-install/node_modules/instar/dist/localVerify`: a `typescript/package.json` planted at `<base>/node_modules` resolves), checked every remaining `h.update` input (fixed salt, the relative-import graph which stays under the package root, `nodeVersion`, the passed `protectedList`, `computePolicyHash()` over constants), confirmed the ratchet loads its parser from the run worktree (`orchestrator.ts` calls `loadTypescript([runDir])`) and that a `typescript` pin change is harness-changing (`harnessClassifier.ts`), confirmed no consumer parses the prefix (both comparisons are string equality), and confirmed the new test fails against the old code at the first planted assertion. No blocking findings; no weakening of the `verifier-mismatch` guarantee. One nit: section 6 claimed every `vh2:` test literal was updated while `tests/unit/localVerify/mergeLineWiring.test.ts:19` still carried the opaque stub `'vh2:x'`; the stub is now `'vh3:x'` and the file is in the covered set.

---

## Evidence pointers

- `tests/unit/localVerify/LocalVerifyService.test.ts` — "an ambient typescript install above the package does not change it (the 2026-10-24 flip)": fails against the `origin/main` source at the first planted assertion (`expected 'vh2:…' to be 'vh2:…'`), passes with the fix; "the installed verifier hashes to vh3"; "node, the protected list and the policy each change it".
- `tests/unit/localVerify/{LocalVerifyService,runVerifyMain,mergeLineWiring}.test.ts`: 78 passed. `npx tsc --noEmit` clean. `npm run lint` clean.
- Reproduction (2026-10-24, before the change): a throwaway script computing the hash over identical files, policy and node with `typescriptVersion` null vs `'5.9.3'` produced `vh2:da61a7a1…` and `vh2:25b6e0cc…`, the two values seen alternating in the index across server restarts.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. This fixes a defect in TypeScript source (a hash input), not in a prompt, hook, config, skill or standards text; and it adds or modifies no self-triggered controller (no `unbounded-self-action` surface: nothing here restarts, spawns, retries or notifies on its own).
