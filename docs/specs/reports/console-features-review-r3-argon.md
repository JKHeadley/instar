# Console features review round 3 — Gemini 4 Argon (gemini CLI), 2026-10-25

## 1. Verdict: **Ready**

All round-1 and round-2 findings from both reviewers have been cleanly resolved. The feature plans are thorough, specific, and coherent across all six files. Every legacy capability is accounted for in the switch-over checklist (`README.md`), security boundaries (the three PIN adapters, local-only machine writes, and maintainer visibility) are tight, and the "Built so far" section honestly tracks where the first four native pages match or diverge from the spec.

There are only two tiny text inconsistencies left inside `work.md` from the round-2 edits—neither blocks implementation, and both can be fixed in place as you build.

---

## 2. Factual errors & code claims

Because legacy source files (`dashboard/index.html`, `dashboard/*.js`, `src/server/*`) and the built `dashboard/console/*` files are not included in stdin, specific line-number and route-implementation claims against the codebase are **unverified**.

Within the plan documents themselves, all previous cross-document contradictions (PIN adapters, Insights retirement target, build order, Shipping/Release-readiness fields, Claim Observation vocabularies, and Files root truncation) have been resolved. The only internal text contradiction remaining is on the **Promises** page in `work.md`:

- **`work.md` contradicts `00-patterns.md` §2 and `README.md` on 14-day-old "Waiting on you" promises:** `00-patterns.md` (§2) states that **items waiting for the operator's approval** are exempt from aging out of their section count (showing fresh ones as rows and old ones as a counted `+N older, still open ›` line inside the same section). `README.md` (*Built so far*) explicitly flags that `promises-model.js` currently moves 14-day-old waiting-on-you promises out of *Waiting on you*'s count and marks this as a build bug to fix because *"00-patterns.md §2 keeps it counted in its own section."* However, `work.md` (both under *Shared rules*, line 67, and *Promises › Layout*, line 417) still says a promise waiting on the operator untouched for 14+ days moves out of *Waiting on you* into *Older, still open* and leaves the count.
- **The `Promises` section in `work.md` is missing its action/state bullets:** When `work.md` was edited in round 2 to align with the built `promises.js` page, the *Primary actions*, *Secondary / destructive actions*, *Honest states*, *Multi-machine*, and *Rough sketch* bullets under `Promises` (between *Layout* and *Merge / split / cut*) were accidentally deleted. Their rules are still summarized in `README.md` (*Built so far* and the checklist), but the section in `work.md` stops abruptly after *Layout*.

---

## 3. Lost controls or write actions

**None.** Every legacy view, filter, and write action across all 29 tabs is mapped in the `README.md` switch-over checklist, including the round-2 additions:
- **Older cleared blockers** (collapsed, preserving all resolved entries beyond 7 days).
- **Autonomous runs** (`GET /autonomous/throughput-floor`) placed in *Plans › Autonomous runs* with per-run decision and flatline minutes.
- **Job sorting** (`failing first / priority / name / last run`) preserved inside *Schedule › All jobs*.
- **Other agents** history-only counterparties and the advanced allow/deny rule editor.
- **Safety checks** fallback risk acceptance (`POST`/`DELETE /guards/:key/accept-fallback`) and autonomy suggestion dismissals.

---

## 4. Merges, renames, and design specificity

All 16 places have clear, operator-centered designs that avoid generic dashboard filler:
- **Development (`under-the-hood.md`)** now puts a concrete pending-approval card (Feedback authority PIN card or Shipping review link) immediately under the headline, followed by collapsed one-line summaries for *Shipping*, *Feedback*, and *Pace* (only one open at a time on a phone). That completely solves the mobile scroll problem.
- **Shipping (`under-the-hood.md`)** now has an explicit field-to-display table for `/green-pr-automerge`, `/local-verify`, `/local-verify/record`, and `/release-readiness`, and honestly reports watchdog episodes rather than claiming a release inventory.
- **Checks on my own claims (`under-the-hood.md`)** cleanly separates the four verdict buckets (*Evidence supports it*, *Evidence contradicts it*, *Couldn't verify*, *Not evaluated*) from coverage/settlement notes, avoids a fake denominator, and preserves *"Advisory only — nothing was blocked"*.
- **Schedule (`work.md`)** scopes the "Late" check strictly to `enabled && runsOnThisMachine` and phrases it as *"past its recorded next-run time"*.

---

## 5. Security (PIN handling, operator proof, maintainer surfaces)

No security issues remain in the plan:
- **Per-machine write safety (`00-patterns.md` §6, `people-settings.md`):** Local-only server writes (such as `POST /guards/:key/accept-fallback`) are restricted to this machine's rows with the machine named in the confirmation sheet; peer rows render **Open on <machine>** without forwarding PINs or operator sessions across servers.
- **No false conflict writes (`people-settings.md`):** Removing *Keep this one* on `/state/resolve-conflict` prevents the UI from marking a conflict resolved without writing the winning preference value.
- **Three PIN adapters (`00-patterns.md` §4a):** Consistently applied across all group plans, with zero raw-PIN caching in memory and full plan-text + nonce binding for money and feedback commits.

---

## 6. Over-engineering & build order (80/20)

The 6-step build order in `README.md` is well-sequenced, and the *Built so far* section shows Steps 1–3 (*Promises*, *Machines*, *Accounts*, *Messages to you*) are already underway with clear, honest tracking of what remains before switch-over. Deferring the live terminal, preference writes/conflict resolution, Evidence drawers, new Shipping write controls, Pace comparison charts, Files diff view, and native spend-arming sheets to *Later* keeps the remaining MVP scope tight and practical.

---

## Ranked Findings (Minor doc cleanups only)

### 1. Align `work.md` with `00-patterns.md` §2 and `README.md` on 14-day-old "Waiting on you" promises
- **Problem:** `00-patterns.md` (§2) and `README.md` (*Built so far*) state that items waiting on the operator's approval keep a visible count in their own section regardless of age (showing fresh ones as rows and 14d+ ones as a `+N older, still open ›` line in the same section). `work.md` (lines 67–71 and 416–419) still says 14-day-old waiting-on-you promises move out to *Older, still open* and leave the section count.
- **Smallest fix:** Update those two sentences in `work.md` to match `00-patterns.md` §2 and `README.md`: waiting-on-you promises keep their section count at any age, with 14d+ items collapsed as `+N older, still open ›` inside *Waiting on you* (and excluded only from the top page headline if desired).

### 2. Restore the accidentally trimmed action/state bullets under `Promises` in `work.md`
- **Problem:** In `work.md`, the *Promises* section stops after *Layout* and jumps straight to *Merge / split / cut*, omitting the *Primary actions* (**Mark delivered** on every non-violated promise, **Resume reminders**), *Secondary / destructive actions* (**Drop** with a required reason, offered on open and `violated` promises), *Honest states*, and *Multi-machine* (`?scope=mesh` coverage) bullets that `README.md` references.
- **Smallest fix:** Add back a short bullet block under `Promises › Layout` in `work.md` summarizing those actions and states so `work.md` stays self-contained alongside `README.md`.
