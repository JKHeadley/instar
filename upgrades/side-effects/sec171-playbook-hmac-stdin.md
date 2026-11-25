# Side effects: playbook-hmac.py stores its key via `security -i` standard input (SEC-171)

In plain words: `store_key` passed the playbook HMAC key as `-w <key>`, so it sat in process arguments that `ps` shows to every account on the Mac. It now goes on standard input to `security -i`, hex-encoded behind `-X`, the approach SEC-155 used for the agent's other keychain writes.

Tier 1 by size, security-sensitive: an independent second-pass review is attached below. Size: one function in `playbook-scripts/playbook-hmac.py` plus a new helper, and 1 new unit test file.

## What changes for running agents
- **`store_key`** still deletes the old item first. It then builds `add-generic-password -s "playbook-hmac" -a "playbook-hmac-v<N>" -X "<hex of the key text>" -T ""` with `_keychain_add_line` and runs `/usr/bin/security -i` with that line as input. The stored bytes are the key's hex text, exactly what `-w` stored, so `get_key()` (`find-generic-password -w`) reads the same value. `-T ""` (no app trusted) is unchanged, and a live probe confirmed `security -i` accepts it.
- **Guards.** A line over 4096 bytes is refused before any add, because `security -i` splits a longer line and stores a truncated item (measured for SEC-155). A real key is 64 hex characters, giving a line of about 200 bytes. Names containing a quote, backslash, `$`, backtick or control character are refused, though the service and account names are fixed.
- **Failure.** A non-zero exit still prints `Error storing key` and exits 1, as before.

## Signal vs authority
Not applicable: this changes how a key reaches the keychain, not who may act.

## Second-pass review
**Reviewer:** independent Claude Sonnet subagent (fresh context, read-only, given the finding and the diff), 2026-11-22. Verdict: CONCUR. No argument secret remains in `playbook-scripts`; the only `-w` left is the read in `get_key()`. Byte parity holds, so `bytes.fromhex` still works. The blocked characters and the produced line match the test exactly. Failure behavior is preserved. It ran the 4 tests and all pass. The harness uses only the standard library and never touches a keychain.

## Rollback
Revert the commit. Stored items are unchanged.

## Tests
- `tests/unit/sec171-playbook-hmac-stdin.test.ts` (new, 4 cases): the real module runs in an isolated Python with `subprocess.run` replaced by a recorder. The delete and then `security -i` are called with the exact input line and the key never appears as an argument. A failed write exits 1. An over-long key is refused before any add. Unsafe names are refused. It passes here.
- Live on this Mac: `store_key` with an unused version (999) stored the item, which was found and then deleted.

## Class-Closure Declaration
- `unbounded-self-action`: closure n/a. The same single keychain write per call.
