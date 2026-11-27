# Vault keychain failure diagnostic

The macOS and Linux keychain write catch blocks report a fixed reason. Existing keychain reads, writes and fallback selection are unaffected. Synthetic failure output is used to test the reporter boundary. This change addresses degradation output. The macOS helper's process argument transport is a separate open issue.

## Tier 2 independent review (2026-11-26, recommit 3bcae5ec)

The gate's risk floor is tier 2 for this credential-handling file, so an independent reviewer from another model family (Codex, GPT family, read-only sandbox) reviewed the diff to src/core/SecretStore.ts and its test. Verdict: CONCUR.

> Both changed handlers discard child-process errors and report only fixed text. No key material reaches diagnostics through the shown catches.
> The success and failure returns and command invocations are unchanged, preserving the return signal that drives vault fallback.
> For both platforms, the test injects the encoded key and an output marker, checks that the write returns false, and verifies both strings are absent from the report payload.
> The test stubs the reporter, so its coverage ends at the payload. It also stops before fallback persistence.
Noted limit: the test stubs the reporter, so its coverage ends at the report payload and stops before fallback persistence. The fallback return signal itself is unchanged.
