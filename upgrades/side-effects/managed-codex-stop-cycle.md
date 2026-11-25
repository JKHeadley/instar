# Side-effects review for native Stop cycle attribution

Tier 1. An unwired deterministic parser attributes a callback only within a verified, bounded rollout. No production caller is added.

## Decision-point inventory

The parser requires one matching complete assistant event in the current native turn, and that event must be the newest completed assistant event. It refuses incomplete or malformed input.

## Over-block

Identical responses within a turn are ambiguous and intentionally produce no result. The production decision must keep that callback non-actuating. There is no live effect in this commit.

## Under-block

This parser does not establish rollout identity, current custody, or admission. A future caller must establish those before use and retain the durable attempt key across retries.

## Level of abstraction and signal versus authority

Attribution is evidence for the managed decision. The work-claim transaction remains the authority to issue a directive.

## Tests, impact and rollback

Three focused tests passed. The assistant item shape was also observed in a disposable native Codex run. No runtime, state, data, credential, or outbound action changes. Revert removes the parser and tests.
