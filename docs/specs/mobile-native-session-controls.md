---
title: "The app's session screen reaches the dashboard's controls"
slug: "mobile-native-session-controls"
author: "echo"
parent-principle: "Know Your Principal"
eli16-overview: "mobile-native-session-controls.eli16.md"
status: "draft"
approved: true
approved-by: "echo, under Justin's request (Telegram topic 134088, 2026-11-05 13:45 PST: \"the session feature is missing some of the features that the dashboard has such as being able to change the door or model of the session or swap what machine it's running on or upload files directly to the session or any other of the dashboard features\")"
review-convergence: "2026-11-05T22:40:00.000Z"
review-iterations: 3
review-completed-at: "2026-11-05T22:40:00.000Z"
review-report: "docs/specs/reports/mobile-native-session-controls-convergence.md"
---

## 1. Problem

The app's session screen (`docs/specs/mobile-native-session-screen.md`) shows output and takes typing. The dashboard also sends keys, attaches files, shows history and details, switches the door and model, closes a session and starts one, and it reaches sessions on other machines. The server has a move-to-another-machine route that the dashboard has no button for. Justin asked for all of this on the phone. The gap table is `.instar/lanes/app-session-parity-1105.md`.

## 2. What exists

- `mobileSessionTerminalRoutes.ts`: device-only `output` and `input` for owner phones, this machine only. A later note in that spec said a device-signed hop between machines "is not requested and is not part of this change". Justin has now asked, so this spec adds it.
- The dashboard's routes: `POST /sessions/:name/attachments`, `GET /sessions/:name/transcript`, `GET /topic-profile/options`, `GET` and `POST /topic-profile/:id`, `POST /topic-profile/new-topic-default`, `POST /pool/transfer`, `DELETE /sessions/:id`, `POST /sessions/:name/remote-close`, `POST /sessions/create`, `GET /pool`, and the WebSocket `key` frame.
- `mobilePermissionsRoutes.ts`: the Face ID write gate, with one challenge store and one audit file, behind `mobilePairing.permissionActions`.

## 3. Design

**No second copy.** Each new route calls the dashboard's route with the server's token, on this server over loopback (the way `mobileHealthRoutes` and `mobileConsolePagesRoutes` read `/health` and console routes) or on the machine holding the session. That route's rules and refusals stay in force. The new code trims answers and words them plainly. Two exceptions run server code directly: the keys route calls `SessionManager.sendKey`, the function the WebSocket `key` frame calls, and the attachment route passes on to the dashboard's own handler with `next()`.

**What each action needs.**

| Action | Proof | Why |
|---|---|---|
| Keys tray (Enter, y, n, Esc, arrows), Stop (Ctrl+C), attach a file, typing | Device signature, owner phone. The app also asks for Face ID if the owner hasn't authenticated in the last 5 minutes (today's typing rule) | Ordinary use of a session you're already in. Stop interrupts a turn but ends nothing and is asked once in the app, as on the console |
| Switch door and model | Face ID over a single-use challenge bound to the action | It ends and restarts a live session |
| Move to another machine | Same | It ends the session here and moves the conversation |
| Close | Same | It ends a session |
| New session | Same | It starts a real process that costs money |
| Default door and model for new topics | Same | It changes what later topics run on |
| History, details, options | Device signature, owner phone. Secrets removed | Reads of what the owner's console already shows |

**Device routes.** All owner phones only, each in `DEVICE_ALLOWLIST`:

- `POST /sessions/:name/key {key}` (own bucket 60 per minute, plus a machine window of 60 per minute). `key` must be one of the tray's nine: `Enter y n Escape Up Down Left Right C-c`. No other tmux key name reaches tmux from a phone. Each signed press is written to the input replay record before it runs, so a captured press runs once.
- `POST /sessions/:name/attachments {filename, dataBase64}` (own bucket 12 per minute, and at most 200 MB per rolling hour on a machine across phones, because 12 files of 8 MB a minute is too much to hold for 30 days). The router re-resolves the session and its `sid`, writes an audit row with the size and no name, then `next()` to the dashboard's handler, whose 8 MB limit and file rules apply. Answers the saved path, as to the console. The app then sends the text with that path through `input`.
- `GET /mobile/sessions/controls?name&machine`, `GET /mobile/sessions/new-options?machine` (shared bucket 30 per minute).
- `GET /mobile/sessions/history?name&machine&before&limit` (bucket 60 per minute): up to 100 entries, each cut to 8,000 characters, with the token, the PIN and `sig=` values removed.
- `POST /mobile/sessions/door/:topic`, `/move/:topic`, `/close/:id`, `/new`, `/default`: `writeGate`, then `proven`, on the `permission-actions` bucket, with the challenge from `POST /mobile/permissions/challenge`.

**Action lines.** Every field that changes what runs is on the signed line, so a change to any of them breaks the proof:

```
session-door <topic> <machine|here> <framework> <model|none>
session-move <topic> <to> <confirmationChallenge|none>
session-close <sessionId> <tmux> <machine|here>
session-new new <sha256(name)> <platform> <framework|none> <model|none> <machine|auto>
session-default new-topic-default <framework|none> <model|none>
```

A framework, model or machine is one word matching `[A-Za-z0-9._:[\]-]{1,128}` and isn't `none`, `here` or `auto`, so a field can't add a word to the line or read as absent. Slack and no-chat sessions refuse a door, model or machine at signing, since the route would drop them, and a model needs a door. A machine named with no mesh id on this machine is refused, so a line never runs anywhere but where it says. A move's `to` must be a machine id in this machine's roster. An absent optional field is missing or the empty string. A topic is `[1-9][0-9]{0,15}`. A name is non-empty, equal to its own trim, at most 120 characters, with no control characters and no credential shape.

**Rules that stay in force.**

- A door or model switch goes through `POST /topic-profile/:id` and `applyWrite`, the topic lock and every refusal there. The route's own words reach the phone. That route takes pins the dashboard's menus don't offer, so the phone route first checks the pick against `GET /topic-profile/options` and refuses a door or model the menu wouldn't show.
- Door and machine apply to sessions with a Telegram topic, as on the dashboard. Others say so in the menu.
- A move goes through `POST /pool/transfer` with its checks: rate limit, offline target, and the consent prompt for a running autonomous job. The prompt reaches the phone, and saying yes takes a new Face ID over a line that includes the route's `confirmationChallenge`, so the yes covers exactly the conditions shown.
- Close keeps protected-session behaviour: the console's warning words appear, and a refusal says the agent kept it running.

**Another machine.** When a phone names another machine, this machine has already verified the phone. It then calls that machine with the pool token:

- `output`, `input`, `key`, `attachments`, `history`: new `GET` and `POST /mobile/sessions/relay/:name/...` routes. They take the pool token only; no allowlist rule lists them, so a phone gets `device-not-allowed`. That machine resolves the session against its own records and `sid`, removes its own secrets, and applies its own `dashboard.poolStream.allowRemoteInput` to typing, keys and attachments (the rule the console's relay follows) with its own rate windows. This machine removes its own secrets too, writes the replay record before sending, and audits. Not the Bearer `input` route: an older machine answers it without that rule, so an older machine gets a 404 from the new path and the phone gets the plain words that it needs the update.
- `attachments`: after that check, that machine's dashboard handler, so the file lands where the session can read it. A file is only useful with the typed message that names it, so it follows the typing rule.
- `history`: that machine reads its own record and removes its own secrets. The dashboard's transcript relay isn't used here, because only that machine knows its PIN, and a PIN opens the console without Face ID.
- Door: that machine's `POST /topic-profile/:id`. Close: the dashboard's `remote-close`. Move: `/pool/transfer` already goes through the machine holding the lease.
- That machine not answering gets a 503 with its name; the phone keeps trying. A token refusal from it is reported the same way, never as this phone being signed out.

## Decision points touched

| Decision | Classification | Justification |
|---|---|---|
| Allowlist admits the new routes for active owner devices | invariant | Route-level authentication by exact pattern, the existing device model |
| Write gate and presence proof for the five session actions | invariant | Reuses the merged gate unchanged; cryptographic proof, nothing to weigh |
| Keys limited to nine names | invariant | A fixed list matching the console's tray; a modified phone gains no tmux key names |
| Door or model not offered by the menu is refused on the phone route | invariant | Exact comparison with the dashboard's own option list; the console keeps its chat-pin path |
| Serving machine's `allowRemoteInput` | invariant | The existing boolean, applied at the relay routes as at the WebSocket |

## Verify the state, not its symbol

The move answer reads `seatMoved`, the transfer route's own measure, so "Moved" is said only when the seat moved. A door switch is shown as landed only when the session list shows a session started after the switch with the model chosen (the console's `switchLanded`). Until then the screen says switching, and after 3 minutes it says the new model hasn't shown up yet. A failed read of doors or machines says "can't read", never "none".

## Maturation plan

- **test-agent-live:** the unit, integration and e2e tests in section 6 on a real server boot, and the seeded simulator screens.
- **dev-agent-live:** after release, the reads and the unconfirmed routes run from Echo's own server. Face ID writes need a real phone: Echo does not switch a real session's door or machine in a test, so a door switch, a move, a close and a new session wait for a throwaway agent or for the owner's first use, recorded as unproven until then.
- **fleet:** the five Face ID writes ride `mobilePairing.permissionActions`, dev-gated: live on a development agent, dark on the fleet until that switch's rung moves. Reads, keys, attachments and the relay are live for owner phones, as typing is.
- **graduation criterion:** the switch's, plus one real door switch and one real move from a phone with audit rows.
- **dark-window:** the switch's.
- **ladder:** mobilePairing.permissionActions

