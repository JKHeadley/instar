# The playbook signing key is stored without appearing on the command line

<!-- bump: patch -->

## What Changed

SEC-171. `playbook-scripts/playbook-hmac.py` stored its HMAC signing key in the macOS keychain with `security add-generic-password ... -w <key>`. That put the key in the process arguments, which `ps` shows to every account on the Mac. It now sends the command to `security -i` on standard input, with the key hex-encoded behind `-X`. That is the approach SEC-155 used for the agent's other keychain writes. The stored bytes and the "trust no app" setting (`-T ""`) are unchanged, so reading the key works as before. A line too long for `security -i` to read whole is refused rather than split into a truncated item. A failed write still fails the command.

## What to Tell Your User

- **Signing key kept private**: "The key I use to sign my playbook no longer shows up in the list of running programs when I save it."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Playbook key stored via standard input | Automatic |

## Evidence

- `tests/unit/sec171-playbook-hmac-stdin.test.ts`: the real `store_key` runs with `subprocess.run` replaced by a recorder. The add goes to `security -i` with the exact stdin line and the key never appears as an argument. A failed write exits 1. An over-long line is refused before any add. Unsafe names are refused.
- A live run on a Mac with an unused key version stored the item and then deleted it.
