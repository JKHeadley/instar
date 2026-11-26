---
title: "The phone-pairing confirmation code becomes a word plus four digits"
slug: "mobile-pairing-word-code"
author: "echo"
parent-principle: "The User Experience Is the Product — Reachability, Responsiveness, and Coherence Are Sacred"
eli16-overview: "mobile-pairing-word-code.eli16.md"
status: "draft"
approved: true
approved-by: "echo, under the standing operator rule that only constitution changes need Justin (memory: only-constitution-changes-need-justin; no constitution file is touched)"
review-convergence: "2026-11-03T13:20:32.682Z"
review-iterations: 3
review-completed-at: "2026-11-03T13:20:32.682Z"
review-report: "docs/specs/reports/mobile-pairing-word-code-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: true
frontloaded-decisions: 6
cheap-to-change-tags: 0
contested-then-cleared: 0
---

## 1. Problem

On 2026-11-02 the operator paired the Instar iPhone app with a Telegram-less cloud agent. The phone needed a 6-digit confirmation code from the dashboard, and the dashboard was locked behind the 6-digit dashboard PIN. The two numbers looked alike, and the operator typed the PIN where the code belonged ("the PIN you gave me isn't working"). The operator then asked for the pairing process to be streamlined while keeping one safety step.

The full one-step design (QR presence link, PIN typed into the app, Telegram QR, standalone pairing page) went seven review rounds and kept finding new defects, so it was cut, under the standing rule to cut to the smallest working path after about three failing rounds. This spec is the first slice. The confirmation code gets a shape that cannot be mistaken for any PIN, and typing a PIN where a word code belongs is answered with a plain hint instead of costing a guess. Everything else in the pairing flow is unchanged. The deferred parts stay tracked on CMT-1252. <!-- tracked: CMT-1252 -->

## 2. What exists (instar main d54b72276)

- `src/core/MobileDeviceKeys.ts` `ConfirmationCodes`: `issue()` makes `String(randomInt(0, 1_000_000)).padStart(6,'0')` and stores only `codeHmac(code)` (HMAC-SHA256 under a per-process random key) with the device's expiry, in process memory. `check()` strips non-digits, requires length 6, and compares HMACs with `timingSafeEqual`. `leakedIn(text)` finds `ddd[ -]?ddd` runs and returns devices whose live code appears.
- `src/server/mobilePairingRoutes.ts` redeem route: after a pending device is created, `svc.confirm.issue()` makes the code. On the Telegram path it is DMed as `NNN NNN`. On the dashboard path the plaintext code is held in process memory (`holdDashboardCode`) and served only to a PIN operator session by `GET /mobile/pairing-approvals`. The confirm route passes `req.body.code` to `check()`. Wrong-code budgets live in `DeviceRegistry.applyConfirm`: only a new distinct wrong HMAC costs a strike (a repeated wrong guess is free), 3 per device, and 10 per rolling 24h across that machine's registry, then pairing pauses on that machine. The registry (including pending device records) is on disk; there is no cross-machine counter.
- At boot every pending device is expired (`expireAllPending`), because the code key is per process.
- `dashboard/phones.js` `prettyCode()` strips non-digits and formats `NNN NNN`.
- `scanInbound()` voids a pending device whose live code appears in inbound text. It is wired to inbound Telegram (`AgentServer` `mobileInboundScan`), native app conversations and their media, and app-sent Slack messages and their media (`mobileConversationRoutes`, `mobileSlackRoutes`).
- The iPhone app (topic 134088) accepts letters, digits, spaces and a dash in its code field, case-insensitive. This slice depends on that; an app build that does not send `codeFormats:["word"]` is unaffected.

### Carrier for the rest of the redesign

> **CMT-1252** — "Write the pairing redesign up as a spec (decision recorded in .instar/vm-test/README.md), converge it, and build it"

The rest of the pairing redesign (QR/presence links, PIN-in-app confirm, Telegram QR, a standalone pairing page, app-chat approval, retiring the digits format) stays on that commitment. <!-- tracked: CMT-1252 --> The full unconverged draft is kept outside the repo, in the agent home at `docs/specs/drafts/mobile-pairing-one-step.full-draft.md`.

## 3. Design

### 3.1 Code format
- New format **`WORD-NNNN`**: WORD is one of a fixed list of exactly 256 uppercase English words, 4–6 letters, no two words within edit distance 1 of each other. NNNN is 4 decimal digits, zero-padded. Each part is drawn with `crypto.randomInt`, giving 256 × 10,000 = 2,560,000 codes. Displayed as `KITE-4172`.
- The list lives in `src/core/pairingWords.ts` as a frozen array, with a frozen `Set` beside it for lookups. A unit test checks the size, length, uppercase A–Z only, the pairwise edit-distance rule, and a small hard-coded denylist (profanity, slurs, and agent-flavoured words such as `ECHO`, `AGENT`, `CLAUDE`, `CODE`, `PAIR`, `PIN` that are likely in ordinary agent chat).

