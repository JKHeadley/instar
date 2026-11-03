# Side-Effects Review — phone-pairing confirmation code: opt-in WORD-NNNN form

**Version / slug:** `mobile-pairing-word-code`
**Date:** `2026-11-03`
**Author:** `echo`
**Second-pass reviewer:** `independent subagent (see below)`

## Summary of the change

Implements docs/specs/mobile-pairing-word-code.md. Files:
- `src/core/pairingWords.ts` (new): a frozen list of 256 uppercase words, 4–6 letters, pairwise edit distance ≥ 2, none on a denylist (profanity and agent-chat words such as ECHO, AGENT), plus a frozen `Set` for lookups.
- `src/core/MobileDeviceKeys.ts`: `ConfirmationCodes.issue(deviceId, expiresAt, format)` issues WORD+4 digits for `'word'` and keeps today's 6 digits otherwise. The format is recorded per device in memory, and `formatOf()` reads it. `check()` matches by the device's own format: digits keep today's exact rule. Word input must be a word-code form (`parseWordCode`, one shared pattern: 4–6 ASCII letters, at most 3 separators from whitespace - – — _ : ., 4 digits); a well-formed mismatch is `wrong` (a strike), anything else is the new `wrong-format` (no HMAC, no strike). `leakedIn()` also scans for the same form, only for listed words, de-duplicated and uncapped.
- `src/server/mobilePairingRoutes.ts`: redeem reads `codeFormats` (word only when it is an array of at most 8 entries containing `"word"`) and returns `codeFormat` on both paths. Confirm answers `422 wrong-format` with a fixed hint. The Telegram DM shows `displayCode()`. `GET /mobile/pairing-approvals` rows carry the display form (`KITE-4172` or `123 456`) and `codeFormat`.
- `dashboard/phones.js`: `prettyCode()` shows a code with letters as is.
- `src/core/PostUpdateMigrator.ts`: the four pairing sentences that said "6-digit" become format-neutral, plus a separate idempotent in-place rewrite for existing agents (prefix + `6-digit` match; the unrelated `6-digit PIN` line is untouched).

Tier 2: pairing confirmation is an auth admission path. About 130 source LOC. Effort: the full one-step spec took 7 rounds without converging and was cut; this slice's spec converged in 3 rounds and changed five details of the first build (wrong-format, shared form, uncapped listed-word leak scan, four-line migration, denylist). 1 commit attempt.

## Decision-point inventory

- Confirm admission (`POST /mobile/device/confirm` → `ConfirmationCodes.check`) — modify — a second accepted format, chosen per device at issue time.
- Leak scan (`scanInbound` → `leakedIn`) — modify — one more pattern.
- No new route, no new authority, and no change to who can approve or to the wrong-guess budgets.

---

## 1. Over-block

- A word-code device rejects a 6-digit entry, and a digits device rejects a word entry. Each counts as a wrong guess. That is correct: each device has exactly one code. The app reads `codeFormat` from redeem, so it never prompts for the wrong one.
- A word code typed with a stray character (e.g. `KITE-41722`) is `wrong-format`: no strike, and the app shows the format hint. Letters typed apart (`K I T E 4172`) are also `wrong-format`.

## 2. Under-block

- No new under-block. The requester chooses the format, so an attacker holding a link can keep digits: guessing is no easier and no harder than today (budgets unchanged, counted per machine). Retiring digits is tracked on CMT-1252. <!-- tracked: CMT-1252 -->
- `wrong-format` costs no strike, but it carries no guess either: an input that is not a word-code form can never match. It is bounded by the existing per-device rate limit.
- The leak scan is uncapped and catches every form `check()` accepts; a code written outside those forms (spelled-out digits) is not caught, and `check()` refuses those forms too.

## 3. Level-of-abstraction fit

The format lives where the code lives (`ConfirmationCodes`), and the route only passes the opt-in through. Display is a pure function used by both surfaces. This is the right layer.

## 4. Signal vs authority compliance

Unchanged. The confirm check was already the authority (an exact HMAC match). This adds a second exact-match format and adds no heuristic authority. The leak scan stays a signal that cancels a pairing (fail-safe direction).

## 5. Interactions

- Lease loss `clearAll(except)` keeps working: the format rides inside the same map entry.
- `dashboardCodes` stores the normalized code. `pairing-approvals` formats it on the way out.
- Existing tests: one exact-body assertion gained `codeFormat: 'digits'`, and one dashboard assertion now expects the digits display form `123 456` plus `codeFormat`. The production-path e2e for the no-Telegram flow now opts in to word codes, and the digits path stays covered by the Telegram e2e and integration tests.

## 6. External surfaces

- Redeem response gains `codeFormat`. Additive, so older apps ignore it. Confirm can answer `422 wrong-format`, but only for a word device, which only an opted-in app creates.
- `pairing-approvals` digit rows change from `123456` to `123 456`; the only consumer is `dashboard/phones.js`, which already normalizes.
- Redeem body accepts `codeFormats`. Older apps don't send it and keep 6-digit codes.
- The DM to the owner shows `KITE-4172` for opted-in phones.
- The iPhone app (topic 134088) already accepts letters, spaces and a dash in its code field.

## 6b. Operator-surface quality

