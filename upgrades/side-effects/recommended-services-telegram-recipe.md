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
