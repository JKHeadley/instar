# Side effects: re-offer after a real problem (rollout step 4, reason 1, voice-unreadable)

**STANDARD.** About 10 source files: a new pure module `src/recommended/reoffers.ts`, a `reoffer` row type in the signed ledger, route wiring, a config type, and a signal in the shared voice transcription wrapper plus two channel call sites. New unit, integration and e2e tests. Ships dark.

## Summary
`src/recommended/RecommendedServicesLedger.ts` gains `ReofferRow` (`event` / `pending` / `offered`, exact validation, `evidenceRef` a fixed token, never text). `src/recommended/reoffers.ts` is the deterministic floor from docs/specs/recommended-services.md ("Re-offering after a no" reason 1, "Real-problem events"): the choice must be `no` or an unanswered delivered offer, the problem after it and fresh (30 days), per kind+service cool-off 90/180/360, one re-offer a day across services, spent on delivery, reservations released after 7 days. `recommendedServiceRoutes.ts` adds `handle.recordProblem(kind, evidenceRef)` and a send step after the first list on each regular check. `VoiceTranscription.transcribeAudioFileDetailed` signals `voice-unreadable` on `TranscriptionUnavailableError`; WhatsApp's pre-check path signals too.

## Phase 1: decision point?
Yes: when to message a person who said no. Deterministic only, no model. reofferJudge (reasons 2 and 3) is not in this change.

## 1. Over-block
A problem during a cool-off is not queued for its end; it simply doesn't count. A later problem after the cool-off asks. This is stricter than "waits", deliberately, so a stale problem never surfaces months later.

