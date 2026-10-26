# Console features review round 2 — Gemini 4 Argon (gemini CLI), 2026-10-25

## 1. Verdict: **Ready**

Every round-1 finding from both reviewers has been resolved cleanly, accurately, and without adding bloat. The three-adapter PIN model (`00-patterns.md` §4a), the switch-over checklist (`README.md`), the single unified build order, the scoped cost reporting, the restored audit views, and the trimmed MVP scope (pushing preference writes, diff viewers, and new shipping controls to *Later*) make these plans coherent, honest, and ready to build. Below are a few minor residual cleanups in the wireframes and text to apply during implementation; none block starting step 1.

---

## 2. Factual errors & code claims

Specific file/line and route-implementation claims against the legacy codebase (`dashboard/index.html`, `dashboard/*.js`, `src/server/*`) are **unverified** as source files are not in stdin. Within the plans themselves, all round-1 cross-document contradictions (PIN lifetime, Insights retirement target, build order, and Preferences audit sections) are resolved. Two minor residual text/sketch mismatches remain inside the updated sections:

- **`What I've learned about you` wireframe still shows a cut button (`people-settings.md`):** The text explicitly cuts preference writes and "tell me directly" from this build (replacing it with a quiet line: *"To change one, tell me in chat"*), but the ASCII sketch still ends with `[ Tell me something directly ]`.
- **`Files` wireframe still says `[Review&save]` (`people-settings.md`):** The text cuts the diff-review step from the MVP editor in favor of a sticky top header with `Save` and `Cancel`, but the right-hand sketch still renders `[Cancel][Review&save]` at the bottom above `(keyboard)`.

---

## 3. Lost controls or write actions

None. The new **Old control → native control checklist** in `README.md` covers all 29 legacy tabs and acts as a hard switch-over gate. Specifically verified as restored in round 2:
- **Mark delivered** on every displayed promise (including secondary placement on waiting-on-you, missed, and older rows).
- **Spend** hourly / monthly / total grains under *More detail*.
- **Schedule** full 50-run history (`Show all 50` as a dated list below the 20-run strip).
- **Pace** `medianPushIters` (5th number + chart tab).
- **Integrated-Being** ledger-ID lookup under *Technical* and full commitment detail sheets.
- **Preferences** class reviews and claim verification moved to *How I'm doing inside › Checks on my own claims*.

One tiny checklist omission to add for completeness:
- **`What I'm allowed to do` (`people-settings.md`):** The plan includes **Accept the risk** / **Stop accepting it** (`POST`/`DELETE /guards/:key/accept-fallback`, adapter c) on dark-but-load-bearing safety checks, and **Not now** / **Dismiss** on earned-trust and rubber-stamp suggestions, but the `README.md` checklist row for guards only lists the guard list itself.

---

## 4. Merges, renames, and design specificity

All 16 places have concrete, feature-specific designs, phone wireframes, and domain-accurate honesty states.
- Moving **In the way** (Blockers) above **In flight** on *Plans* fixes the mobile fold problem.
- Giving **Safety checks** one home under *What I'm allowed to do* (with deviant checks first and a count link from *Machines*) eliminates the 3-way split.
- Moving **Model routing & fallbacks** into a sheet from the header of *What thinking costs* keeps the time selector honest.
- **One minor discrepancy between `console-makeover.md` and `work.md` on the "Older, still open" rule for missed promises:** `00-patterns.md` (§2) and `work.md` state that **missed, overdue, or failed** items are exempt from the 14-day age rule and keep a visible count in their own section regardless of age. However, `console-makeover.md` (§1, *What I've promised*) still describes Home's card as counting only recent items while older waiting/missed items are not counted. Since `work.md` says *Promises* "uses Home's rules exactly (one model, `home-model.js`, so both screens always agree)", make sure `home-model.js` also exempts missed promises from aging out of the count.

---

## 5. Security (PIN handling, operator proof, maintainer surfaces)

The security model is now solid:
- **Three explicit PIN adapters (`00-patterns.md` §4a):** Adapter (a) bearer-only, adapter (b) `X-Instar-Operator-Session` in page memory for its 15-minute server TTL, and adapter (c) one-shot body PIN cleared immediately on settlement. No raw PIN is ever cached in memory, and native pairing upgrades from legacy's page-retained PIN to adapter (c).
- **Plan-bound commits preserved:** Money and feedback commits display the server's exact rendered plan text and bind `planId` + `nonce` (plus text hash for restart).
- **Preference attribution protected:** Moving preference writes to *Later* and requiring server-verified operator proof before attributing any preference to the operator prevents bearer-holding agent sessions from forging operator rules.
- **Maintainer visibility vs. authority:** `consoleProfile` is explicitly scoped to UI visibility (`00-patterns.md` §9, `under-the-hood.md`), and file search (`GET /api/files/search`) is explicitly bound to `checkRelativePathAllowed`, `validatePath`, and post-symlink never-served checks.

---

## 6. Over-engineering & build order (80/20)

The unified 6-step build order in `README.md` is well-prioritized for a phone-first operator:
1. **Promises** (proves the shared patterns on 4 phone states before reuse).
2. **Machines** + **This machine** + **Health** shortcut.
3. **Accounts** (sign-in repair) + **Messages to you** (held replies).
4. **What I'm allowed to do** (fixes broken feature state-machine toggles + hosts safety checks) + `consoleProfile` + **Feedback approvals**.
5. **Plans**, **Schedule**, **What thinking costs** (read-only, retires Insights), and the remaining People/Settings/Under-the-hood pages.
6. **Later:** live terminal, preference writes, Evidence drawers, new Shipping write controls, Pace comparison charts, Files diff viewer, and native spending-control write sheets.

---

## Ranked Findings (Minor cleanups only)

### 1. Align Home's `home-model.js` missed-promise aging rule with `00-patterns.md` §2 and `work.md`
- **Problem:** `00-patterns.md` (§2) and `work.md` (*Promises*) establish that missed/overdue items never age out of section counts after 14 days, and `work.md` states that *Promises* and *Home* share `home-model.js` so their counts always agree. As noted in Round 1 (Astra 8), `home-model.js` currently excludes 14-day-old missed promises from the prominent missed count.
- **Smallest fix:** When building Step 1 (*Promises*), update `home-model.js` so `missed` promises are never filtered out by the 14-day age threshold, keeping Home and Promises identical.

### 2. Clean up two stale ASCII wireframes in `people-settings.md`
- **Problem:** In `people-settings.md`, the *What I've learned about you* sketch still shows `[ Tell me something directly ]` (cut to *Later*), and the *Files* sketch still shows a bottom `[Cancel][Review&save]` bar above `(keyboard)` instead of the sticky top header with `Save` and `Cancel`.
- **Smallest fix:** Replace `[ Tell me something directly ]` with `To change one, tell me in chat.` in the Preferences sketch, and move `[Cancel] [Save]` to the top header of the Files sketch.

### 3. Add the guard fallback-acceptance and autonomy-dismiss actions to the `README.md` checklist
- **Problem:** `people-settings.md` specifies `POST`/`DELETE /guards/:key/accept-fallback` (adapter c) and `/autonomy/elevation/dismiss` + `/dismiss-rubber-stamp` (adapter a), but they are not listed in the `README.md` switch-over checklist.
- **Smallest fix:** Add those two rows under `Machines` / `Features` in the `README.md` checklist so they are verified before switch-over.
