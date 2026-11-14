# Witness: print the registry's reason on errors — Plain-English Overview

> The one-line version: when the Witness registry rejects a request, the `witness` command now tells you the reason the registry gave, instead of showing the start of a raw JSON blob.

## The problem in one breath

`witness publish` sends a signed record to a registry server. If the server refuses it, you need to know why. That worked for one refusal code, 422. For every other error (a malformed DID, a request that is too large, being rate limited, a server failure) the command printed the first 300 characters of whatever the server sent back. A message like "slow down" arrived wrapped in JSON punctuation, and a long one could be cut off before its end.

## What already exists

- **The registry's error answers.** The registry already sends a readable reason, as `{ ok: false, reason }` or as `{ error: { message } }`.
- **The command's error helper.** All four registry commands (publish, lookup, get, stats) share one small helper that prints unexpected answers. The exit code was already correct, so scripts could tell the command failed.

## What this changes

The helper now looks for a reason in the answer first, and prints it after the same opening words: `registry answered 429 to publish: slow down`. If the answer has no usable reason, because it is not JSON, is empty, or holds something else, the command prints what it printed before. Because the helper is shared, lookup, get and stats improve too.

## What does not change

Which requests succeed or fail, the exit codes, the 422 message, what gets sent to the registry, and the rule that nothing from the server is trusted without being checked here. Only the words on screen change, and the server's words are displayed, never acted on.

## How it was checked

New tests covered 400, 413, 429 and 500 answers plus the no-reason cases. The reason tests failed on the old code and pass now, and the rest of the package's tests still pass. The real registry was also asked one read-only question that it refuses, and the fixed command printed its reason in plain text.

## What you need to decide

Nothing. Merging publishes a new patch of `instar-witness` to npm automatically, the same way every change to this package ships. A revert undoes it.
