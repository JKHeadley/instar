# Keep the vault key off the macOS process command line

The macOS vault writer used to put the master key in an argument to the system Keychain tool. During the short write, another local process that inspects process arguments could see that value. Fixing the failure message closed a logging path, but the process argument itself still needed to change.

Instar now passes the command to Apple's tool through its input stream and sends the tool only fixed arguments. It discards the tool's output. The writer checks the keychain slot by reading it back and comparing the exact bytes before reporting success. The existing fallback still applies when the Keychain tool cannot write the slot.

The per-agent and shared vaults use this same helper. The tests substitute a fake system process and synthetic keys so the tests can inspect arguments, input and readback without changing a real keychain.

**Follow-up (2026-11-26):** the new keychain helper is now listed in the release fingerprint manifest, so release checks recognise it.
