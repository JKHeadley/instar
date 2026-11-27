# Side-Effects Review — Organization members page, departure and a second policy keeper

**Version / slug:** `org-members-and-keepers`
**Date:** `2026-11-16`
**Author:** `echo`
**Second-pass reviewer:** `independent subagent (see below)`

## Summary of the change

New:
- `src/core/OrgMembers.ts`: signed check-ins, invitation tokens, the transition table, remove and restore, the page listing.
- `src/core/OrgKeepers.ts`: the keeper list, proposal checks, countersigning, the shared publish lock.
- `src/core/OrgMemberSide.ts`: the member key, token, consent, pending rejoin and removal notices.

Changed:
- `orgPackRoutes.ts`:
  - public `POST /org/checkin` and `POST /org/pack/propose`, with two-lane rate limits;
  - bearer `GET /org/members`;
  - owner-device routes for members, invitations, keepers, keeper-request, keeper-propose and checkin-consent;
  - invitation links carry a token; drafts record their base; publish checks it under the lock and registers the publisher's own member key;
  - join stores the token and notes a rejoin; leave sends a "left" check-in;
  - status carries `removedNotice` and `checkinConsentNeeded`.
- `OrgPackUpdater`: `orgRequest` (the pinned https call, now shared); the daily check-in after a successful update check.
- `AgentServer`: small JSON parsers for the two public routes; the agent name passed to the routes.
- `server.ts`: identity for check-ins.
- `mobilePairingRoutes`: two allowlist rules.
- Installer: `orgInviteToken`.
- `join.astro`: disclosure line and token passthrough.
- Awareness entry.

Spec: `docs/specs/org-members-and-keepers.md` (6 rounds, approved; the recovery copy cut into its own spec). Tier 2.

## Decision-point inventory

- Check-in acceptance — add — signature, clock window, replay by `lastAt`, invitation token for new keys, capacity.
- Membership transitions — add — a fixed table; removed → joined only by the admin's restore.
- Keeper proposal acceptance — add — listed key, current base, cap not looser, `validateBundle` before signing.
- Owner-device acts — add — remove, restore, revoke, keepers add and remove, keeper-request, keeper-propose, consent.

---

## 1. Over-block

- Behind one shared address, more than 120 unverified requests an hour from new keys would be refused. Known keys use their own lane.
- A keeper's proposal fails while the organization's agent is unreachable, and says so.
- More than 500 joined members are refused with `member-limit`.

## 2. Under-block

- Names are self-reported, and anyone holding a live invitation link can check in under any name. The page and the awareness text say so.
- Not built: forwarding the public and admin routes to the key-holding machine on a multi-machine admin agent (spec Multi-machine). On such an agent, a request that reaches a machine without the key answers `org-key-elsewhere` or 404. This is noted as a follow-up below. It doesn't affect single-machine admins, which is every pilot today.
- Not built: copying member state to a member's peer machines. A member agent on several machines may show as two entries. Same follow-up.

## 3. Level-of-abstraction fit

Check-ins ride the existing daily update call and reuse its address checks. Keepers reuse the organization key and `validateBundle`, so members' checks are unchanged. Device acts reuse the device-signature path.

## 4. Signal vs authority compliance

Every new authority is a deterministic fact: a signature, a token hash, a version number, an ordered cap, a table row. There is no judgment anywhere.

## 4b. Judgment-point check (Judgment Within Floors standard)

None: no LLM or heuristic is involved.

## 5. Interactions

- Update check: the check-in runs after it and never blocks it.
- Org-pack publish: now under a lock, with a base check. Once something is published, a draft with no base (made before the first publish, or before this version) counts as stale and is shown again rather than published over newer text.
- Invitation links gain `&t=`. The join page and the Mac app read it; older apps ignore it.

## 6. External surfaces

- Two new public routes on the organization's agent, active only while `shareUpdates` is on, with small bodies and rate limits.
- Members now send names and version. The join screen says so, and members who joined earlier must consent first.

## 7. Multi-machine posture (Cross-Machine Coherence)

- Machine-local. The organization's registries live with the key, and members' state lives on the machine that joined.
- Forwarding to the key machine and copying member state to peers are not in this PR; that is stated above and tracked.

**Status surfaces:** `GET /org/members`, `GET /mobile/org/members`, `GET /mobile/org/status` (`removedNotice`, `checkinConsentNeeded`).

## 8. Rollback cost

Revert the code: check-ins get 404 and updates continue; keepers can no longer propose; versions they already proposed stay valid, being organization-signed. The registry files are left inert. No migration.

## Class-Closure Declaration

- `unbounded-self-action` — closure `n/a`: not a self-triggered loop. The check-in is one call inside the existing daily update check, which already has backoff and a 30-day stop; the "left" check-in runs once, when the person leaves.

## Conclusion

Ships live for agents that publish or join; an agent that does neither is unchanged. Covered by unit tests (members 6, keepers 4), an integration test across two servers, an alive e2e test, and the Mac app's Work agents list.

## Second-pass review (if required)

**Reviewer:** second-pass subagent (two reads)
**Independent read of the artifact: concur** (second read)

The first read did not concur. It found:
- a failed publish that never answered (the publish lock swallowed errors);
- async handlers whose errors went unhandled on Express 4;
- drafts with no base that could publish over a keeper's version;
- a non-JSON 200 counted as a successful update check;
- the per-key check-in limit applied after the write;
- names that allowed bidirectional and zero-width characters;
- a silent refused rejoin;
- a drift between spec and code in where the rejoin flag lives.

All are fixed. The second read confirmed each with file and line. Two low notes remain, stated here:
- The known-key lane counts requests before the signature check, so someone who knows a member's public key can use up that member's hourly allowance. Member keys are not published.
- Two rare invisible characters (U+061C, U+180E) are not in the name filter. Every row is labelled as reported.

## Evidence pointers

- `tests/unit/org-members.test.ts`, `tests/unit/org-keepers.test.ts`, `tests/integration/org-members-and-keepers.test.ts`, `tests/e2e/org-members-and-keepers-alive.test.ts`; Mac commit 75bff6a on echo/mac-create-agent.
