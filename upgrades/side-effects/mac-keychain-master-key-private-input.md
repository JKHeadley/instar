# macOS vault keychain write input

The shared and per-agent writers use the Apple Security tool with a fixed argv and a bounded command over stdin. Only selectors that can be safely quoted are accepted. Both output streams are discarded. A fresh read of the exact slot must match the expected value before success. The update mode replaces the earlier delete-then-add sequence.

Existing file and password fallback behavior is preserved. A current backend failure uses the fixed non-value-bearing diagnostic. Tests use synthetic keys and a fake keychain runner. No live keychain write was attempted.

## Independent cross-family review (2026-11-26, rebuild onto PR 3928)

This change moved off PR 3900 (its base branch closed with 3898) onto 3928's branch. It is a credential file, so an independent Codex reviewer (GPT family, read-only sandbox) reviewed the diff. Verdict: CONCERN. The points and the author's answers, each checked against the code:

> The write passes fixed argv and adds no key to the environment. It discards child output, and both stores catch write exceptions.
> The verification read captures the key on stdout. A failed read can attach that output to the exec error, and the diff omits SecretStore’s read catch body.
> Base64 is safe as an unquoted token, and selector validation blocks obvious delimiters. The mocks don’t exercise Apple’s parser or EOF handling.
> The five-second timeout sends SIGTERM. A synchronous call can still block if the child fails to exit.
> Readback can fail after `-U` has stored the new key, triggering fallback despite a successful write. Upsert also changes which entry survives a failed write.
> The unit test proves the argv passed to the mocked runner. It does not observe a real macOS process.
- Verification read error carrying the key: both read paths (SecretStore.readOsKeychain and GlobalSecretStore) discard the error object. One reads only its exit status and the other returns null, so a read-back key cannot reach a message, log or thrown error. No leak.
- Readback failing after a successful upsert: the write is then reported as unconfirmed and the key stays in the owner-only key file (or its existing slot), so nothing is lost. This is a conservative false negative, not a leak.
- Timeout: execFileSync's 5-second timeout kills the child process, the standard behaviour.
- Test scope: the unit tests prove the argv passed to a stub runner, not a real macOS process. This is an accepted limit; a live check needs a throwaway agent on a Mac.

No code change was made in response; the concerns are answered above for the reviewer of this PR.

- Stage-B manifest: `src/core/macKeychainWrite.ts` is excluded with a reason (reached only through the already-excluded SecretStore and GlobalSecretStore), so the release fingerprint check classifies it.

## Live macOS check (2026-11-26, Studio, before merge)

The Chief of Staff asked for proof beyond the stub runner, since the reviewer did not concur. A throwaway check ran on the Studio. It used a synthetic random 32-byte key and its own uniquely named keychain item (`instar-livecheck-3931-<random>`, account `synthetic-throwaway`), deleted afterwards. Echo's real keychain items were never read or written. The key manager was not run against the real keychain, because its legacy-slot adoption could copy a real key into a test item. A separate sampler process ran `ps -axo args` in a loop and recorded any line containing the key (base64 or hex).

- Positive control, the old way (key as a command-line argument to `security add-generic-password -w`): 124 writes in 15 s. The key appeared in **52 of 166** process-table samples, so the sampler can catch it.
- New path (`writeMacKeychainKey`, real `/usr/bin/security -i` on stdin plus a real read-back): 88 writes in 15 s, all 88 confirmed by read-back. The key appeared in **0 of 220** samples. An earlier 30-write run also stored and read back the exact key, with 0 hits.
- Owner-only file fallback: a temporary state folder with a keychain stand-in that always rejects writes. `getMasterKey()` wrote `machine/secrets-master.key` with mode **600**, holding the exact key, and a fresh manager reloaded the same key. The temp folder was removed.
- Every test keychain item was confirmed deleted.

Result: the master key does not appear in another process's argv on the new path; the old path demonstrably did. The fallback file behaves as described.

## Reviewer re-check and follow-up fixes (2026-11-26)

Codex re-check after the live evidence: still CONCERN on two narrower points; the parser, EOF and argv concerns were resolved.

> The live check resolves the parser, EOF, and argv concerns for the tested path. Both read catches discard credential-bearing output.
> The five-second timeout sends SIGTERM. `execFileSync` still waits for the child to exit, so the timeout alone does not bound the call.
> The fallback test covers a rejected write. A successful upsert followed by a failed read can leave both copies, and the supplied evidence leaves subsequent key selection unverified.
- Timeout: the write call now sets `killSignal: 'SIGKILL'`, so a child that ignores SIGTERM is killed outright at 5 s. The unit test pins `timeout: 5000` and `killSignal: 'SIGKILL'`. A live rerun after the change: 103 writes, all confirmed, 0 of 250 process-table samples contained the key.
- Both copies after an unconfirmed write: `getFileKey` writes the same generated key to the keychain and then, when the write is unconfirmed, to the owner-only file, so the two copies are identical. A new unit test uses a keychain stand-in whose write lands but reports failure. It checks that the file and the keychain slot hold the same key, a fresh manager resolves that key, and `getCandidateKeys()` returns exactly one candidate. Unit tests: 34/34.

## Final reviewer verdict (2026-11-26)

> VERDICT: CONCUR
> SIGKILL addresses the concern that the write child could ignore SIGTERM and keep `execFileSync` waiting.
> The new test verifies that an unconfirmed upsert leaves identical copies and that a fresh manager resolves the same key with exactly one candidate.
The independent reviewer concurs after the live check and the two follow-up fixes.
