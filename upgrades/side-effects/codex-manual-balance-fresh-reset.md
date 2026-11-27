# Side-effects review for fresh Codex reset eligibility

## Summary

This changes the destination signal for the existing operator-requested unused-quota balance. Tier 1 is appropriate because the patch does not change the stop or launch authority, add a route, schedule moves, or change credential state. Unit, HTTP integration, and production-shaped lifecycle tests cover the new exact-zero branch.

## Review

- Over-block. A newly reset destination remains ineligible without a fresh native account reading, an agreed window and a forecast explicitly waiting for history. These conditions avoid calling unknown quota zero.
- Under-block. A valid 0% sample can age while a move is evaluated. The existing final selector revalidates the exact target and the existing stop and launch protections still apply.
- Abstraction fit. The local quota chooser owns destination ranking. Changes to it do not grant new authority to stop work.
- Signal vs. authority. This uses direct quota evidence to nominate a destination for the already authorized manual flow. The existing eligibility, identity, work, and recovery authorities remain the final decision-makers.
- Interactions. Each confirmed move changes the count used in the next ranking. The scores use different units. Compare the running-session counts across the groups, and use each score only within its group. A fresh account with more assigned sessions than the best forecast-backed account cannot displace it.
- External surfaces. The same request may now name a freshly reset Codex destination in its existing result. It does not install any automated movement.
- Multi-machine posture. Choice uses the quota and the locally executable credential on the responding machine. That credential slot and the running session are local. The existing account and session pool views remain the sources for cross-machine visibility.
- Rollback. Reverting the ranking change returns manual requests to forecast-only selection. No data migration is needed. Completed moves remain ordinary sessions on their verified accounts.

## Independent review

The reviewer concurred after narrowing the proof to the native weekly sample and requiring it to follow the later of the two equivalent reset boundaries. The added regression covers a weekly sample taken between those boundaries while the account-wide summary appears fresh. A subsequent review found that the original group precedence could concentrate every move on one fresh account. The correction compares the running-session counts across the groups. The eight-move fixture exercises the case without waiting for a quota poll.