The only operator-surface change is `prettyCode()` in `dashboard/phones.js`: a waiting phone's card now shows a word code such as `KITE-4172` as given, instead of reducing it to its digits. Nothing else on the Phones card changes.
1. **Primary action first:** unchanged. The card still leads with the code to type into the app, and the code is the largest element.
2. **No raw internals:** the code is shown in its display form (`KITE-4172` or `123 456`). No format name, HMAC or device internals appear.
3. **Destructive actions de-emphasized:** unchanged. "Not my phone" stays a secondary button below the code.
4. **Plain language at phone width:** a word plus four digits is at most 11 characters, shorter than the old card's longest line, and reads aloud more easily than six digits.

## 7. Multi-machine posture

Machine-local by design, unchanged: codes and their format live only in the serving machine's memory. A lease move voids Telegram-path codes exactly as today.

## 8. Rollback cost

Revert the PR. Codes are memory-only, so nothing persists. Opted-in apps then get digit codes again, which their field accepts.

---

## Second-pass review


Concur with the review.

Independent second pass (2026-11-03): read the full diff plus `pairingWords.ts` and ran the unit, integration (34) and e2e (2) tests touched by this change; all pass.
- Admission: a word device is confirmed only when the normalized input (uppercase, whitespace and dashes removed) matches `^[A-Z]{4,6}\d{4}$` and its HMAC equals the stored one. The format comes from the server-side map entry, never from the request, so a confirm request cannot switch a device's format. Case-insensitivity and dash or space tolerance are intended and reduce nothing beyond the exact code.
- `timingSafeEqual` compares two 64-character hex sha256 digests, so the lengths always match and it cannot throw.
- A digits device behaves exactly as before: `replace(/\D/g, '')`, length 6, the same HMAC comparison. `issue()` defaults to `'digits'`. `codeFormats` must be a real array that contains `"word"`. A string `"word"` or `["emoji"]` falls back to digits, and the tests cover both.
- Wire and display: the DM shows `123 456` exactly as before. `pairing-approvals` returns 6-digit codes unchanged and word codes as `KITE-4172`. `prettyCode` is unchanged for digits.
- Leak scan: the regex has no nested quantifiers (one bounded `{4,6}`, an optional separator, and `\d{4}`), so it cannot backtrack catastrophically. The cap stops after exactly 50 candidates, and `break` ends the lazy `matchAll` iteration. The `e.hmac === h` comparison there predates this change and is acceptable because it only cancels a pairing.
- Migration: it rewrites only lines that start with the old bullet, and the guard needs the old text, so a second run does nothing. The unit test covers this.
- Word list: 256 entries, all distinct, as the artifact says.
- Non-blocking notes: (1) the "Send only the link" bullet in `MOBILE_PAIRING_CLAUDEMD_SECTION` still says "type the 6-digit code I send privately". This is a wording inconsistency only. (2) The no-Telegram e2e now exercises only the word path. The digits dashboard path stays covered at the integration level, not in e2e. The artifact says this accurately.


### Post-convergence delta (echo, 2026-11-03 05:50)
The second pass above reviewed the first build. The spec then converged with five changes, and the code now follows it: `wrong-format` (422, no HMAC, no strike) for non-form input on a word device; one shared word-code form for check() and the leak scan; the leak scan gated on the word Set, de-duplicated and uncapped; the migration rewrites all four 6-digit pairing sentences; ECHO and AGENT replaced and a denylist test added. The reviewer's note 1 (the 'Send only the link' bullet still said 6-digit) is fixed by the four-line rewrite. Unit, integration (34) and the three pairing e2e files pass on the final code.

### Second pass on the post-convergence delta

Concur.

Re-read the delta and re-ran the affected tests: unit 6, integration 34, e2e 4 (telegram-free plus slack-from-app). All pass.
- (1) `parseWordCode`: the anchored pattern is `^\s*` + fragment + `\s*$`. The fragment is ASCII letters, a `{0,3}` run of separators, then 4 ASCII digits. Uppercasing is ASCII only, so no Unicode case folding is involved. The output always has the `[A-Z]{4,6}\d{4}` shape that `issue()` produces.
- (2) `wrong-format`: the result depends only on the input's shape, never on the stored code, so a guesser learns nothing (the redeem response already returns `codeFormat`). Any input that could match parses and goes through the normal strike path, so the per-device and 10-per-24h limits still bound every guess that could succeed. `pairingPaused()` is still checked before `check()`. The 422 reply returns before `applyConfirm`. A digits device never gets `wrong-format`: its rule is exactly today's.
- (3) Leak scan: the separator class does not overlap letters or digits, and every quantifier is bounded, so the work per start position is constant. The time is linear in message length: 1M+ characters of adversarial input (letter runs, separator runs, near-miss codes, whitespace before a non-match) scanned in 1–3 ms. A Set de-duplicates candidates, and checking `PAIRING_WORD_SET` limits HMAC work to real listed words. With no cap, decoys can no longer hide a code.
- (4) Migration: the four rules each need a known prefix plus "6-digit", and a fresh line is applied only when it contains no "6-digit". A second run therefore matches nothing. The dashboard "Uses a 6-digit PIN" line starts with `- Authentication:` and matches no rule, so it is left as is.
- (5) `codeFormats` is accepted only as an array of at most 8 entries that includes `"word"`. The word list has 256 distinct entries. ECHO and AGENT are gone, and `PAIRING_WORD_SET` is built from the frozen list.
- Note, not a concern: `GET /mobile/pairing-approvals` now returns digit codes as `123 456` instead of `123456`, and adds `codeFormat`. The route requires an operator session. Its consumers are the dashboard (`prettyCode` strips non-digits) and confirm (the digits rule strips non-digits), and both handle the spaced form. The e2e for that path passes.