## Open questions

*(none)*

## Frontloaded Decisions

1. Keys and attachments need the device signature and no server Face ID check, because they are conversation use. The brief named uploading as ordinary use, and Ctrl+C ends no session. The cost is that a modified app on the owner's phone could send Ctrl+C without the 5-minute check; it needs the Secure Enclave device key, which already lets it type.
2. Everything else that changes what runs needs Face ID every time.
3. The move button exists on the phone although the dashboard has none. Justin asked for it, the route is already public to the token, and it has its own consent prompt.
4. Door and move stay Telegram-only, as the dashboard's are. Rejected: widening to Slack keys here. `TOPIC_PROFILE_KEY_RE` accepts them, but the dashboard never offered them and nothing has proved them from a menu.
5. The chat's chunked media upload is not reused on the server: it binds to a conversation and a shared store, and the session needs a file on its own disk. The app reuses the chat's pickers. Limit 8 MB per file, the dashboard's.
6. The relay reverses the first session spec's "local sessions only". It needs no phone signature to travel between machines: the machine the phone reached verified it, and pool machines already trust each other's token for this data (the console's stream and History).

## 4. Security

Widened device access for owner phones: 3 reads, 2 signed writes, 5 Face ID writes. No new authority beyond what the PIN-unlocked console has, except the relay's reach, which is what the console's WebSocket relay already has.

- A stolen, unlocked phone can already type into a session. New without Face ID: nine keys and files up to 8 MB to a session, each audited. New with Face ID: the same as the console with the PIN.
- The saved file path is shown to the phone, as to the console. Files are saved mode 0600 by the existing handler.
- The relay routes take the pool token only and accept the same limits as the phone routes. A wrong `machine` value finds no listed peer and is never turned into a URL.
- With no mesh id here, a write naming a machine is refused rather than run on a same-named session here. A read can't do harm and keeps the first spec's behaviour (the parameter is ignored there).
- Replay: signed input and keys are in the durable record before they run, at the machine the phone reached.
- Removal is on string values only, so a secret that happens to appear inside a number can't corrupt an answer. Fields that name something (ids, times, a saved path, a route's binding) are left alone, since a short PIN can fall inside one by chance. Each route's words pass the same removal, since a move's prompt can quote a run's goal. The transcript route removes secrets before it cuts an entry, when asked to with `redact=device`, so no cut leaves part of one.
- Each phone route has a budget past the route it calls (`MOBILE_SESSION_MOVE_TIMEOUT_MS` 90 s, `MOBILE_SESSION_ACTION_TIMEOUT_MS` 45 s), so a long drain answers plainly and not with a 408 while the move still lands. The app waits past that too.
- `/topic-profile` writes are recorded as `api-token`, as the console's are. Attribution to the phone is in `state/mobile-permission-actions.jsonl`.

## 5. Multi-machine posture

- Output, input, keys, attachment, history: proxied through the machine the phone reached (named above). Door, close, move: run on the owner or the lease holder.
- The default door for new topics stays machine-local by design (`replication: 'local-only'`, as the dashboard says). machine-local-justification: operator-decided per-machine setting; the phone says "(this machine only)".
- Challenges: machine-local, as in the permissions spec. Replay and audit records: machine-local, on the machine the phone reached.
- No notices. No generated URLs.

## 6. Tests

- **Unit** (`tests/unit/mobile-session-controls.test.ts`): each action line, input refusals, the door and machine rows, the words for moves and closes, `summarizeControls` on both sides, `createBody`, peer-too-old classification. Parity: the allowlist coverage test lists every new route as owner-only.
- **Integration** (`tests/integration/mobile-session-controls.test.ts`, production `authMiddleware` + `deviceAuthenticator`): keys and attachments allowed for an owner, refused for MSP, unsigned, a bad key; replay; relay output, input, an input-off machine, an older machine, an unreachable machine; relay routes refused to a device; history redaction.
- **E2E** (`tests/e2e/mobile-session-controls-alive.test.ts`): production boot, real pairing and presence key, a throwaway mock session. Controls read 200, key 200, attachment saved on disk, history read, new session and close and default through real routes over real loopback, audit rows, not 403, 404 or 503.
- App: action lines (a shared vector), words, parsing, seeded simulator screens at phone size.

## 7. Agent awareness and migration parity

`generateClaudeMd()` gains one bullet; `migrateClaudeMd()` inserts it under a content-sniff guard on `GET /mobile/sessions/controls`; `CapabilityIndex` gets `mobileSessionControls`. No config, hook or skill change.

## 8. Rollback

Revert the commit. `mobilePairing.permissionActions` off stops the five Face ID writes at once; the app then shows the menu read-only with its reason. An older server answers `device-not-allowed`, and the app says it needs the update and hides what can't work.
