# Side-Effects Review — The owner's phone sees and removes a member's computers

**Version / slug:** `member-computer-owner-forget`
**Date:** `2026-11-22`
**Author:** `echo`
**Second-pass reviewer:** the follow-up slice and live-proof sections of `upgrades/side-effects/member-browser-any-computer.md` (reviewed with the parent change, which merged as #3565).

## Summary of the change

Follow-up to `member-browser-any-computer` (#3565). An owner-only route, `POST /mobile/team/people/:personKey/computers/:deviceId/forget`, and a `computers` array on owner reads of `GET /mobile/team/people`, for the People screen in iPhone build 119. Two small fixes from the headless-browser live proof: the join routes fall back to the coordinator's machine id, and the document page's `activeFor` takes the newest active record. This PR re-sends #3570, which GitHub closed when its base branch was deleted; its release fragment is split out of the parent's because the parent's fragment was consumed by release 1.3.1971.

## Decision points and analysis

- **Over-block:** none new. A member's phone gets 403 on the forget route and an unchanged People read.
- **Under-block:** none. The route is `ownerOnly` in `DEVICE_ALLOWLIST` and re-checked in the route; it can only take access away.
- **Level of abstraction:** it reuses the agent route's forget helper (ledger revocation plus `browser-unbind`), never a parallel copy.
- **Signal vs authority:** an identity check over enumerable facts (device role, owner standing); no heuristic holds authority.
- **Interactions:** the owner-only allowlist test now names the route. SEC-169 (#3647) touches the join-addresses route in the same file; the two merge cleanly and the join suites pass on the combined tree.
- **Multi-machine:** the removal replicates exactly as the agent's removal does.
- **Rollback:** revert; the app's Computers section stays hidden. No data migration.

## Evidence

- E2E `tests/e2e/documents-join.test.ts`: an owner phone lists and removes a computer; a member's phone gets 403 and no list.
- Unit `tests/unit/mobile-session-terminal.test.ts`: the owner-only set names the new route.
- Local Verify of head 74a3a95b7: unit 74135/0 failed, integration 7935/0, e2e 4419/0.
