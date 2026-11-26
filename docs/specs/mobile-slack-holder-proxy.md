---
title: "Owner phone reads Slack history held by another machine"
slug: "mobile-slack-holder-proxy"
author: "echo"
parent-principle: "Know Your Principal"
eli16-overview: "docs/specs/mobile-slack-holder-proxy.eli16.md"
approved: true
approved-by: "echo, assigned by coordinator session for topic 137342 under Justin's approval of Conversations build through deploy (2026-11-05 00:37 and 00:58 PST)"
review-convergence: "2026-11-05T11:46:30.988Z"
review-iterations: 2
review-completed-at: "2026-11-05T11:46:30.988Z"
review-report: "docs/specs/reports/mobile-slack-holder-proxy-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
---

# Owner phone reads Slack history held by another machine

## Problem statement

A Slack conversation id is local to the machine that minted it. `GET /mobile/chat/slack/:id/messages?machine=<holder>` refuses a request naming another machine with 409 `wrong-machine`. A phone is signed for one host, so a Slack row held by another machine cannot be opened. Topic 137342 needs this for native Conversations, and it was assigned to the native app owner.

## Proposed design

Same route and same device allowlist rule; no new route.

On the machine that answered the phone, when `machine` names another machine and the caller is a current device-signed owner phone, the route calls `holderRead`:

1. Find the holder in `resolvePeerUrls` by exact machine id. Not found: 409 `wrong-machine`, with no request made.
2. Run `isPeerUrlAllowedForCredentials` on its URL.
3. `poolPeerFetch` with the agent bearer, `redirect: 'manual'`, an 8 s timeout, GET only. At most 8 such logical reads run at once, 4 per holder, so one dead machine cannot take every slot. One read can try fallback ropes in sequence after a dead dial or a Cloudflare 520-530: each fallback passes the strict default guard, without the configured allowlist, and shares the same timeout. Those are `poolPeerFetch`'s contract, tested with it, not retested here.
4. A 3xx is refused. The body is read up to 4 MiB and the read stops there.
5. Before any holder content is returned, the device and person are read again from the live store. A phone no longer active, or no longer the owner, gets 403 and no holder content. Redirect, size and transport failures return a fixed error with no holder content, so they do not need this second check.
6. A success must carry `deviceView: true`, the same `conversationId` and a `messages` array. Holder refusals pass on only as four fixed codes.

The hop asks the holder with `deviceView=1`. A bearer read with that flag gets the row shape a phone gets, because a token read otherwise shows server paths. An older holder ignores the flag and omits the echo, so the answer is refused with `holder-outdated`, not passed on. Failures are reported through DegradationReporter. A `before` over 300 characters is 400; a missing token is 503.

Alternatives: pairing the phone per holder adds a pairing step per machine and leaves a phone unable to read while that machine is unreachable from it. Replicating Slack logs moves private history between machines for a read. A machine-signed on-behalf-of hop would let the holder tell a hop from other token reads, and is worth it if the holder must make its own decision; here it adds no authority, because the bearer already reads this route.

Known limit: the timeout is shared across ropes, so a stale address that silently drops packets can use all 8 s before a fallback runs, and that read answers 504. Pool reads have the same limit; the peer list orders ropes by health.

Bearer callers, MSP phones and unrecognized phones keep today's behavior: nothing is forwarded. So a holder's own token read cannot hop to a third machine, and `machine` equal to this machine is the existing local read. The alias is never looked up on the answering machine.

Sends are not proxied: the POST route is unchanged and still answers 409.

## Decision points touched

| Decision point | Classification | Why |
|---|---|---|
| Forward only for a current owner device | invariant | Slack speaks as the owner; authority must not depend on judgment. Checked before the fetch and after it. |
| Holder chosen from the trusted peer list | invariant | No request input can name a URL. |
| Answer shape check (`deviceView`, id, messages) | invariant | A fixed shape check on a trusted peer; failure refuses, the conservative default. |

## Verify the state, not its symbol

- Symbol: the `deviceView` echo. State claimed: the holder rendered phone-shaped rows. This is a compatibility contract with a trusted holder, not independent validation that paths were removed: the proxy forwards the remaining fields as given. Corroboration: `isDevice` and the echo come from one flag in `mobileSlackRoutes.ts`, and `tests/integration/mobile-slack-holder-proxy.test.ts` compares a proxied answer to a direct phone read for plain rows and an embedded saved-file path. Stored media and attachment rows are not in that comparison. Unmeasurable: no echo is a refusal.
- Symbol: device status and person role. State claimed: this phone is the owner's now. It is read from the live store after the wait. A revocation that lands after the last check and before the socket write is not covered; that window is the same as any local read.

## Multi-machine posture

Proxied-on-read through the trusted peer list. The feature exists to cross machines. No state is added and nothing is stored.

## Maturation plan

No flag, by design: an existing route answers one more case for the owner's phone only, and a revert is the whole rollback.

- **test-agent-live:** the unit, integration and e2e tests here: two real servers, and a real AgentServer boot with a socket holder.
- **dev-agent-live:** after release, read a Slack conversation held by another of Echo's machines from a device-signed request and record PASS or FAIL, with a health check beside it.
- **fleet:** the route rides `mobilePairing.enabled` and the native conversations gate; both machines need this version, and an older holder answers `holder-outdated`.
- **graduation criterion:** one week after release, `MobileSlackHolderProxy.read` degradation reports show only real outages, and Justin has opened a remote Slack row from the phone.
- **dark-window:** none: the route is live on release.
- **ladder:** mobilePairing

## Frontloaded Decisions

- MSP phones with a Slack grant stay local-only for now. Cheap to change after; nothing is exposed.
- Attachment downloads for a remote row are not part of this route. `attachments` rows pass through, and a download through the answering machine fails with a refusal. This is a stated limit of this change.

## Open questions

None.