### 3.2 Opt-in (old app builds keep working)
- The redeem body may carry `codeFormats: string[]`. If it is an array of at most 8 entries and contains the string `"word"`, the device gets a word code. Otherwise it gets today's 6-digit code. Unknown entries are ignored; a non-array or an over-long array is treated as absent.
- The redeem response, on both the Telegram and the dashboard path, adds `codeFormat: "word" | "digits"`.
- The format is recorded per device in the same `ConfirmationCodes` entry as the HMAC, in process memory only, so `drop`, `clearAll` and `prune` remove both together.
- The caller chooses the format. An attacker holding a link can keep the digits format, so this slice makes guessing no easier and no harder than today. Retiring digits is a CMT-1252 follow-up. <!-- tracked: CMT-1252 -->

### 3.3 Matching
- One shared definition, exported as one pattern fragment and used by both `check()` (anchored) and the leak scan (§3.5, unanchored): a separator is any of whitespace, `-`, `–`, `—`, `_`, `:` or `.`. A **word-code form** is: optional surrounding whitespace, 4–6 ASCII letters `[A-Za-z]` (any case; no Unicode letter matching, so characters such as the Kelvin sign never count as letters), at most 3 separators, 4 ASCII digits. Uppercasing is ASCII-only. `parseWordCode(input)` returns the normalized `KITE4172` for a word-code form and `null` for anything else. Letters spaced apart (`K I T E 4172`) are not a word-code form.
- Word codes are stored as the HMAC of the normalized form.
- `check()` uses the device's own recorded format:
  - **Digits device:** today's rule exactly (strip non-digits, require length 6; any wrong or malformed input is a `wrong` result and costs a strike, as today).
  - **Word device, input is a word-code form:** HMAC + `timingSafeEqual`. A mismatch is `wrong`; a new distinct wrong code costs a strike as today.
  - **Word device, input is not a word-code form** (a PIN, digits only, spaced letters, empty, or not a string at all): a new `wrong-format` result. No HMAC is computed, no strike is recorded, and the confirm route answers `422 { error: "wrong-format", detail: "That is not the pairing code. The code looks like KITE-4172: a word, then four digits." }`. This is the operator's 11-02 mistake. Its shape can never match, so not charging for it gives a guesser nothing, and the hint reveals only the public format.
- The app sends the raw typed text; the server does all parsing.

### 3.4 Display
- Telegram DM: word codes show as `KITE-4172`, digit codes as `NNN NNN` (unchanged). The DM wording is unchanged apart from the code.
- Dashboard: `GET /mobile/pairing-approvals` returns each code already formatted for display (`KITE-4172` or `NNN NNN`) plus `codeFormat` per row. This changes the digits row's `code` from `123456` to `123 456`; its only consumer is `dashboard/phones.js`, whose `prettyCode()` already strips non-digits. The server is the only source of the formatted code. `prettyCode()` shows a code containing letters as given and keeps `NNN NNN` for 6 digits.

### 3.5 Leak scan
- `leakedIn(text)` keeps today's digit pattern and adds a word pattern built from §3.3: letters bounded by a non-letter on the left (a digit on the left still matches, so the scan is a superset of what anchored `check()` accepts), then at most 3 separators, then 4 digits not followed by a digit. A match is a candidate only if its uppercased word is in the 256-word `Set`. Candidates are de-duplicated, then HMAC-checked against live codes as today.
- There is no candidate cap. Each regex match costs one `Set` lookup, and HMACs are computed only for de-duplicated listed-word candidates, so the work is linear in message length, which the inbound surfaces already bound (Telegram's message limit; the app and Slack send routes' body limits). The pattern is fixed-width apart from the bounded separator run, so it cannot backtrack catastrophically. Nothing in the message can push a real code out of the scan.
- `leakedIn` returns immediately when no code is live (unchanged), which is the common case.
- **Coverage rule:** every input `check()` accepts as a word-code form is also matched by the scan, because both use the same form definition. A unit test runs every accepted separator variant through both, including embedded in running text (`see kite – 4172.`).

### 3.6 Out of scope
QR/presence links, PIN-in-app confirm, Telegram QR, a standalone pairing page and "app-chat" approval. Retiring the digits format. All are tracked on CMT-1252. <!-- tracked: CMT-1252 -->

## Decision points touched

