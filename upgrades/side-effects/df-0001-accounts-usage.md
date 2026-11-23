# Side-Effects Review — DF-0001 stage 1: fixed usage-limit order, display name, rounded tone and reset flag

**Version / slug:** `df-0001-accounts-usage`
**Date:** `2026-11-22`
**Author:** `echo (design-standards session, Mama PC)`
**Second-pass reviewer:** `not required`

## Summary of the change

This is stage 1 of `docs/specs/design-standard-enforcement.md` §4. The owner approved the spec on 2026-11-22 (topic 146789, message 147024).

On the server (`src/server/mobileCapacityRoutes.ts`):
- `usageWindows(q, now)` returns limits in a fixed rank order instead of by percentage, and adds `name`, `tone` and `rolledOver` to each limit.
- New `topWindow()` returns the highest limit that has not rolled over. It replaces `windows[0]` in the notices (twice) and in the account summary.
- New `usageTone()` colours a limit or account from the rounded figure.
- Constants: `USAGE_TONE_ATTN_PCT` is new and `NEAR_OUT_PCT` moved up beside it.
- `roomReturnsAt` ignores rolled-over limits.

On the web (`dashboard/console/accounts-model.js`):
- New `usageTone()` and `USAGE_TONE_ATTN_PCT`, used for both the limit tone and the account tone.
- The account sort gains a name tie-break.

New file `src/data/design/usage-tone-vectors.json`, with a parity test that pins both sides to it.

Tier 1 by size: 2 source files, about 60 changed lines plus tests. Declared Tier 2 because it rides the approved Tier-2 spec. One spec round was applied, and this is the first commit attempt.

**Deviation from spec item 5, stated:** the spec says the literals 75 and 90 "move to one shared constant file". The web console is a plain browser module outside the TypeScript `rootDir`, and no server module imports from `dashboard/`. The house pattern is two copies pinned by a test, as with `phoneWorkCards.ts` and `make-card.js`. So each side keeps one named constant pair, and `usage-tone-vectors.json` carries the bands. The parity test fails if either side's numbers differ from the file. The intent is met: a drift on one side fails a test.

## Decision-point inventory

- Which colour a usage limit shows: display only. It gates no action and blocks nothing.
- Which limit decides an account's line, colour and sort position: display only.
- Whether the pool-wide "nearly out" notice shows: an informational notice. It blocks nothing, and it now ignores limits that already reset.

None of these gate information flow or constrain agent behaviour.

---

## 1. Over-block

No issue identified. Nothing is rejected. The notice now fires less often, only when every account's live limit is at 90% or over. Before, a limit that had reset could trigger it falsely.

## 2. Under-block

There is one stale window. `rolledOver` is computed against the server's clock at request time, so an app caching the payload keeps the old flag until it refreshes. This already happens today with `resetsAt`, which is cleared the same way.

The server still sorts accounts that need sign-in first, and the web does not. The spec deliberately leaves that difference open as DSE-T7 (CMT-2171).

## 3. Level-of-abstraction fit

This is the right layer. Order, tone and reset are decided once on the server, so the apps paint what is sent, as the note to the app sessions asks. The web is the second renderer and uses the same rule.

## 4. Signal vs authority compliance

Not a decision point with authority. These are display values, so `docs/signal-vs-authority.md` does not apply. No brittle check gains blocking power.

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The 75 and 90 bands are existing enumerable display thresholds, recorded in the spec's decision table as "Tone bands 75/90 — enumerable-domain". They only moved into named constants.

---

## 5. Interactions

- **Installed apps.** Per the spec's ground truth, iPhone and Mac draw `windows` in the order received and sort their own headline. Windows sorts its own headline. Android reads only `usageLine`, and Linux has no reader. Removing the server sort changes only the order iPhone and Mac draw rows in, which is the intended fix. Every installed app ignores the three new fields, because apps decode JSON leniently. `usageLine` now names the top live limit instead of `windows[0]`. Before, those two were the same limit except when the top limit had reset; now the reset limit is skipped.
- **Pool notices.** They now read `topWindow()`, so a pool whose only "full" limits have reset no longer reports "all accounts nearly out".
- **Web tests.** `console-accounts.test.ts` (35 tests) passes unchanged. Its existing "reset limit no longer counts as full" test already matched the new server behaviour.

## 6. External surfaces

`GET /mobile/accounts` changes in an additive way: three new fields per limit and a new order. `label` and `schemaVersion` are unchanged, so older apps keep working. No timing dependency beyond request-time `now`, which the route already passes as `opts.now`.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

This touches an operator surface (`dashboard/console/accounts-model.js`, the accounts screen's model).

1. **Leads with the primary action?** Yes, unchanged. Only colours and the order of equal accounts change, and the screen's layout and actions are untouched.
2. **Zero raw internals as primary content?** Yes. No new text is shown, only colour decisions.
3. **Destructive actions de-emphasized?** Not affected; none are added or moved.
4. **Plain language + phone width?** Unchanged markup. The fix makes the colour match the number displayed (89.6% shown as "90%" is red), which is DF-0001 problem 3's plain-reading fix. No layout change, so phone width is as before. The console DOM tests in `console-accounts.test.ts` pass.

## 7. Multi-machine posture (Cross-Machine Coherence)

Proxied-on-read, unchanged. `/mobile/accounts` already merges `/subscription-pool?scope=pool` across machines and computes the summary on the answering machine. The new fields are pure functions of each merged reading and the answering machine's clock. No new state is stored, replicated or stranded. No user-facing notice is added (one-voice is unchanged).

## 8. Rollback cost

Revert the commit. The change is pure code with no stored data, migration or config. Apps that start using `name`, `tone` or `rolledOver` must fall back when they are absent, as the note to the app sessions specifies.

---

## Conclusion

Safe to ship. It is a display-only, additive change that fixes DF-0001's server and web problems: limit order, the colour of a reset limit, a reset limit deciding the account, rounding drift, and sort stability. The notice behaviour changes only by dropping false "nearly out" readings.

## Second-pass review (if required)

Not required: no messaging block or allow, no session lifecycle, no gate, sentinel or watchdog.

## Evidence pointers

- `tests/unit/usage-tone-parity.test.ts`: 16 tests across 7 boundary cases, run on both sides.
- `tests/unit/mobile-native-capacity-screens.test.ts`: 43 tests, including the two new DF-0001 cases.
- `tests/integration/mobile-native-capacity-screens.test.ts`: 18 tests.
- Neighbour unit suites: 160 tests. Integration: 23. E2E (console-home-lifecycle and the capacity-screens alive test): 22. All green on 2026-11-22.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. This fixes product display code, not a prompt, hook, config, skill or standards text, and it adds no self-triggered controller.
