# Side-Effects Review — the first list of recommended services (proactive offer), behind a switch

**Tier 2 by risk** (a new unprompted message to the owner; a new tap that records a yes for an address service; rows in the replicated ledger), with second-pass review. Spec: `docs/specs/recommended-services.md` → Offers, Yes ("Reaching the page"), No, Surfaces, Rollout step 3, Multi-machine posture. ELI16: `docs/specs/recommended-services-offers.eli16.md`. Ships OFF (`recommendedServices.offers.enabled`), proven on a throwaway agent, then on for the development agent per the maturation plan.

**Size:** 8 source files (2 new), 5 test files (2 new); about 420 lines of source. **Effort:** no spec rounds (the parent spec is converged and approved); 1 commit attempt expected.

## Summary

- `RecommendedServicesLedger.ts`: `OfferRow` (`type: 'offer'`, owner, listId, `pending` | `offered`, messageId, origin `first-offer`), validated exactly, signed and replicated like a choice, ignored by the choice fold. `recordOfferPending`, `recordOfferDelivered`, `offerState`, `pendingOffers` (a pending row is released after `OFFER_PENDING_TTL_MS`, a week), `lastListAt`; `OFFER_LIST_EVERY_MS` (a week).
- `offerList.ts` (new): `offerCandidates` (available, choice unset, no legacy decline, offer state none, not in use), `renderOfferList` (words per row, the confirm link when there is an address, a `rs:n:<nonce>` No button per row, a `rs:y:<nonce>` Yes button only for a `wayIn` row when there is no address), nonces and list ids.
- `offerTaps.ts` (new): `OfferTapStore`, durable single-use taps on this machine (consumed before acting, expire after 30 days, invalidated per service), with the no-tap bound `OFFER_NO_TAPS_PER_HOUR` = 10.
- `recommendedServiceRoutes.ts`: deps `offersEnabled`, `sendOfferList`, `linkBase`, `registerOfferTapHandler`; `offersLive()` (switch on, send available, owner resolves, migration flag for that owner, first result delivered, this machine can reach the person); `GET` reports `offersLive`, `offered`, `inUse`; `applyYes` shared by the confirm page and the yes tap; `maybeOfferList` runs after each regular check (five minutes): resume a pending list, or build a new one at most weekly, `verify` each candidate once to find rows already in use (`inUse` in setup state), write pending rows, send, add taps, write offered rows from the message id; a refused send leaves the rows pending and retries after `OFFER_RESEND_AFTER_MS` (an hour). The tap handler: a no records `no` (reason none, shutdown none, origin `first-offer`), spends the button and every button for that service, voids open confirm pages, and is bounded; a yes needs `fromIsOwner`, a `wayIn` row, an owner and reach, then `applyYes`.
- `TelegramAdapter.ts`: `sendOfferList(topicId, text, buttons)` (one button per row, returns the message id), `setRecommendedOfferHandler`, and the `rs:` branch in `processCallbackQuery` (owner principal from `getConfiguredApprover`, passed as `fromIsOwner`; the handler decides).
- `routes.ts`: the switch from config; the send to the lifeline topic inside the notification envelope; `linkBase` = the tunnel's external URL, else `http://<primary LAN ip>:<port>`, else null; the handler registered on the adapter. `types.ts`: `recommendedServices.offers.enabled`. `setupState.ts`: `inUse`. Dashboard model: "Offered, not answered", "Already in use here". `CapabilityIndex` and the CLAUDE.md section (v3 wording, migrated in place once).

## Decision-point inventory

- `offersLive()` — add — deterministic preconditions; false holds everything.
- `offerCandidates` — add — deterministic row selection.
- in-use check (`verify` pass → skip) — add — the recipe's own check; unknown keeps the row (spec).
- tap handler — add — S-class no (bounded), P-class yes (owner-only, address services only).
- weekly cap and hourly resend — add — fixed constants.

## 1. Over-block

- An owner who answers nothing is never asked again by message: the row stays "Offered, not answered" on the dashboard. The spec chooses this ("silence is never a yes or a no"). A later real problem (rollout step 4) is the only way back by message.
- A service that becomes available after the list waits up to a week for the next one (the weekly cap counts a pending list too, so a list in flight delays the next).
- A no tap is refused past ten an hour with "Too many answers this hour"; the dashboard still takes a no. Deliberate (telegram-button-approval §1: S taps must be rate-bounded).
- No address and no `wayIn` row: the message says a yes needs the dashboard once there is an address, which is the honest state, not a dead link.
- Multi-machine agents: `offersLive` does not itself check `replicating`; the lease check keeps one sender, and the spec's fleet stage requires replication before offers go on there. Recorded as a rollout gate, not code: the switch is per agent and the maturation plan says when it may go on.

