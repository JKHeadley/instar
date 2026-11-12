# Side-Effects Review — job warnings carry a path to act; app send speaks as the verified owner

**Version / slug:** job-warning-path-to-act
**Date:** 2026-11-11
**Author:** Echo

## Summary of the change
Tier 1. Two fixes from one operator report (Justin, topic 134088, 2026-11-11 22:06 PST: "A notification like this should NEVER be presented without a direct link to the solution").

1. `JobScheduler`: the job-continuity warning ("Scheduled job X is not running as expected ... Check its gate, machine scope and last successful run") had no link and handed the checks to the operator. It also fired for healthy polling jobs: a gate that exits 1 means "nothing to do this time", yet three of those raised the warning (seen daily on Luna for "Notes to Luna on the admin Tasks tab", whose gate exits 1 when the inbox is empty by design). Now a gate that ran and exited 1 counts as a healthy check (closes the silence episode); a gate that errors, times out, or exits with any other code still counts as lost coverage. The warning says why in plain words and links to the job's console page (`/dashboard/console/#/work/schedule?job=<slug>`, which opens the job's runs, skips and Run now). While the tunnel's public link is not ready the warning waits for the next five-minute check rather than send without a link.
2. `POST /mobile/chat/:topic`: the app spoke as `getOwnerUserId()` only, so an agent set up without `ownerUserId` (Luna) refused every app message with "This agent has no Telegram owner to speak as." It now uses `getVerifiedOwner()` (the configured owner, else the one verified operator — the same answer authority-bearing buttons use), falling back to the old lookup.

## Decision-point inventory
- Continuity alert raise (existing signal → operator notice): `judgment-candidate` not needed; deterministic rule narrowed. Floor: an unexplained gate failure still alerts.
- App-send owner resolution: `invariant` — reuses the existing verified-owner resolver; no new authority.

## 1. Over-block
None added. The app route accepts strictly more (agents with a verified operator but no configured owner).

## 2. Under-block
A gate script that crashes with exit 1 (e.g. an uncaught Node exception with stderr discarded) now reads as "nothing to do" and no longer warns. Accepted: exit 1 is the shell's false and the documented "skip" answer for gates; errors that exit 2/126/127, signals and timeouts still warn, and a job that never passes its gate is not by itself a fault.

## 3. Level-of-abstraction fit
Both changes sit where the decision is made (the scheduler's skip observer; the route's preflight). Link construction reuses the server's operator-link resolver.

## 4. Signal vs authority compliance
Required reference: docs/signal-vs-authority.md. The continuity alert is a signal; this reduces false signals and adds a link. The owner lookup reuses the existing verified-owner authority; it adds none.

## 4b. Judgment-point check
None.

## 5. Interactions
`noteContinuitySuccess` also records `job-last-success-<slug>`, which the silence check reads as its reference; a polling job that keeps answering "nothing to do" therefore never trips the "no completed run" path either. The failure-alert path (consecutive failed runs) is unchanged. `getVerifiedOwner` returns the configured owner first, so agents with `ownerUserId` behave exactly as before.

## 6. External surfaces
Operator-visible notice text changes (plain reason + link). Fewer notices: healthy polling jobs stop warning. App users on agents without `ownerUserId` can now send to Telegram topics from the app.

## 7. Multi-machine posture
Continuity alerts are raised only by the machine holding the scheduler (unchanged, one voice). The link uses that machine's tunnel origin via the existing resolver, which survives machine boundaries the same way other link-bearing notices do. The app route already runs only on the lease holder.

## 8. Rollback cost
Plain revert. No state migration; `job-silence-*` and `job-last-success-*` keys keep their shapes.

## Follow-up: fallback marker placement

The no-silent-fallbacks ratchet reads the exemption marker only inside the catch braces. The origin lookup's catch had its marker after the closing brace, so the ratchet counted it as a new silent fallback (495 against a baseline of 494). The marker now sits inside the braces, and the logged catch that closes a silence alert carries its own in-brace marker. Behaviour is unchanged.