| Decision | Classification | Justification |
|---|---|---|
| Word code vs digit code at redeem | invariant | A deterministic opt-in by the client's declared capability (`codeFormats`). Old builds can only type digits, so there is no competing signal to weigh. |
| Which format `check()` accepts for a device | invariant | One device has one code in one format; accepting the other format could only add guesses. |
| Strike vs no strike on a word device | invariant | A pure shape test: input that is not a word-code form cannot match, so it costs nothing (`wrong-format`); a word-code form that mismatches costs a strike as today. |
| Leak scan voiding a pending device | invariant | Voids only on an exact HMAC match against a live code; a false void would need a 1-in-2.56M collision. Cancelling a pairing is the conservative direction. |
| Digits-device behaviour | invariant | Unchanged from today by design (backward compatibility). |
| The `wrong-format` reply text | invariant | Fixed text naming only the public format; no input-dependent content. |

## Verify the state, not its symbol (leak scan and format check)
- **Leak scan.** Symbol: a word-code form in inbound text whose word is listed. State claimed: the live code of a pending device was disclosed in a conversation. Corroboration: an HMAC match against that device's live code, which a mismatched or invented code cannot produce. Not caught: a code rewritten outside the accepted forms (spelled-out digits, letters spaced apart); those forms are also refused by `check()`, so the phone cannot confirm with them either and must be typed in a scannable form. Unmeasurable: with pairing disabled or no live code the scan does not run, and nothing is voided (unchanged).
- **Format check.** Symbol: the input's shape. State: whether the input could be this device's code. Corroboration: the HMAC compare for every well-formed input. Unmeasurable: no live code → `none` → `409 expired` (unchanged).

## Maturation plan

- **test-agent-live:** the unit, integration and migration tests in §6 on a real server boot, plus a word-code pairing driven through the redeem and confirm routes on a throwaway agent (both the Telegram and the dashboard path).
- **dev-agent-live:** the operator pairs the iPhone app with a development agent using a word code once an app build sends `codeFormats:["word"]`, and a typed PIN gets the `wrong-format` hint without a strike.
- **fleet:** no new flag. The change rides `mobilePairing.enabled` and is opt-in per app build, so it reaches the fleet wherever mobile pairing is on; servers behave exactly as today until an app asks for word codes.
- **graduation criterion:** one week on a development agent with every app pairing using a word code, no `wrong-format` reply that was in fact the right code, and no leaked word code left unvoided.
- **dark-window:** if no app build opts in within 30 days of release, the reason and a new date are recorded on CMT-1252. <!-- tracked: CMT-1252 -->

## Open questions
*(none)*

## Frontloaded Decisions
1. **Word list source and review.** The builder writes the list in the PR from common concrete English nouns, applies the §3.1 rules and the denylist test, and the PR's second-pass review reads the list once for offensive or confusing words. Changing the list later is an ordinary code change; codes are never stored, so no migration is needed.
2. **`wrong-format` status and body:** `422 { error: "wrong-format", detail }` as in §3.3. Only a word device can produce it, and only an app that sent `codeFormats:["word"]` gets a word device, so older apps never see it.
3. **Response shapes:** redeem adds `codeFormat` on both paths; `pairing-approvals` rows carry `code` (display form) and `codeFormat`.
4. **`codeFormats` bounds:** array of at most 8 entries; anything else is treated as absent.
5. **The app side is a named dependency, not assumed.** Word codes reach a person only once an app build sends `codeFormats:["word"]` and shows the `wrong-format` `detail`. That change belongs to the iPhone app work (topic 134088). Before this PR is marked done, the builder records the app-side change in the shared app coordination file (`.instar/vm-test/app-coordination.md`) and as an item on CMT-1252, so the server half cannot sit unused unnoticed. Until an app build opts in, the server behaves exactly as today. <!-- tracked: CMT-1252 -->
6. **Response-shape change on the dashboard path** is accepted as stated in §3.4 (digits rows display as `NNN NNN`).

## 4. Security
- The guessing budgets are unchanged: 3 new distinct wrong codes per device and 10 per rolling 24h per machine's registry, then pairing pauses on that machine. A word device's space is 2.56×10^6 against today's 10^6, but the caller picks the format, so the attacker's best case is unchanged.
- `wrong-format` costs no strike. It needs a valid device signature, runs after the `pairingPaused()` check, is bounded by the per-device signed-request rate limit, which applies to pending devices too (`deviceAuthenticator` → `verifyDeviceRequest` → `deviceRateOk`, 120 requests a minute → `429 too-many-requests`), never computes an HMAC, and can never activate a device; it reveals only the public code format. Retyping the same wrong code is already free today, so this adds no new class of free request.
- The plaintext code is never written to disk, and the table of live-code HMACs is memory-only: the HMAC and format live in process memory, the dashboard-path plaintext lives in process memory until confirm, decline or expiry, and the Telegram-path plaintext exists only in the sent DM. Pending device records are on disk as today, including each device's `wrongCodes` list of wrong-guess HMACs (unchanged). A wrong guess that happens to be another pending device's live code puts that code's HMAC on disk, as today; it is keyed by the per-process key, cannot be inverted without it, and is worthless after a restart. Pending devices are expired at boot.
- The code is still shown only through the owner's private Telegram chat or a PIN-unlocked dashboard session (unchanged).
- The leak scan now also catches word codes on every surface it already watches (Telegram, app conversations, app-sent Slack, their media).
- No new endpoint, no new authority, no change to who can approve.

