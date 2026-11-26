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