## 2. Under-block
A crash between send and the delivered row can repeat one re-offer (accepted in the spec's Bounds). Other problem kinds (address down, every AI door down, lost secret, state loss) are not wired yet, so those problems don't re-offer.

## 3. Level-of-abstraction fit
Rules are a pure function over the replicated ledger, so every machine reaches the same answer. Sending reuses the first list's sender (`sendOfferList`, no buttons) and its reach check.

## 4. Signal vs authority
Signal only. A re-offer never changes the choice fold; only a confirmed yes does. The voice signal never throws into a channel.

## 5. Interactions
Shares the regular check's tick with the first list; separate in-flight guard and one-hour resend wait. Older versions reject the new row type at ingest (`invalid`), so a mixed fleet just ignores re-offer rows; no choice is affected.

## 6. External surfaces
With the switch on: at most one Telegram message a day to the owner's lifeline topic. With it off (default): none.

## 7. Multi-machine posture
Rows replicate with the existing `recommendedServices` store. Any machine records a problem; only a machine that can reach the person (lease and channel) reserves and sends. A new holder resumes a reservation.

## 8. Rollback cost
Turn the switch off, or revert. Rows already written stay in the ledger and are ignored by older code.

## Slice B: `secret-lost` (boot check)
`findUnresolvedSecrets(config)` in `src/recommended/reoffers.ts` walks the loaded config (bounded depth 8) for `{ "secret": true }` placeholders that survived the merge with the encrypted store. `recommendedServiceRoutes.ts` runs it once per server start (first tick with a ledger and an owner) through the new `unresolvedSecrets` dep and records `secret-lost` / `boot`, which re-offers Bitwarden under the same floor. Paths never reach the ledger or a message. Checked against the live Echo config: no false positive (zero unresolved). Over-block: a secret lost mid-run is only seen at the next start. Under-block: the CLI restore marker named in the spec is not built here; it lands with `state-loss-risk`. A check that throws is reported under `RecommendedServices.reoffer` and that start isn't counted. Dark behind the same switch.

## Slice C: `state-loss-risk` (restore marker)
New `src/core/restoreMarker.ts` (`state/restore-marker.json`: time and snapshot id only). `BackupManager.restoreSnapshot`, used by both the CLI restore and the restore route, writes it after the file copy; a write failure only warns and never fails the restore. The routes' boot check reads and clears it once per start, even with the switch off (so an old restore is never dug up later), and with the switch on records `state-loss-risk` / `restore` when the marker is under 30 days old, `github-state-backup` has no verified pass on this machine, and the pool lists no other machine (unknown self id counts every machine, leaning to "a copy exists"). Over-block: a restore on a multi-machine agent never asks, by design. Under-block: a restore done by hand-copying files leaves no marker. All existing BackupManager tests pass unchanged.

## Slice D: `address-repeatedly-down` (tunnel give-ups)
`routes.ts` subscribes to `TunnelManager`'s `lifecycle` event and calls `recordAddressOutage()` on each transition into `exhausted` (from another state). The handle keeps the last outage times per machine in `state/recommended-service-setup/address-outages.json` (at most 3 numbers; reset after a problem), so a restart keeps the day's count. Three within 24 h records the problem. `ProblemKind.alternate` + `serviceForProblem`: Tailscale first, Cloudflare once Tailscale is a yes or this kind already re-offered it, nothing once both are yes. With the switch off, outages are not even counted. Under-block: the spec's new Tailscale health probe is not built, so an agent whose address is Tailscale itself never trips this.

## Slice E (part 1): `provider-exhausted` + setup with no model
New `src/recommended/noModelSetup.ts`: `everyDoorDown(enabled, poolAccounts)` (true only when every door the agent uses has pool accounts and none is `active`/`warming`; no pool → never), `noteDoorsSample` (30-minute episodes, two in 7 days), and `runSecondDoorWithoutModel` (fixed steps). The routes sample on each regular check into `state/recommended-service-setup/doors-down.json` (per machine). `beginSetup` asks `everyDoorDown` before starting a session; when every door is down and the service has fixed steps (today only `second-ai-door`), the run happens in-process under the name `no-model:<service>`, which `isRunning` honours so the regular check doesn't double-start it; on `pass` the recipe's own check is recorded. Messages from it go through `sendOfferList` (the offer path, always delivered to the owner) because a sign-in link is something the person must act on, falling back to `tellOwner`. Install runs `npm install -g <door package>` (5-minute limit, no sudo); sign-in reuses `FrameworkLoginDriver` in a tmux pane with `BROWSER=true` and the default home (the machine user's login, which the recipe already treats as shared). Only one-tap device-code sign-ins (Codex) are attempted; Claude's paste-back flow says so and waits for a provider. With no address, `nextReoffer`'s new `hold` option skips this kind without blocking the others. Over-block: an agent without a subscription pool never trips it. Under-block: a Telegram-only agent with no address waits until part 2 (no-model Tailscale).

## Slice E (part 2): an address first, set up with no model
With no `linkBase`, `maybeAddressFirst` sends, once per `provider-exhausted` event (ids kept in `state/recommended-service-setup/address-first.json`, last 20) and only while Tailscale's choice is `unset`, a fixed-words message with one owner-only `rs:y:` button for Tailscale (the first list's existing address-service tap path, so non-owners are refused and a used or expired nonce answers as before). It is not a re-offer of Tailscale and never touches a no; the `provider-exhausted` event stays waiting and sends its own yes link once an address exists. This message is outside the one-a-day re-offer cap, bounded by once per event. A Tailscale yes while every door is down runs `runTailscaleWithoutModel` via `noModelSetup('tailscale')`: on a Mac, `brew install tailscale` and `brew services start tailscale` (no sudo), then `tailscale up` in a tmux pane, scraping only the public `https://login.tailscale.com/...` link; the person's own tap is the sign-in (never an auth key). Linux needs sudo for the installer and operator rights, so without a model it reports the need plainly and fails, and the bounded restart tries again once a door is back. `TAILSCALE_PROGRAMS` is now exported from `recipes.ts` (read-only list). Every other recommended-services test file passes unchanged.
