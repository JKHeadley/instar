<!-- internal-only -->
# Isolated scheduled-run supervision trial

## What Changed

Added a reproducible throwaway-agent trial that runs one synthetic job through the real scheduler and records its supervision attempt under OS network isolation. No production gate changed.

## Evidence

The parent and child both proved outbound sockets denied. The run created one successful script result, one unchecked durable attempt, zero sessions, and zero provider calls. A fake provider-shaped key was scrubbed from all trial state, ledgers, and logs. The runner refused an unsandboxed launch.
