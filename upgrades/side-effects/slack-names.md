# Side-Effects Review — Slack names instead of raw ids

**Version / slug:** `slack-names`
**Date:** `2026-11-08`
**Author:** `echo (M5 Pro builder, topic 134088)`
**Second-pass reviewer:** `not required`

## Summary of the change

Fixes fb-4db533fa-9d9.

Root cause: `SlackApiClient` posts every Web API call as `application/json`. Five methods do not read a JSON body: `users.info`, `conversations.info`, `conversations.replies`, `conversations.members` and `files.info`. I verified this on 2026-11-08 against the live API with a bot token that holds the scopes. With JSON these methods answered `user_not_found` / `invalid_arguments`; with form encoding they answered ok. So every user-name and channel-name lookup failed, and `SlackAdapter` fell back to the id silently.

Changes:
- `src/messaging/slack/SlackApiClient.ts`: `encodeSlackRequest` form-encodes `FORM_ENCODED_METHODS`. Every other method keeps the same JSON body as before, byte for byte.
- `src/messaging/slack/SlackAdapter.ts`:
  - `cachedUserName` / `cachedChannelName`: synchronous reads from a cache. A miss starts one lookup; the user cache lasts 5 min, the channel cache 1 h.
  - The two inbound name fallbacks and every failed lookup log their reason through `noteNameLookupFailure`, once an hour per id.
- `src/server/mobileSlackRoutes.ts`:
  - The bridge's history fills `senderName` from the cache for rows with no name, or whose name is just their user id.
  - `SlackAppConversation.channelName`, so `slackConversationTitle` gives the label, else `#<channel name>`, else `#<id>`.

Test: `tests/unit/slack-names.test.ts`.

## Decision-point inventory

No decision-point surface. Request encoding and display names only.

---

## 1. Over-block

No block/allow surface: over-block does not apply.

## 2. Under-block

No block/allow surface: under-block does not apply.

## 3. Level-of-abstraction fit

The encoding sits in the one HTTP client every Slack call goes through, so the five methods are fixed for every caller. That includes `files.info`, whose `invalid_arguments` an earlier self-verify fix had classified as healthy rather than recognising the format problem. The names are filled on the read path (the bridge) from the adapter's existing user cache.

## 4. Signal vs authority compliance

- [x] No: this change has no block/allow surface.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point.

## 5. Interactions

- `conversations.replies`, `conversations.members` and `files.info` now return real data where they used to fail:
  - thread history fetches now work;
  - the channel-members read in the adapter (~line 694) now works;
  - the `files.info` self-verify probe now gets the expected `file_not_found`, which it already classifies as healthy.

  Callers already handled success. They were written for it and failing silently.
- The existing `resolveChannelTitle` (registry channel names) starts working too.

## 6. External surfaces

- **Slack API:** the same calls as before, now answered. Lookups are cached, so there are fewer repeat calls than before, when every failure was retried on each message.
- **Dashboard and iPhone app:** Slack participants and channel titles show names.
- **Log:** one warning line per failed name lookup per id per hour.

## 6b. Operator-surface quality

Names replace raw ids, which removes raw internals from the primary content.

## 7. Multi-machine posture

Machine-local by design (physical-credential-locality): the caches belong to the Slack adapter of the machine that holds the Slack connection and its token, and the Slack rows are already local to that machine.

## 8. Rollback cost

Revert the commit. There is no stored state; the caches are in memory.

## Conclusion

Ready to ship. This fixes a fleet-wide silent failure the live proof uncovered. It was verified against the live Slack API with the dcproof-test app, and a re-check on a throwaway agent follows the merge.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect: not applicable. No self-triggered controller is added. The name lookup runs only when a read finds the cache cold, at most once per id in flight, and is bounded by the cache lifetime.
