# Local verifier version: stop hashing a neighbouring folder — Plain-English Overview

> The one-line version: the local test verifier's "which version of me is this?" fingerprint included the TypeScript version found by searching the folders *above* the installed program, so it changed whenever an unrelated folder was emptied and refilled; this fix removes that input so the fingerprint describes the verifier and nothing else.

## The problem in one breath

The local verifier (the thing that runs the test suite on a pull request before it may merge) stamps every result with a fingerprint of its own code, so that a result produced by an older verifier is never trusted by a newer one. One input to that fingerprint was "the installed TypeScript version". But the way it looked that version up was Node's normal module search, which walks up through parent folders until it finds a `node_modules/typescript`. From where instar is installed on an agent machine, that walk reaches the agent's own home folder, whose `node_modules` gets emptied and refilled by an unrelated install. So the fingerprint flipped back and forth between two values with the state of that folder, and every flip threw away every pending green result, so PRs had to be re-tested after each server restart.

## What already exists

- **The verifier fingerprint** (`verifierVersion`) — a hash over the verifier's own source files, the protected-path list the server passes it, the version of Node it runs under, and the policy (lane configs, inventory rules, deadlines). Same code and policy → same fingerprint. It keeps working across releases that do not touch the verifier, which is why it replaced the plain package version.
- **The mismatch check** — the verify child recomputes the fingerprint at start and refuses to run (`verifier-mismatch`) if it differs from what the server passed; at boot, records with a different fingerprint are re-verified. Unchanged by this fix.
- **The skip ratchet's parser** — since PR #2326 the TypeScript parser used to count skipped tests is loaded from the PR's own worktree (the one `npm ci` just installed), not from the verifier's install. So the TypeScript version was already a property of the PR being tested, not of the verifier.

## What this adds

It removes one input. The fingerprint no longer includes any TypeScript version, and the code no longer performs any lookup that can leave the installed package. To keep old and new fingerprints clearly apart, the hash salt and prefix move from `vh2` to `vh3`: every result stamped under `vh2` is treated as "verifier changed" exactly once (as any verifier change is), and from then on the fingerprint only moves when the verifier, its policy, the protected list or Node actually change.

Secondary changes:

- The test-only override for the TypeScript version is removed from the function's options.
- A new unit test builds a fake install under a fake agent home, plants `node_modules/typescript/package.json` two levels above it (and inside it) with two different versions, and proves the fingerprint never moves. This test fails on the old code.

## The new pieces

None. No new module, route, config knob or state. One function has one fewer input.

## The safeguards

**Old results cannot be mistaken for new ones.** The salt bump means a `vh2` value can never equal a `vh3` value, so the one-time re-verify after this ships is deliberate and complete.

**Nothing the verdict depends on is lost.** A PR that changes the pinned TypeScript version is already classified harness-changing by the toolchain rule and verified with its own harness; the parser it uses comes from its own worktree. The removed input described neither the verifier nor the PR.

**The mismatch check still works.** A `dist` replaced on disk under a still-running old server is still caught: the child computes a `vh3` value, the old server passes a `vh2` one, and they differ.

## What ships when

One pull request, one commit: the source change, the updated and new tests, this overview, the side-effects review, and a release note. No migration, no config, no restart requirement beyond the normal release.

## What you actually need to decide

Nothing beyond the PR review: is it right that the verifier fingerprint should depend only on the installed package, the values the server passes, and Node — and never on what happens to be installed in a folder above it? This change says yes.