## 2. Under-block

- The yes tap's owner check is the Telegram owner principal (`getConfiguredApprover`), the same proof the tunnel-consent tap uses, and the handler re-checks `fromIsOwner`. The nonce is single-use and bound to one service. A forged tap from a non-owner records nothing.
- A no tap needs no owner: anyone in the owner's conversation can refuse a service. Bounded to ten an hour, undoable on the confirm page (a later yes supersedes the no). The way back is on a route a forged tap cannot reach (the PIN page), as §1 requires.
- A crash between the send and the `offered` rows repeats one list (the pending rows are resumed after an hour). Accepted by the spec. If the `offered` write itself keeps failing while sends succeed, the list is resent hourly until the pending rows expire (a week); every such failure is reported as a degradation. Recorded.
- The yes tap's owner check is the configured Telegram owner (`getConfiguredApprover`), while the list goes to `owner()`, which also resolves from verified topic operators. On an install with no configured owner but a verified operator, a Yes button is shown and always refused ("Only the owner can say yes"); the page still works. Over-block, recorded.
- The yes tap uses the catalog text current at the tap, not the text in the message; it refuses a service no longer available. A changed text between list and tap is accepted (the list is at most a week old and the spec's text-change refusal is a page-binding rule).
- Two machines both holding a lease is impossible by the lease's own guarantee; a lease move between pending and offered rows makes the new holder resend once. Accepted by the spec.
- The in-use probe runs each recipe's `verify` once per candidate per list build, at most weekly. With nothing stored, Bitwarden, GitHub and Jev fail fast; Tailscale reads the local program (10 s cap). With credentials stored, a check can make a few API calls (GitHub, Jev, 15-20 s each) or, for Bitwarden, run the CLI synchronously (up to about 45 s). Nothing is written or spent; these are the checks' existing costs, now also run unprompted at most once a week. The attempt is stamped before the probes, so a failing ledger write costs one try an hour, not one a tick.

## 3. Level-of-abstraction fit

The list is built and sent by the server, not a session: sessions cannot prove delivery, and an unprompted LLM message would pass the tone gate's judgment on every send. The offer rows ride the existing signed ledger so replication and merge come for free and no second store appears. The taps reuse the callback dispatch and owner check already there for tunnel consent; the yes path reuses the confirm route's exact code (`applyYes`), so a button yes and a page yes are the same yes.

## 4. Signal vs authority compliance

- [x] Yes, with care — the yes tap creates authority (a grant that starts setup). It is the P-class tap the spec argues for ("Reaching the page"), restricted to the owner principal and to `wayIn` rows, and the recipe cannot finish without the person's own sign-in through the link. The no tap moves toward less action and is undoable. No model judges anything here. Reference: `docs/signal-vs-authority.md`.

## 4b. Judgment-point check

No heuristic at a competing-signals point: every decision is a fixed predicate (switch, flag, first result, lease, owner, choice state, offer state, verify pass).

## 5. Interactions

- **Shadowing:** a no from any surface (the list's button, the confirm page, the plain no route) spends the list's buttons and the open confirm pages for that service; a yes from either surface spends the buttons. Pinned by "a no on the page or the plain route spends the list buttons".
- **Double-fire:** `offerState` reads `offered` rows from every machine, so a resent list after replication catches up is impossible for a service already offered; `lastOfferAttemptAt` and the weekly cap bound the sender.
- **Races:** the regular check's timer does not wait for a slow tick, so `maybeOfferList` holds an in-process `offering` flag: a tick that finds a build running skips (second-pass finding; pinned by "two overlapping ticks send one list"). A tap during a send sees no nonce yet and answers "used or expired", and the dashboard works.
- **Legacy declines:** imported `legacy-import` rows keep a service out of the list (`legacyDeclined`), as the spec requires.
- **The setup reconcile:** unchanged; `reconcileAndOffer` runs the list after it, so a yes recorded by a tap starts setup through the same `beginSetup`.

## 6. External surfaces

- One new unprompted Telegram message per owner, at most weekly, only with the switch on; its buttons; the per-row `offered` / `inUse` fields and `offersLive` on `GET /recommended-services`; the dashboard words.
- Config key `recommendedServices.offers.enabled` (default off; absent means off). Turning it off stops sends at the next check; turning it on never resends `offered` rows.
- The CLAUDE.md section's v3 wording for every agent on update (in place, once).
- **Operator surface (Mobile-Complete):** everything the person does is a tap or the PIN page from a phone; the switch is a config value until a dashboard control exists (recorded; the maturation plan turns it on per stage by the development agent, not by the owner).

## 6b. Operator-surface quality

The message leads with what it is and that nothing happens without a yes, one row per service in plain words, the confirm link or the honest reason there is none, a No button per row, and closes with "Not answering is fine too". No command, file path, config key or secret name appears in it (a unit test checks the words).

## 7. Multi-machine posture

- **Offer rows:** `unified`, in the existing replicated ledger kind (same signing, same reconciler registration); every machine folds the same `offerState`.
- **Sender:** one voice through the lease holder (`canReachOwner` requires the lease). A lease move can repeat one list; accepted by the spec.
- **Taps:** machine-local by design (`machine-local-justification: physical-credential-locality`): the nonce store lives on the machine that sent the message and holds the poll; a tap after a lease move answers "used or expired" and the dashboard works.
- **`inUse`:** per machine (a working install is a fact about one disk).
- **Fleet stage:** offers on a multi-machine agent need the replicated store on, which the route's `replicating` reports; the switch stays off there until then (rollout).

## 8. Rollback cost

A revert removes the sender, the taps and the fields; offer rows already written are ignored by older code (unknown `type` fails `validateRow`, so they are dropped on read and never break the choice fold). Choices made from taps are ordinary `choice` rows and stand. The CLAUDE.md v3 wording stays until a later migration; the switch key is ignored.

## Live proof (2026-11-08 00:18–00:23Z, throwaway `recsvc-bw-agent`, port 4461, built from this branch; real Telegram test group; Echo as the person)

| Step | Evidence |
|---|---|
| Switch on (`recommendedServices.offers.enabled: true`), server restarted onto this build; `offersLive: true` (first result and migration flag already present) | `GET /recommended-services` before the list |
| The list arrived **unasked** in the owner's conversation, 7 s after boot: Tailscale and Jev (the two available, undecided services; Bitwarden and GitHub were already "no"), each with benefit, what leaves, cost, account, backup and its confirm link, one No button each | msg 116, `offers-list-arrived.json` |
| Pending rows before, `offered` rows with messageId 116 after | `offers-rows-final.txt` (4 offer rows) |
| "No to Tailscale" pressed as the person → answer "No to Tailscale. I won't ask again without a real reason."; choice `no`, origin `first-offer` | `offers-tap-no-tailscale.json`, `offers-rows-after-no-tap.txt` |
| Same button pressed again → "That button has been used or has expired." | `offers-tap-no-tailscale-repeat.json` |
| Yes to Jev through the list's confirm link with the PIN → setup topic opened, the session explained the cost up front and asked only a decision (whose account) | `offers-jev-yes-response.json`; msgs 117–118, `offers-jev-setup-started.json` |
| No to Jev on the plain route → setup session ended, nothing spent | `offers-jev-no-after-setup.json` |
| No second list on the next regular check (00:23Z): both rows `offered`, weekly cap | group read at 00:24:30Z, `offers-no-second-list.json` (0 lists after msg 116) |

Found in the proof, fixed here: a yes through the list's link was recorded as `person-asked`; a page opened for an offered, unanswered service now mints origin `first-offer` (integration test pins it). Evidence folder: `.instar/lanes/bitwarden-recipe-1107/offers-*`.

## Class-Closure Declaration

- `unbounded-self-action` → closure `n/a` (negative declaration). Reason: the list is one send per owner per week at most, each service offered once for ever (`offered` rows), a refused send retried once an hour and released after a week; the taps are user-driven, single-use and rate-bounded. Not a self-triggered loop.

## Found problems, triaged

- The confirm-link base for a person on the home network is the primary LAN address; a person away from home with no tunnel gets a link that only works at home. The message says so only implicitly. → the Tailscale row is the fix the spec names; recorded, no change here.

## Second-pass review

Independent read (reviewer subagent, 2026-11-07), tests run: double-send paths each repeat at most one list as stated; taps correct (a forged or spent nonce dies before the hourly counter; a non-owner's yes never reaches `applyYes`); `applyYes` is the removed inline code verbatim plus the button spend; migration flag and first result honored per owner.

**Concern raised:** the five-minute timer has no reentrancy guard, so two overlapping ticks could both send a list; the artifact's "the timer awaits" was false. **Resolved:** `offering` guard, test added, §5 corrected.

Notes taken: buttons now spent by the page no and the plain no route too (test added); the attempt is stamped before the probes; the yes tap refuses an unavailable service; §2 now states the probes' real cost, the owner-principal gap and the persistent-write-failure bound; the ELI16 says "at worst once" instead of "never". Recorded, no change: the yes tap binds the current catalog text, not the message's.
