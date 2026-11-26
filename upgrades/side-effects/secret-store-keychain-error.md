# Vault keychain failure diagnostic

The macOS and Linux keychain write catch blocks report a fixed reason. Existing keychain reads, writes and fallback selection are unaffected. Synthetic failure output is used to test the reporter boundary. This change addresses degradation output. The macOS helper's process argument transport is a separate open issue.
