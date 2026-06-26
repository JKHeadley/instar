## What Changed

The outbound tone gate (which screens the agent's replies for leaks like passwords, commands, or file paths) used to do the same thing for everyone when it couldn't get a verdict under load — it HELD the message. That sealed the operator out of their own channel: under heavy load, status replies to the operator were held with "could not produce a verdict within the budget," so the operator saw delivery receipts but no reply.

The fix tiers that no-verdict behavior by who the message is going to. On the operator's own verified channel, a no-verdict availability failure now DELIVERS (the operator must never be locked out of their own agent). For anyone external, it still HOLDS, fail-closed (never leak an unreviewed message to a third party). A real "this leaks — block it" verdict still blocks for everyone — only the case where the reviewer couldn't decide is tiered.

Who counts as "the operator" is resolved strictly from the verified, locally-authenticated operator binding (never a name in a message, never a spoofable field) AND only when the agent has a single human operator — so a multi-user agent always fails closed. It ships OFF by default (today's hold-everywhere behavior is unchanged) and is an explicit opt-in with a dry-run mode to soak first. This is the outbound twin of the inbound "operator channel is sacred" fix.

## Evidence

- `tests/unit/messaging-tone-gate-operator-channel-tiering.test.ts` (12) + `tests/unit/tone-recipient-class.test.ts` (10): both sides of every boundary — operator delivers on capacity-shed/provider-error/unparseable/budget-timeout; external + absent-binding + multi-operator + resolution-error all HOLD; a real content block always holds; dry-run holds + logs; legacy modes preserved. 46 existing tone-gate/budget tests still green (no default-behavior change).
- 3-round convergence caught + fixed a spoofable-leak design: `docs/specs/reports/outbound-gate-tiered-fail-direction-convergence.md`.

## What to Tell Your User

If you ever saw a delivery receipt but no reply from your agent under heavy load, that was the safety screen holding your own message because it could not finish reviewing it in time. Your own channel will now get the message through in that situation, while messages to anyone else stay held until they can be checked. It is off until you turn it on, with a try-it-safely mode that just logs what it would do first.

## Summary of New Capabilities

- Operator-channel-sacred outbound: a no-verdict tone-gate failure delivers on the operator's own verified channel and holds for everyone else, instead of sealing the operator out under load.
- Resolved strictly from the verified operator identity, single-human-operator only, fail-closed on any doubt; off by default with a dry-run soak mode.
