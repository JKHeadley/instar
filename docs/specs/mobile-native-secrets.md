---
title: "Native Passwords & keys screen for the Instar iPhone app"
slug: "mobile-native-secrets"
author: "echo"
parent-principle: "Know Your Principal"
eli16-overview: "mobile-native-secrets.eli16.md"
status: "draft"
approved: true
approved-by: "echo, under Justin's request (Telegram topic 134088, 2026-11-03 22:01 and 22:55 PST: the app should do every feature natively; the plan of record names Passwords and keys)"
review-convergence: "2026-11-05T00:44:47.529Z"
review-iterations: 6
review-completed-at: "2026-11-05T00:44:47.529Z"
review-report: "docs/specs/reports/mobile-native-secrets-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
---

## 1. Problem

Operator request (Justin, Telegram topic 134088, 2026-11-03 22:01 and 22:55 PST): the Instar iPhone app should do every feature natively. The plan of record (`.instar/lanes/app-native-coverage-plan.md`) lists Passwords and keys as a web view: "Bearer only; keep Secret Drop links as web pages".

A paired phone signs each request with its device key, and `deviceAuthenticator` admits only paths in `DEVICE_ALLOWLIST`. The console's page reads `/secrets/pending`, `/self-knowledge/session-context?full=1` and `/secrets/sync-status`, all bearer-only.

## 2. What exists

