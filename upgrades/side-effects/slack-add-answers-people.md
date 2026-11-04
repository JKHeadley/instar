# Side-Effects Review — `instar add slack` sets up an agent that people can actually talk to

**Version / slug:** `slack-add-answers-people`
**Date:** `2026-11-03`
**Author:** `Echo`
**Tier:** 1 (narrow bug fix; a revert fully undoes it). Size: 3 source files + 1 test file, about 150 lines. Effort: no spec rounds, one commit attempt planned.

## Summary of the change

The customer-shaped cloud proof (topic 136880, fresh Ubuntu server `instar-proof-1`, agent `nimbus`, 1.3.1632) connected Slack with `instar add slack` and found that no person could talk to the agent. Three defects, each proven live:

1. **The only authorized user was the bot itself.** `slack-cli.ts` stored `authorizedUserIds: [auth.test.user_id]`, and with a bot token `auth.test` returns the bot's own user id. The adapter is fail-closed, so every human message was dropped, silently. Now the installer lists the workspace's members (`users.list`, `users:read` is already in the required scopes) and offers a default: the only real person in the workspace, else the primary owner, else nobody. The person can press Enter to accept, or type member ids (`U…`/`W…`); the bot's own id is refused. With nobody named it says plainly that every Slack message will be ignored. The summary line now names who the agent listens to.
2. **A person could not DM the agent.** The generated manifest had no `app_home` block, so Slack made the Messages tab read-only (`restricted_action_read_only_channel`). The manifest now turns the Messages tab on and writable (`home_tab_enabled: false` as before).
3. **The agent refused every Slack session until its next update.** The Slack reply relay (`.instar/scripts/slack-reply.sh`) is installed by `init` and by `PostUpdateMigrator` only when Slack is already configured, so an agent that adds Slack later logged `spawn refused: slack-relay-not-ready` for every message. `instar add slack` now installs it through the same `ensureSlackReplyRelay` installer (`loadRelayTemplate` from `init.ts` is exported for that) and prints a plain warning if it cannot.

Existing agents: a new start-time signal in `SlackAdapter` (`reportBotOnlyAuthorization`) says loudly, through `DegradationReporter`, when the bot is the only authorized user, and how to fix it. It never changes who is authorized. Existing agents already get the relay on their next update (the migrator's existing step); the live proof confirmed `instar migrate` installs it.

## Decision-point inventory

- Who a new Slack agent answers — modify — a person chosen at setup, never the bot.
- Whether people can DM the agent — modify — the manifest allows it.
- Whether the relay exists after `add slack` — modify — installed at once.
- Start-time signal for bot-only authorization — add — signal only.

## 1. Over-block

None added. The authorization list can only gain real people; the default picks one person (the sole human or the primary owner), which is narrower than "everyone". A workspace with several people and no owner flag gets an empty list and a clear message, the same fail-closed behavior as before, now explained.

## 2. Under-block

The default trusts Slack's `is_primary_owner` flag in a workspace with several people. In a company workspace where a member (not the owner) installs the app, the default would be the owner, not the installer; the prompt names that person and asks for Enter or other ids, so the installer sees it before accepting. `users.list` failing leaves no default and asks for ids.

## 3. Level-of-abstraction fit

All three fixes sit in the one command that creates the Slack config (`slack-cli.ts`), using the existing relay installer rather than a second copy. The signal sits where the adapter already learns its bot id at start.

## 4. Signal vs authority compliance

The new adapter check is a signal (`DegradationReporter` + a console warning) with no blocking authority; authorization stays with the existing fail-closed allowlist. The installer prompt is the person's own choice, not a gate. Reference: `docs/signal-vs-authority.md`.

## 5. Interactions

The empty-list warning in the adapter is untouched; the new signal stays quiet for an empty list so the two never double-fire. `ensureSlackReplyRelay` is idempotent and SHA-provenanced, so a later `init`/migrate pass finds the relay current. Manifest change affects only apps created from now on.

## 6. External surfaces

The manifest an operator pastes into Slack changes (Messages tab on). `instar add slack` asks one more question. The adapter may report one more degradation at start for agents in the broken state.

## 7. Multi-machine posture

Machine-local by design: Slack config and the relay script live in each agent's own `.instar/`; Socket Mode runs on the machine that holds the Slack lease. Nothing here replicates or proxies.

## 8. Rollback cost

Revert the commit. Configs written by the new prompt stay valid (a list of real member ids); manifests already created keep their Messages tab, which is harmless.

## Evidence

- Unit: `tests/unit/slack-cli-authorized-users.test.ts` (14 tests: default picking incl. the live nimbus shape, bot never chosen, deleted/app users skipped, id parsing, manifest `app_home`, the start-time signal on both sides).
- Live (instar-proof-1, 2026-11-03): with the bot as the only authorized user, a DM from the workspace's person was ignored with no log line; with the Messages tab off the DM was refused by Slack; with the person authorized and the relay missing, the server logged `spawn refused: slack-relay-not-ready`; after authorizing the person, enabling the tab and installing the relay, the DM "round-trip test three" got the agent's reply in 18 s.