## 5. Multi-machine posture
Pending pairing codes, their recorded format and the dashboard-path plaintext stay machine-local, as today: they live in the memory of the machine that issued them, and lease loss voids Telegram-path codes (unchanged `clearAll`). Wrong-code budgets count per machine's registry: that is existing behaviour this slice does not change.
machine-local-justification: physical-credential-locality (a pending code is a one-time credential bound to the device registration on the machine serving the hostname the phone paired against, and it lives only in that machine's memory; same object and key as the precedent in mobile-native-conversations.md, multi-machine section).

## 6. Tests
- Unit (`tests/unit/mobile-pairing-word-code.test.ts`): the word list rules and denylist; issue word vs digits; `parseWordCode` accepts `kite-4172`, `KITE 4172`, `Kite4172`, `KITE – 4172`, `KITE_4172` and rejects `K I T E 4172`, `123456`, empty; `check()` on a word device returns `ok`, `wrong` (well-formed mismatch) and `wrong-format` (a PIN-shaped input) and records a strike only for `wrong`; a digits device rejects a word guess as `wrong`; `leakedIn` finds every accepted separator variant, ignores an unlisted word (`PAGE-2024`) and a listed word with another number, and still finds a live code placed after 200 decoy candidates.
- Digits regression (unit): a digits device still strips non-digits, needs length 6, charges a strike for malformed input, and the DM shows `NNN NNN`.
- Integration: redeem with `codeFormats:["word"]` → `codeFormat:"word"` and the owner DM carries `WORD-NNNN`; confirm with the lowercase spaced form → active; a 6-digit input to a word device → `422 wrong-format` and the device's strike count unchanged; redeem with no opt-in → `codeFormat:"digits"`; the dashboard path returns the formatted word code to an operator session only.
- E2E: on the production init path, a word-code pairing reaches `active`.
- Existing pairing tests change only where they assert the exact redeem response body, which now carries `codeFormat:"digits"`; the digits behaviour is pinned by the regression test above, not by the claim that old tests pass.

## 7. Agent awareness and migration parity
- Every sentence in the CLAUDE.md template that names the code's shape becomes format-neutral ("a confirmation code, like `KITE-4172` or six digits"): in `MOBILE_PAIRING_CLAUDEMD_SECTION` the opening paragraph, the "Send only the link" bullet and the "Never ask the operator for the confirmation code" bullet; in `PAIRING_WITHOUT_TELEGRAM_CLAUDEMD_SECTION` the opening paragraph. The never-relay rule is unchanged. New agents get this through `generateClaudeMd` (`templates.ts` builds both sections from the same functions).
- PostUpdateMigrator: one **separate** content-sniffed check, independent of the earlier Tailscale rewrite branch (which only runs while `Single use, 10 minutes.` is still present and so never reaches agents already past it). A line is replaced with the fresh line from the section function only when it starts with that line's known section prefix (`The operator can add this agent to the Instar iPhone app`, `An agent with no Telegram owner can still add a phone`, and the two bullets below) **and** contains `6-digit`; the prefix test keeps the unrelated `6-digit PIN` dashboard line untouched (for the two bullets: the exact shipped substrings `- **Never ask the operator for the 6-digit confirmation code**` and `type the 6-digit code I send privately`). The fresh lines must not contain `6-digit` (a test asserts it), so a second run matches nothing. The Tailscale rewrite touches only the `- Mint:` and stable-address lines, so the two checks cannot clash in either order. Tests cover a CLAUDE.md at the pre-Tailscale wording, one already past the Tailscale rewrite, one carrying the without-Telegram section's older stale code line (so the check composes with that existing rewrite in either order), and a second run that changes nothing.
- No config change.

## 8. Rollback
Revert the PR. Codes are memory-only, so a restart after the revert leaves no live code; pairings in flight need a new link, as with any restart today, including one whose app had already shown a word-code entry. App builds that send `codeFormats:["word"]` then get digit codes (the server ignores the field), which their code field accepts. The migrated CLAUDE.md sentences stay format-neutral, which remains true.