- `GET /secrets/pending` returns each pending request WITH its token and drop URLs. The token is the capability: whoever holds it can submit to that request. It must not be added to a phone route.
- `BootSelfKnowledge.sessionContext` returns vault key NAMES and a `vaultState`, gated by the dev-agent gate; `SecretSyncHandle.localKeyPaths()` is the console's fallback. A saved drop is stored under `secretDrops.<token>`: a name that carries a token.
- The merged mobile read pattern (#2706, #2712, #2725, #2728): trimmed routes, `ownerOrBearer`, `cleanText`, `rowKey`, `DegradationReporter`.

## 3. Design

One route, `GET /mobile/secrets`, in `src/server/mobileSecretsRoutes.ts`, one `DEVICE_ALLOWLIST` entry (`ownerOnly`, own 20-per-minute bucket), `Cache-Control: no-store`.

Answer: `schemaVersion`, `generatedAt`, `state` (whether any part could be read: `ok` when requests or keys answered, not a health verdict; `tone` carries that), `headline`, `tone`, and:

- `requests`: `state`, `waitingCount`, `expiredCount`, `truncated`, `waiting[]` of `{key, label, conversation, createdAt, expiresAt, soon}`. `key` is a one-way hash. Soonest first, 30 rows, true count kept.
- `keys`: `state` (`ok`, `decrypt-failed`, `off`, `unavailable`), `count` (keys held, taken before cleaning, not counting saved submissions), `names[]` (sorted, cleaned, de-duplicated, 200 rows), `savedDrops` (`secretDrops.<token>` entries, the console's exact pattern), `hidden` (other names withheld because they look like a token: a hex run of 16 or more, a UUID, or an opaque run of 32 or more; still counted as keys), `truncated` (the 200-row cap cut the list; names that clean to the same words show once, and `count` keeps them). The vault reads `decrypt-failed` when EITHER source says so: the route applies `deps.vaultBroken` (Secret Sync's vault status) over the inventory's own `vaultState`, tested in the integration suite. A vault check that fails makes the key section `unavailable`, unless it is already `decrypt-failed`.
- `sync`: `state` (`on`, `receive-only`, `off`, `unavailable`), `peers` as a count only.
- `peers[]` of `{machine, waitingCount, waiting[], truncated, keyCount, vaultBroken}`, plus `unread`, `offline` and `peersUnknown`: each online peer's `?scope=local` answer, rebuilt field by field (peer text is untrusted). A peer's key NAMES are not relayed, only its count. A wrong-shaped peer (missing section, unknown state, negative count) counts as not answering and is recorded. At most 10 peers.

Never in the answer: a value, a value's length, a token, a drop URL, a machine id.

Headline order: a vault that won't open; then waiting requests; then "can't tell" for a failed read, on any machine; then a key list that is switched off, with its own words; then the all-clear, which needs both reads to succeed and names saved submissions alongside keys. With a machine unread or offline the all-clear says "on the machines that answered" and its tone is `unknown`. A failed read is `null` counts, never zero. A peer whose keys couldn't be read also blocks the all-clear. A sync read that fails doesn't change the headline: sync isn't part of what's waiting or held, and its own line says it can't tell. A switched-off key list keeps tone `ok` because the headline then claims only that nothing is waiting, and says plainly the list is off; it makes no claim about the vault. Labels and conversation names have anything token-shaped replaced by "[hidden]". A vault state this code doesn't know is thrown and recorded as a failed read. One unreadable row makes that whole list `unavailable`: it could be the row that matters. A time no `Date` can hold is treated as unusable, never thrown on.

The app shows the screen read-only. A waiting request says to fill it in from the link the person was sent, because the phone never gets the link.

**Scope: this is a partial delivery of the row, on purpose.** The plan fixes only that Secret Drop links stay web pages. Asking for a key and cancelling a request are writes; a phone write here needs the Face-ID presence check the permission actions use (`mobile-native-permissions.md`), so they are not bundled into a read route. They stay in the console, and the app says so. The coverage plan row records them as still web.

## Decision points touched

| Decision | Classification | Justification |
|---|---|---|
| Device allowlist admits the one GET path for active owner devices | invariant | Route-level authentication by exact path, the existing deterministic device model; no competing signals. |
| `ownerOrBearer`: bearer or owner-role device only | invariant | Authorization from the authenticated principal's resolved role (Know Your Principal); fails closed for unresolved people. |
| Field allowlist, token-run rule for key names | invariant | A fixed redaction contract: only listed fields leave the server. A false positive only moves a name into the `hidden` count. |
| Headline order | invariant | Display classification that follows the console's order, deliberately stricter on one point: the all-clear needs the key list too, where the console says "nothing is waiting" from requests alone. Gates nothing. |

## Verify the state, not its symbol

No detector or gate on agent behaviour is added. The display states:

- Waiting count: symbol = rows in `SecretDrop.listPending()` with a future expiry. State claimed = requests a person can still fill. Corroboration: the same list the console reads. Unmeasurable: a failed or all-malformed read is `unavailable`, `waitingCount: null`, "Can't tell".
- Key names: symbol = the vault's key paths. Unmeasurable: `decrypt-failed` is its own state; `off` and `unavailable` have `count: null`, never "no keys".
- Sync: symbol = the sync handle's state and target list. Unmeasurable: `unavailable`; a peer count is a target count, not proof a sync worked, and the app words it as machines keys sync to.

## Maturation plan

No flag, by design: a read-only subset of what the owner reads in the console; a revert is the whole rollback.

- **test-agent-live:** the unit, integration and e2e tests in §6 on a real server boot, and the seeded simulator screens.
- **dev-agent-live:** after release, Echo drives the screen in the simulator app paired to Echo's own server and records PASS/FAIL; that recorded read is what stops the graduation check passing with no traffic.
- **fleet:** the route rides `mobilePairing.enabled`; the bearer path works regardless.
- **graduation criterion:** one week after release, the `MobileSecrets.read` degradation count (throws and wrong-shaped reads; a switched-off part is expected and not counted) is zero, and the dev-agent-live record passes.
- **dark-window:** none: the route is live on release.
- **ladder:** mobilePairing

## Open questions

*(none)*

## Frontloaded Decisions

1. A purpose-built trimmed route instead of allowlisting raw routes (same as the merged mobile reads).
2. Read-only (§3 scope note). Filling one in stays on the web, as the plan says; asking and cancelling stay in the console because they are writes that need the presence check.
3. Owner phones only.
4. The phone never receives a drop token or link. The person uses the link they were sent.
5. Waiting requests are read across machines; key names stay per machine (§5).
6. Key names are shown: the owner already reads them in the console. A name is not a value, and anything shaped like a token is withheld.

## 4. Security

- Widened device-key access: one read-only GET for owner phones: a trimmed subset of the console's three reads, plus each peer's trimmed count, which the console doesn't show. A stolen owner phone that passes the device check learns key names and request labels, not values and not the capability to fill a request.
- Raw routes stay off the allowlist (tests on both sides). MSP, revoked and unsigned requests are refused; a POST is refused by the device check.
- Labels and names pass `cleanText`, which scrubs credential shapes and caps length.

## 5. Multi-machine posture

- Pending requests: **proxied-on-read**: this machine's plus each online peer's `GET /mobile/secrets?scope=local`, each named. Who didn't answer is said, and the all-clear is scoped to the machines that answered.
- Key names: machine-local. machine-local-justification: physical-credential-locality. The vault is an encrypted store on one disk that physically holds credentials; replication is Secret Sync's job, and the answer reports its state. Peers contribute a count and whether their vault opens.
- No new durable state, no user-facing notices, no generated URLs.

## 6. Tests

- **Unit** (`tests/unit/mobile-native-secrets.test.ts`): both sides of each rule. Parity: `tests/unit/mobile-session-terminal.test.ts` lists the path as owner-only. Awareness: `tests/unit/mobile-native-secrets-claudemd.test.ts`.
- **Integration** (`tests/integration/mobile-native-secrets.test.ts`, production `authMiddleware` + `deviceAuthenticator`): owner trimmed, bearer, MSP, revoked, unsigned, POST, raw routes closed, a throwing read.
- **E2E** (`tests/e2e/mobile-native-secrets-alive.test.ts`): production boot, phone paired, 200, a real request reaches the phone without its token, key state agrees with the raw route, raw routes 403; a second boot with the dev-agent gate off reads `off`, which is the fleet branch Echo's own live check can't reach.
- App: parsing unit tests and seeded simulator screens.

## 7. Agent awareness and migration parity

`generateClaudeMd()` gains one bullet after the permissions bullet; `migrateClaudeMd()` inserts it under a content-sniff guard on `GET /mobile/secrets`; `CapabilityIndex` gets `mobileSecretsScreen`. No config, hooks or skills change.

## 8. Rollback

Revert the commit. The route disappears and the app shows "update the agent". The read writes nothing.
