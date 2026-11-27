# Side-Effects Review — Telegram setup recipe (dark), a channel written by the server

**Tier 2 by risk** (a bot token stored in the agent's messaging config; a new channel the agent will read and write; the person's own Telegram login driven by the agent; a planned restart), with second-pass review. Spec: `docs/specs/recommended-services.md` (catalog row `telegram`, `wayIn`; Yes; No "Never strand the owner"). ELI16: `docs/specs/recommended-services-telegram-recipe.eli16.md`. Dark: the catalog row keeps `setupRecipe: null`; only a proving agent reaches it.

**Size:** 4 source files (1 new), 4 test files (2 new); about 160 lines of source. **Effort:** no spec rounds; 1 commit attempt expected.

## Summary

- `telegramSetup.ts` (new): `TelegramSetupSurface` (configured, probe, write, disable, requestRestart), `probeTelegram` (Bot API `getMe` then `getChat`; `ok` only for a forum; `token-refused`, `chat-unreachable`, `not-forum`, `unknown`), `readTelegramEntry`.
- `recipes.ts`: `telegram-v1` (`secretName: null`): brief (the person's own Telegram, signed in by them; phone number and login code through Secret Drop; BotFather `/newbot`, `/setprivacy` Disable, `/setjoingroups` Enable; group with topics, bot as administrator; proof with the Bot API; the key route call; the bot limit stop; never delete a bot; never print the token); `verify` reads the entry and probes; `stop` disables (keeps the entry), requests a restart, only when setup made it.
- `recommendedServiceRoutes.ts`: the key route's Telegram branch: token shape and supergroup chat-id shape validated, a working entry the person had refused (`already-held`), **the server proves the token and group with the Bot API before anything is written** (`telegram-refused` with the reason otherwise, so a bad token is never stored or restarted into), the entry written, `signedInBySetup` recorded at write time, a planned restart requested, `{ stored, restarting }`.
- `routes.ts`: the real surface over `ctx.config.messaging` (`writeConfigAtomic`; a fresh config object, so an old entry's topic ids never carry over), `probeTelegram`, and `ctx.requestSupervisedRestart`. `ctx.config` is read once at boot, so the surface remembers the entry it wrote or disabled until the restart (second-pass finding).

## Decision-point inventory

- `telegram-v1.verify` — add — pass/fail/unknown from the Bot API.
- key-route Telegram branch — add — refuses a replacement of a working entry; validates shapes.
- `stop` — add — disable + restart, under the routes' existing way-in hold.

## 1. Over-block

- Only a supergroup id (`-100…`) is accepted: the brief turns topics on before reading the id, and a basic-group id would be wrong anyway (the id changes when topics are turned on).
- A Telegram the person had (an enabled entry present before setup, `absentBeforeSetup` not set) is never replaced, even if its bot is broken; the check then fails with the bot's reason and the setup session is told to stop. Deliberate: a working or half-working channel is the person's. A *disabled* entry the person had is theirs too: the check fails without `absent`, so setup never counts the channel as its own and a later no leaves it as it was.

## 2. Under-block

- The person's Telegram login lives in the browser profile the setup session drives; the brief ends with signing the browser out of Telegram Web. The installer's own Telegram phase (`buildTelegramAgenticPrompt`) has no sign-out and no `/setjoingroups` step; noted for its owner. The brief follows the installer's privacy, topics and administrator steps and adds those two.
- The session never holds the token outside the one call to the key route: no session-side Bot API calls, the chat id read from the browser's address bar; the server does the proof (second-pass finding).
- The token is written into `config.json` as a plain value, exactly as the installer writes it; the pairing migration moves config-held secrets to the vault later. Pre-existing shape.
- The restart is a request to the supervisor (`restart-requested.json`); a foreground server with no supervisor restarts when its watcher sees the flag. If neither picks it up, the channel starts at the next restart and the check still reports the Bot API's answer.

## 3. Level-of-abstraction fit

The channel write and the restart request are server work (a session must never edit `config.json` or write the restart flag); the probe is the Bot API's own read-only calls; the bot and group creation stay in the session, where the installer's proven steps already live.

## 4. Signal vs authority compliance

- [x] No — no block/allow surface over content. Reference: `docs/signal-vs-authority.md`.

## 4b. Judgment-point check

No heuristic at a competing-signals point.

## 5. Interactions

- **Way in (`wayIn`):** the routes hold a switch-off until `otherRouteWorks('telegram')` (today: Slack configured), telling the person once; the hold is retried on every regular check and can be permanent on an agent with no other channel, which is the parent's "never strand the owner" rule; the app and dashboard do not count as another route today. Pinned by the integration test.
- **Lifeline and poll ownership:** a new entry starts polling only after the restart, so no second poller races the running one.
- **Offers:** the row becomes available only after the flip; dark here.
- **The installer:** unchanged; the recipe reuses its steps by description, not by code.

## 6. External surfaces

- Dark on the fleet.
- On a proving agent: a bot and a group created in the person's Telegram; this agent's `messaging[]` entry written; one planned restart.
- `POST /recommended-services/telegram/key` with `X-Telegram-Chat-Id`.
- **Operator surface (Mobile-Complete):** yes/no on the confirm page; phone number and login code through Secret Drop; nothing API-only.

## 6b. Operator-surface quality

The session's closing message says the Telegram is ready and that the agent greets them there after it restarts; the bot-limit stop is one sentence naming what still works.

## 7. Multi-machine posture

- The messaging entry is **per machine by design** (`machine-local-justification: physical-credential-locality`: the bot token plus the forum/topic ids it namespaces are the credential the parent's own posture names), as the installer's is. A second machine of the same agent joins the same bot through the pool's lease, not through this recipe.
- The choice replicates through the existing ledger.

## 8. Rollback cost

A revert removes the recipe and the key-route branch; an entry already written stays and keeps working (it is an ordinary messaging entry). Setup-state fields are ignored by older code.

## Class-Closure Declaration

- `unbounded-self-action` → closure `n/a` (negative declaration). Reason: one restart request per key write or switch-off, both on a person's action through the routes; the probe runs on the existing bounded setup schedule. Not a self-triggered loop.

## Found problems, triaged

- The person's Telegram Web session remains in the browser profile after setup → the brief now ends with signing out; the installer's identical gap is noted for its owner.

## Second-pass review

Independent read (reviewer subagent, 2026-11-08), tests run. Token leak paths otherwise clean (the probe swallows every throw; the key body is stdin; `express.text` is mounted); regexes correct for real tokens and supergroup ids; a plaintext token written beside a vault placeholder wins at boot; the restart flag is picked up by the foreground watcher within ten seconds; the way-in hold releases only when another channel appears.

**Concern raised:** (1) the real `configured()` read `ctx.config`, which is never reloaded, so the check could not pass and a no could not disable the entry until the restart; (2) the brief had the session call the Bot API itself, which put the token in URLs (argv and transcript). **Resolved:** the surface remembers the entry it wrote or disabled; `signedInBySetup` is recorded at write time; the server runs the Bot API proof before writing and refuses otherwise; the brief drops every session-side Bot API call and reads the chat id from the address bar. Notes taken: a fresh config object on write (no stale topic ids); a disabled pre-existing entry is the person's (recorded above); the hold can be permanent (recorded); the ELI16's token sentence corrected.

## Amendment (live proof, 2026-11-08): an agent with no Telegram can set Telegram up

**Defect found in the live proof.** On a fresh agent with no Telegram (the audience this recipe is for), the confirm page answered `canSetUp: false` and a yes with the PIN returned `409 cannot-reach-you`: the reach check required an existing Telegram, and `startSetup` threw without one. The recipe could never start where it was meant to.

**Fix (Tier 1, 3 source files, about 20 lines).** `canReachOwner` takes the service: Telegram's own setup is reachable without Telegram (the lease still holds it); every other service still needs Telegram. With no Telegram, `startSetup` for `telegram` spawns the setup session with no topic, so it shows in the dashboard's session list (the catalog's named backup); any other service still throws as before. The brief gains one line: with `$INSTAR_TELEGRAM_TOPIC` empty, talk to the person in this session and take secrets only through Secret Drop. Offers are unchanged (`offersLive` still uses the Telegram-only reach).

1. **Over-block:** none added. A Slack-only agent still cannot start other recipes (unchanged).
2. **Under-block:** a person on a no-Telegram agent reads this setup only on the dashboard; there is no push notice. Acceptable: the yes itself came from the dashboard's confirm page.
3. **Level:** the reach rule lives in the one wiring point and the route consumer; no new gate.
4. **Signal vs authority:** no new blocking authority; one existing refusal is narrowed for one service.
5. **Interactions:** the tap handler and the restart loop use the same per-service reach, so a no-Telegram agent's Telegram grant gets the same bounded restarts as any other.
6. **External surfaces:** `GET /recommended-services/telegram/confirm` reports `canSetUp: true` on a no-Telegram agent.
7. **Multi-machine:** unchanged; the lease condition still applies.
8. **Rollback:** a revert restores the refusal; a setup state with no `topicId` is read as before.

Tests: integration (no-Telegram yes starts setup with no topic; Jev on the same agent still refused, red before the fix), wiring and brief assertions; 25 files, 282 tests green.

### Second live-proof defect: no reply script on an agent that gained Telegram later

**Found:** after the restart the agent read the person's message (Lifeline msg 6) and started a session, but the session could not answer: `telegram-reply.sh` is installed only by `init` when Telegram already exists (and by the join flow), so an agent made without Telegram never had it. The session said so itself in its terminal.

**Fix:** at server boot, when an enabled Telegram entry exists and neither `.claude/scripts/telegram-reply.sh` nor `.instar/scripts/telegram-reply.sh` exists, write both with the existing `installTelegramRelayForJoinedMachine` (the joined-machine installer). The recipe always restarts after writing the entry, so the script is there before any session needs it. A hand-added Telegram entry is covered the same way.

1. **Over-block:** none; nothing is refused.
2. **Under-block:** a script that exists but is broken is not repaired here (the update migrator owns that, as before).
3. **Level:** boot, beside the app-reply relay install; the installer is the existing one.
4. **Signal vs authority:** no decision point.
5. **Interactions:** never overwrites an existing script, so a customised one and the migrator's always-overwrite path are untouched.
6. **External surfaces:** one new file pair in the agent home when Telegram is configured and the script is missing; one boot log line.
7. **Multi-machine:** per machine, like the installer it reuses; each machine's boot checks its own home.
8. **Rollback:** revert; a script already written stays and keeps working.

Live result after both fixes: message 6 answered as message 8 (03:22:42Z).

**Second-pass review of the amendment (reviewer subagent, 2026-11-09):** reach is unchanged for every service except Telegram (offers, tap handler, restart loop and `canSetUp` all pass the service id; Telegram still needs the lease); the no-topic setup state is guarded where a topic is read; the boot install runs only when both scripts are missing, inside the async `startServer`, and reports a failure without stopping boot; no token path touched. Concur with the review.
