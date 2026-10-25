# Side-Effects Review — assisted re-login waits out the Cloudflare bot-check interstitial

**Version / slug:** `relogin-interstitial-wait`
**Date:** `2026-09-23`
**Author:** `Echo`
**Second-pass reviewer:** `independent subagent (browser-drive decision path) — see below`

## Summary of the change

`src/core/ChromeCdpReloginBrowser.ts`: the snapshot classifier gains a closed page class `interstitial` for the Cloudflare hold page (title "Just a moment…", fixed hold wording, or a `challenges.cloudflare.com` iframe), checked before the prose chain. `src/core/AnthropicReloginBrowserDriver.ts`: the drive loop waits an `interstitial` out with a 3 s poll on its own budget (`interstitialMaxMs`, default 90 s, cap 5 min), not counting drive steps and not consulting the supervisor; past the budget it returns `provider-transient` as before. `allowedActions('interstitial')` is `['wait']`. Tests: +3 unit, +1 real-Chrome integration.

## Decision-point inventory

- Page classifier (`snapshot`) — modify — adds one class; the `captcha` class and its operator-only handling are unchanged and come after the interstitial check.
- Drive loop (`AnthropicReloginBrowserDriver.drive`) — modify — one new branch for `interstitial` that only waits. Origin and scope checks still run first on every snapshot, including interstitial ones.
- `allowedActions` — modify — `interstitial → ['wait']`.

## 1. Over-block

None added. The change only makes the drive wait longer on one page class.

## 2. Under-block

- **Misclassifying a real CAPTCHA as an interstitial.** The interstitial signals are the hold title, the hold wording and the Turnstile iframe. A Google risk page or reCAPTCHA has none of those and keeps its `captcha`/`google-risk-challenge` class. If a future hold also renders an interactive challenge, the drive waits up to 90 s and then fails transient. It never clicks or types on that page, so the failure is a delay, not a wrong action.
- **A page the classifier now calls `interstitial` that would previously have matched a later class.** Only pages with the hold markers are affected, and those never were an actionable form.

## 3. Level-of-abstraction fit

The classifier owns "what page is this", and the driver owns "what may be done and for how long". The fix adds exactly one fact to each. No policy or store code is touched.

## 4. Signal vs authority compliance

No new authority. The interstitial branch has a single admissible action (wait), so skipping the Tier-1 supervisor for it removes no judgment: the supervisor could only ever have chosen `wait` or declined. Every other page class still goes through supervision unchanged.

## 4b. Judgment-point check

The classification is a fixed marker set (title, wording, iframe host), not a competing-signals heuristic. The wait budget is a bound, not a judgment.

## 5. Interactions

- **Attempt and wall-clock budgets:** one drive can now take up to 90 s longer. `maxAttempts` (3) × 90 s stays well inside the orchestrator's 10-minute `maxWallClockMs`. If the hold never clears, the episode still ends `attempt-budget-exhausted` (non-security), so the re-admission fix (#2056) applies on an input change and the operator retry route works.
- **Supervision cost:** fewer LLM calls per drive, since the twenty 750 ms `unknown` steps on the hold each used to call `supervise`.
- **Chrome lifetime:** the seat lease and browser close path are unchanged; the abort signal is checked every loop iteration, including interstitial polls.

## 6. External surfaces

The repair browser sits on Claude's hold page for longer before either proceeding or closing. That is what a human browser does. No routes, config or on-disk format change.

## 6b. Operator-surface quality

Not applicable — no dashboard or approval-surface file changed.

## 7. Multi-machine posture

Machine-local by design. Each machine drives its own browser profile.

## 8. Rollback cost

Revert the two source hunks and patch release. No state to migrate.

## Conclusion

Closes the last of the three blockers found in the 2026-09-23 live run without changing what the repair is allowed to do — it only waits where a person would wait.

## Second-pass review (if required)

**Reviewer:** independent subagent
**Independent read of the artifact:** "Concur with the review." Reviewer notes folded in: an *interactive* Turnstile renders the same markers, so it classifies `interstitial`, waits the budget and ends `provider-transient` → eventually `attempt-budget-exhausted` rather than `waiting-operator-only` — the same terminal shape it had as `unknown` before, with no action ever taken on it. `browser.wait` is not abort-aware, but `throwIfAborted` runs every iteration and the abort listener closes the browser, so abort latency is ≤3 s. The orchestrator checks its 10-minute wall clock only at tick start, so a drive can now overrun it by up to ~90 s (pre-existing shape). `interstitialMaxMs` is not wired from `SubscriptionReloginRuntime` (default-only), consistent with "no config change".

## Evidence pointers

- Live: `justin-gmail` episode on the Studio, 21:35–21:41Z, three `browser-driving → approved transient-retry-scheduled` transitions, then `failed attempt-budget-exhausted`; the live tab showed "Just a moment..." with a Turnstile iframe (`/json/list` on the engine's own Chrome).
- Tests fail pre-fix (3 unit), pass post-fix; the real-Chrome classifier test passes; all 17 relogin files green; `tsc` clean.

## Class-Closure Declaration (display-only mirror)

- **`defectClass`**: `unbounded-self-action` (this modifies a self-triggered browser drive's retry/wait loop).
- **`closure`**: `guard`
- **`guardEvidence`**: `{enforcementType: ratchet, citation: tests/unit/anthropic-relogin-browser-driver.test.ts "bot-check interstitial" tests, howCaught: control-loop edge = interstitial polls happen only while the snapshot class is interstitial; steady-state bound = interstitialMaxMs (default 90 s, hard cap 300 s) per drive, inside maxAttempts × maxWallClockMs; settling brake = past the budget the drive returns transient and the orchestrator's existing attempt budget and breaker take over. The budget-exhaustion test asserts exactly 3 polls for a 9 s budget.}`
