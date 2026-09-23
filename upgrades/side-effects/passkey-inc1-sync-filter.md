# Side-Effects Review — Stop prototype Google passkeys spreading between machines (Increment 1)

**Version / slug:** `passkey-inc1-sync-filter`
**Date:** `2026-09-22`
**Author:** `echo`
**Second-pass reviewer:** `independent subagent (secret-sync is a credential-flow gate)`

## Summary of the change

Increment 1 of the approved spec `docs/specs/agent-held-google-passkey.md` (§6). Prototype agent-held
Google passkeys live in the shared vault as single top-level keys named `google_passkey_*`, and until
now secret sync copied them to every peer machine. `src/core/SecretSync.ts` gains a first-segment
matcher (`isLegacyPasskeyPath`). The SENDER (`filterSecretsForSync`, used by `SecretProvisioner`) now
omits these keys. The RECEIVER (`SecretShareHandler.handle`) drops and audits any that an older-build
sender still pushes, and stores the rest of the batch; it returns `{stored, dropped}`. The existing
`machineIdentityRecovery` rule (reject the whole batch) is unchanged. The vault read script template
`src/templates/scripts/secret-get.mjs` (always overwritten on update by PostUpdateMigrator) keeps
allowing reads of these keys, so the operator-run prototype scripts keep working, and appends one line
per read (key name, time, pid, mode; never the value) to `.instar/logs/passkey-legacy-reads.jsonl`.

## Decision-point inventory

- `filterSecretsForSync` (sender filter) — modify — also excludes `google_passkey_*` keys.
- `SecretShareHandler.handle` (receiver acceptance) — modify — drops `google_passkey_*` keys instead of storing them; the rest of the batch is stored.
- `secret-get.mjs` read path — pass-through with audit — no refusal; an audit line only.

---

## 1. Over-block

A vault key whose first segment happens to start with `google_passkey_` but is not a passkey would
stop syncing. No such key exists today, and the prefix is specific to the prototype naming. A user who
WANTS to share a prototype passkey to another machine can no longer do so through sync. That is the
intended behaviour (spec FD2: per-machine keys), and the spec's per-key adoption flow replaces it.

## 2. Under-block

- Copies that already reached the Mini and Laptop stay there. This change deliberately never deletes
  (spec §6); the per-key adopt/delete choice in a later increment handles them.
- The prefix match is case-sensitive: a key named in another case or style would still sync. All
  seven known keys use the exact lowercase prefix.
- Only reads through `secret-get.mjs` are logged; a direct in-process `SecretStore` read (a script or
  route importing the store) is not. Accepted for this increment; the separate passkey store in a
  later increment removes these keys from the shared vault altogether.
- A prototype key stored under a different naming scheme would still sync. All seven known keys match
  the prefix (verified from the vault's key names).
- Any session can still read these keys through `secret-get.mjs`. Now each read is logged. Refusing
  reads is deferred by the spec until the operator's per-key choice, so today's working repairs are
  not broken. <!-- tracked: CMT-544 -->

## 3. Level-of-abstraction fit

Correct layer. `SecretSync.ts` already owns the local-only namespace policy
(`LOCAL_ONLY_SECRET_PREFIXES`) at exactly these two chokepoints. The new rule sits beside it. It is
kept separate because the existing rule matches dot-segments and cannot express a top-level name
prefix.

## 4. Signal vs authority compliance

The receiver drop is a deterministic data-policy rule on a closed, named key family, not a brittle
detector judging content. It can only withhold a copy; it never deletes or blocks anything else. That
is the same shape as the existing `machineIdentityRecovery` rule. The read-log is signal only.

## 4b. Judgment-point check (Judgment Within Floors standard)

Invariant, not a judgment point: the rule is a fixed key-name policy with no competing signals
(spec §10, "Machine-scope guard" family).

## 5. Interactions

- `SecretProvisioner.provisionAll`: when every secret is a prototype passkey, it now sends nothing
  (the existing empty-set early return). This is tested.
- The mesh `secret-share` handler returns the handler result as the response. The new `dropped` field
  is additive and senders ignore unknown fields; it carries key NAMES back to the sender, never values
  (the sender already knew those names, since it sent them).
- The receiver's drop is recorded in the server log (durable, `logs/server.log`), not a separate audit
  file. That is accepted as the audit for this increment.
- `AccountCredentialShare` is unaffected; it uses its own verb.
- `/secrets/sync-status` lists local key paths only and is unchanged.

## 6. External surfaces

Other machines receive fewer secrets: the seven prototype keys stop arriving. No user-visible
message. The new log file is local and holds no secret values.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator-facing surface in this increment. The dashboard per-key choice comes in a later increment.

## 7. Multi-machine posture (Cross-Machine Coherence)

This change exists to make prototype passkeys machine-local, per the operator-ratified exception in
the spec (§12, FD2). Mixed versions are covered in both directions:
- An old sender pushing to a new receiver: the keys are dropped, the rest is stored (tested).
- A new sender pushing to an old receiver: the old receiver simply stops receiving prototype keys.

`passkey-legacy-reads.jsonl` is a per-machine audit log by design.

## 8. Rollback cost

Pure code change. Reverting restores the old copy-everything behaviour; there is no persistent state
to migrate. The audit log can be left in place or deleted.

---

## Conclusion

A small, restrictive-only first step that stops the spread of machine-bound credentials without
breaking the prototype scripts. Clear to ship after the second-pass review.

---

## Second-pass review (if required)

**Reviewer:** independent second-pass subagent
**Independent read of the artifact: concur**

Concurred after checking the diff and running the 21 tests. The four minor points it raised
(case-sensitivity, log-only audit for drops, direct SecretStore reads not logged, dropped names in
the mesh response) are now stated above.

---

## Evidence pointers

- `tests/unit/secret-sync-legacy-passkey.test.ts` (8 tests: matcher, sender filter, provisioner payload, mixed-version receiver, never-delete, recovery-namespace still rejected).
- `tests/unit/secret-get-legacy-passkey-read-log.test.ts` (read allowed + audit line with no value; ordinary keys not logged).
- Existing `tests/unit/secret-sync.test.ts` and `secret-sync-key-policy-wiring.test.ts` pass unchanged.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. This is new policy from an approved spec, not a
fix to a prompt, hook, config, skill or standards text, and it adds no self-triggered controller.
