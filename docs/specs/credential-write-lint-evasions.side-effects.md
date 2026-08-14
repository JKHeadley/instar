# Side-Effects Review — credential-write lint: concatenation, re-binding, computed access

**Version / slug:** `credential-write-lint-evasions`
**Date:** `2026-08-14`
**Author:** `Echo (instar agent)`
**Second-pass reviewer:** `instar-codey — ranked this #1 of the remaining 24 by consequence`

## Summary of the change

`scripts/lint-no-unfunneled-credential-write.js` enforces spec §2.2: every Claude credential write must route through `CredentialWriteFunnel.withSlotLock`. Its raw-keychain rule is GATED on `content.includes('Claude Code-credentials')` — a deliberate narrowing so the other, distinct-service vaults (WorktreeKeyVault, SecretStore, GlobalSecretStore, RemediationKeyVault) never false-positive. That gate is also the weakness. Three evasions were reproduced against the shipped lint before any edit:

```ts
const SVC = 'Claude Code' + '-credentials';                 // gate never arms
execFileSync('security', ['add-generic-password', '-s', SVC]);
const store = defaultCredentialStore; store.write(p);       // re-bound receiver
provider['writeCredentials'](p);                            // computed access
```

Fix: fold simple string concatenation before the gate decides; resolve `defaultCredentialStore` re-bindings to a fixpoint; match computed access for both the store write and `writeCredentials`. Detection extracted to three exported pure functions; the CLI body guarded behind a direct-invocation check.

## Decision-point inventory

No decision point added or removed. Two are widened at their inputs: "does this file target the guarded service?" (now concatenation-tolerant) and "is this line a credential write?" (now alias/computed-aware). The funnel requirement, allowlist, messages and exit contract are unchanged.

## 1. Over-block — the dominant risk here

This lint blocks commits, and the gate it widens exists specifically to protect unrelated vaults. Widening it badly would trade a missed violation for noise on correct code, and a noisy check gets disabled. Bounded four ways:
- concatenation folding only joins ADJACENT string literals (`'A' + 'B'`); it invents no text and cannot synthesise the service name from unrelated pieces;
- the re-binding right-hand side must already be in the resolved set, seeded solely from `defaultCredentialStore`;
- resolution is per-file, so a name in one file cannot taint another;
- **five opposite-direction controls** pin it: a different keychain service, a raw keychain write with no guarded-service reference, an unrelated `.write(`, an unrelated re-binding, and comments.

Empirically decisive: **the real repo lints CLEAN before and after** (exit 0 both ways).

## 2. Under-block

Residuals, stated rather than implied: a service name assembled through a template literal with an interpolated variable, or imported as a constant from another module, still disarms the gate — both need value resolution this per-file text check does not do. Cross-module re-export of the store is likewise unresolved, consistent with the same limit named in PR #1875.

## 3. Level-of-abstraction fit

Detection belongs in the lint (it owns what counts as a credential write); extracting it to exported functions is what makes the rules drivable with fixtures instead of only end-to-end. Same move, same reason, as PRs #1870/#1874.

## 4. Signal vs authority compliance

The lint IS authority — it fails a commit — and that authority is unchanged in kind and scope. Only what it can see is widened, and the tree passes clean, so no new blocking condition is introduced.

## 4b. Judgment-point check (Judgment Within Floors standard)

None. Deterministic string folding, fixpoint name resolution, and regex matching. No heuristic, model call, or threshold.

## 5. Interactions

Blast radius: one script. The new exports have exactly one importer (the new test). The CLI body was previously import-unsafe — it calls `process.exit(1)` on violation, so any importer would have run the scan and could have killed the process; the guard closes that. `package.json` invocations unchanged; `tests/unit/lint-chain-completeness.test.ts` still passes.

## 6. External surfaces

None. No network, persisted state, credential read/write, telemetry, or route. It reads source files at lint time exactly as before — notably, this change touches a credential-adjacent LINT, never a credential path.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

Violation text unchanged (path:line, why, and the two remedies).

## 7. Multi-machine posture (Cross-Machine Coherence)

No issue identified — build-time check, no shared state, lease, or replication.

## 8. Rollback cost

Very low. One script, one new test file, one commit; no migration, persisted state, or config flag.

## Evidence pointers

- All three evasions REPRODUCED against the shipped lint before any edit, with a positive control caught in the same run: `EVADES bypass1/2/3`, `CAUGHT control`.
- Negative control executed: reverting concat-folding, re-binding resolution and the computed form fails **7 tests / passes 7** — the 7 passers being all five opposite-direction controls plus the plain forms. Source restored byte-identical (sha + 10,567 bytes).
- Real repo lints CLEAN before and after (exit 0 both ways).
- Import-safety verified in both modes: as a CLI it prints `clean` and exits 0; imported, it does not run the scan.
- 14/14 in `tests/unit/credential-write-lint-evasions.test.ts`.

## Class-Closure Declaration (display-only mirror)

Class: "a check defeatable by renaming or by splitting the literal it keys on." Closed for THIS lint for adjacent-literal concatenation, local re-binding (to a fixpoint), and computed access. **NOT closed** for: a template-literal service name with an interpolated variable; a service constant imported from another module; cross-module re-export of the store. **NOT closed repo-wide** — this is the 2nd of the peer audit's 25 defeatable checks (after `lint-no-unbounded-llm-spawn`); 23 remain, of which its triage classes 15 as SAFETY-FLOOR.
