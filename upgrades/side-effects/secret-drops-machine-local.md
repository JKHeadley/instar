# Side-Effects Review — Secret Drop values are machine-local; consume removes the stored copy first

**Version / slug:** `secret-drops-machine-local`
**Date:** `2026-11-16`
**Author:** `Echo (security effort, topic 143781)`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Tier 1: 3 source files, 1 script template, 1 baseline entry, 2 test files and 3 docs.

**`src/core/SecretSync.ts`**
- Secret Drop values (`secretDrops.<token>` at the vault root) are never sent to peers: `filterSecretsForSync` excludes the root key.
- The receiving handler first refuses the whole batch for a refused namespace found anywhere in the original payload. This is unchanged, and stripping cannot hide one.
- It then strips drop entries (the root key, or a top-level dotted key starting with `secretDrops`), counting them without naming them, and applies the rest.
- A push therefore never overwrites a machine's own drops. Before, `SecretStore.set` replaced the whole object.
- A mixed-version fleet keeps syncing everything else.

**`src/server/routes.ts` retrieve**
- A consume removes the stored copy first.
- If that fails, it answers 503 ("nothing was consumed, try again") with no token, keeps the value, and records a degradation event with counts only. Only then does it consume the in-memory copy.
- A browser password, which is never stored, skips the stored-copy delete.

**Retrieve script:** a consume is checked, retried once, and reported plainly when refused.

Class of problem: credential hand-offs were copied to, and lingered on, every paired machine, and a reported consume could leave the value stored. Found by the standing security review. The design converged over three rounds with Claude and GPT reviewers.

## Decision-point inventory

- Sync send filter — modify — the Secret Drop root key is excluded.
- Sync receive — modify — drop entries are stripped after the existing refused-namespace check.
- Consume — modify — the stored copy is deleted before success is reported.

---

## 1. Over-block

- **Cross-machine hand-off of Secret Drops is gone.** A drop is retrieved on the machine that received it. Before this, a drop only reached another machine after the push machine restarted or after a manual sync, and no flow in the codebase depends on it: the Bitwarden export already filters drops out, and the phone only counts this machine's drops. A session that moves machines between asking and retrieving gets a plain 404.
- **An unreadable vault now makes a consume of a stored drop answer 503** instead of claiming success; peek still works. This is unavoidable, because the route cannot prove the stored copy is gone.

## 2. Under-block

- **Copies already distributed** to peers before this update stay until they are consumed on that machine (`POST /secrets/retrieve/<token>?consume=true`). An automatic age sweep would delete unretrieved secrets, which this codebase does not do automatically.
- **Peers still on old code** can keep exchanging old copies until they update.
- **`GET /secrets/sync-status`** lists the drop paths a machine holds. This predates the change and is behind the bearer and the dashboard step-up.
- **The general replace-not-merge behaviour** of secret sync for other namespaces is a separate defect, filed to the feedback queue (`fb-f7ff9ec7-5d9`).

## 3. Level-of-abstraction fit

- The send filter and the receive handler are the only sync funnel. `buildSecretShareCommand` has one caller, `SecretProvisioner.provisionAll`, which filters first.
- The consume ordering is in the one retrieve route.

## 4. Signal vs authority compliance

- [x] Deterministic key classification and ordering; no content judgment.

## 4b. Judgment-point check

No new heuristic.

## 5. Interactions

- **Sync evidence:** gains a `droppedLocalDrops` count (never names). The log says how many were ignored.
- **Stuck-consumer warning and receipt messages:** unchanged.
- **Existing store-first behaviour:** unchanged on the receiving machine.

## 6. External surfaces

- The retrieve route can answer 503 on consume, with a plain message and no token.
- The sync payload no longer carries drops.

## 6b. Operator-surface quality

- The retrieve script says plainly when a secret was not marked consumed.

## 7. Multi-machine posture

Machine-local BY DESIGN. A Secret Drop value is a one-time hand-off to the machine that asked for it. Copying it to every paired machine widens where a credential lives, and no consumer depends on the copy.

## 8. Rollback cost

Revert and ship a patch. Nothing stored changes shape.

---

## Conclusion

Closes the class for new hand-offs and makes consume truthful. The second pass concurs. Clear to ship.

---

## Second-pass review

**Reviewer:** independent reviewer subagent (Claude, fresh context, read the diff and the sync/store/route code)

**Independent read: concur, with minor concerns, now addressed.** It found that no received payload shape can write, overwrite or delete local drops (including dotted, trailing-dot, empty, scalar and array forms), and that stripping cannot hide a refused namespace. Nothing else sends drops. The retrieve route never reports `consumed:true` with the stored copy remaining, never double-delivers, and never burns the value. No regressions.

Applied from its notes:
- The retrieve script ignored a 503 on consume; it now retries once and says so.
- A browser password, which is never stored, no longer depends on the vault to be consumed.
- The stripped-drop count is now in the log.
- A stale comment is fixed.
- Tests were added for the odd key shapes, the root-only send filter, and consuming a browser password with a failing vault.

Named, not changed: legacy copies on peers, and drop paths listed in sync-status (§2).

---

## Evidence pointers

- `tests/unit/secret-sync-drops-machine-local.test.ts`: 8 tests. The send, strip and every-form tests fail on the previous code. 61/61 across the secret-sync unit files and the hardened-retrieve migration test.
- `tests/integration/secret-drop-store-first.test.ts`: 4 new consume-order tests. Both 503 tests fail on the previous code. 10/10 for the file, run as a temporary unit-config copy on 2026-11-16.
- `tsc --noEmit` clean.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable (a code defect in secret sync and the consume path, closed by the tests above).


## Follow-up (Local Verify ratchets, 2026-11-17)

New catch blocks now carry the `@silent-fallback-ok` annotation with their reason (each either fails closed or reports and refuses), satisfying the silent-fallback ratchet. No behaviour change.
