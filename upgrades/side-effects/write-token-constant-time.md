# Side effects: the state-submit write token is compared in constant time (SEC-123)

In plain words: `validateWriteToken` found the presented write token with `t.token === token`, which can leak timing about the token. It now compares SHA-256 digests of both with `crypto.timingSafeEqual`, checks every stored entry without an early exit, and skips malformed entries.

Tier 1. Size: 1 source file (about 10 lines), 4 new unit cases. Effort: no spec rounds, first commit attempt.

## What changes for running agents
- `POST /state/submit` accepts and refuses exactly the same tokens as before: a live matching token is accepted with its machine id; revoked, unknown and empty-list cases are refused with the same error.
- A stored list that is not an array, or entries without a string token, are now skipped instead of throwing (the route already turns a parse failure into a 500; a throw here would have been an unhandled 500 too).
- When a revoked copy and a live copy of the same token are both listed, the live one is accepted, as before (`find` with `!revoked`).

## Over-block
No issue identified: the accepted set is unchanged.

## Under-block
The route is already behind the agent's bearer token, so this is defence in depth. The `write-tokens.json` file itself is not covered here.

## Level of abstraction
The compare lives in the one function the route calls; no other caller.

## Signal vs authority
Same authority as before (the token check); only how equality is computed changes.

## Interactions
None. The machine-id match after validation is unchanged.

## External surfaces
None.

## Multi-machine posture
Machine-local by design: the main machine checks tokens it issued and stored locally.

## Rollback
Revert the commit.

## Second-pass review
**Reviewer:** independent general-purpose reviewer subagent (read-only), given the diff, the route and the tests. It confirmed the accepted and refused token set is unchanged for every realistic input, that `timingSafeEqual` always gets equal-length buffers and cannot throw, that the route has no other plain compare of the token, and that both refusals return the same message. It noted that only the source-scan and malformed-entry tests fail on the old code; the others lock in unchanged behaviour. Concur with the review.
