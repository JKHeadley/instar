# Side-Effects Review — Settings → Context: the context budget dashboard card (Phase 1 S14)

**Version / slug:** `cb-context-card`
**Date:** `2026-11-10`
**Author:** `Echo (Opus 5.5)`
**Second-pass reviewer:** `Fable 5.2 — Concur, with should-fix items (see Second-pass review)`

## Summary of the change

Phase 1 slice S14 of `docs/specs/context-budget-layered-summaries.md` (§11 "shown on one dashboard card (console Settings → Context …) joining Home's count through `dashboard/console/needs-model.js`"; also §6.4, §8.1, §9.7 and Frontloaded Decision 2, which name values that appear "on the dashboard card"). A new, read-only console page and a new Home-count source. One server-side line changes: the torn-record Attention notice title in `src/monitoring/ContextBudgetSentinel.ts` now names its fold (`… (fold <id>) is unreadable`), as the quarantine notices already do, so Home can count that incident once.

- **`dashboard/console/context-model.js`** (new, pure): reads the console reader's answers for `GET /context-budget/layers`, `/metrics`, `/sentinel` and `/delta-shadow` and turns them into plain lines: per conversation (summary freshness, cost per turn, share of the operator's messages still word for word, plus a detail sheet with storage sizes, repeated work and the operator's message count), compression-recovery check state per engine and version, what keeping summaries current costs, the "send only what changed" trial, and the watcher's own upkeep. Each read is classified ok / switched off (503) / not on this version (404) / failed; all four off or absent → one sentence, "Conversation summaries are switched off on this machine." A 200 of the wrong shape from the watcher is "can't tell", never "nothing waiting".
- **`dashboard/console/context.js`** (new): the renderer. Needs first (marked `data-operator-need="context"`, each with an "Ask the agent what to do" link), then sections. Every value through `textContent`.
- **`dashboard/console/needs-model.js`**: a `context` source reading only `/context-budget/sentinel`, contributing (a) a memory refresh (fold) quarantined longer than the §9.3 reconciliation bound (15 min), (b) a torn (unreadable) fold record, (c) a diverged compression-recovery canary, one row per machine however many app versions diverged. Stuck and torn rows carry the fold id as their `refs`, so the watcher's own Attention item for the same fold suppresses the duplicate. A stale watcher heartbeat (it has ticked before, `heartbeatFresh: false`) makes the source "can't tell" (Home reads partial), never "nothing".
- **`dashboard/console/nav-model.js`**: a Context tile under Settings (console-only tab), `NATIVE_PAGES.context`, phone alias `context`.
- **`dashboard/console/console.js`**: the route `settings/context`.
- Tests: `tests/unit/console-context.test.ts` (new), `tests/unit/ContextBudgetSentinel.test.ts` (torn title names the fold), `tests/unit/console-needs-first-screen.test.ts` (fixture + page map), `tests/integration/console-static-serving.test.ts` (two assets), `tests/e2e/console-context-page-alive.test.ts` (new).

## Decision-point inventory

- `needs-model.js` `context` source — **add** — which watcher states count as needing the operator (stuck past the bound, torn record, diverged canary). Display-only; it decides what is counted on Home, gates nothing.
- `context-model.js` `STUCK_AFTER_MS` — **add** — a quarantine younger than 15 minutes is shown as "settling", not counted. The number is the spec's own reconciliation bound (`QUARANTINE_RECONCILE_BOUND_MS`), duplicated in the browser module because the console cannot import server TypeScript and the watcher's status does not report the bound it runs with (`reconcileBoundMs`); the module comment names the source constant.
- `ContextBudgetSentinel.ts` torn-record notice title — **modify** — adds `(fold <id>)`; the notice id, priority and summary are unchanged, so its once-per-record durability is untouched.

---

## 1. Over-block

No block/allow surface — over-block not applicable. (The nearest analogue: a quarantine 15–16 minutes old that the sentinel is about to settle on its next tick is counted on Home for up to one tick. That is an over-count of at most five minutes, accepted: past the bound the sentinel has force-ended the candidate and containment may stay.)

---

## 2. Under-block

No block/allow surface — under-block not applicable. Under-count gaps, named:
- **Other machines.** The four routes are this machine's only (none takes `?scope=pool`). A diverged canary or torn record on another machine of the pool is not counted on the Home served by this machine, and its conversations are not listed. See section 7.
- **Spec items with no backend yet in this branch.** §11 lists "rolled-back folds, breaker trips awaiting re-arm, pending Anchor confirmations and `checkpoint-unreachable` events" as Home-count items. None is exposed by any route here (no rollback runner, breaker, Anchor ledger or checkpoint-unreachable counter exists in this branch; `/metrics` reports `anchors: { unavailable: 'anchor-ledger-not-built' }`). They are not shown and not counted. Also owed by this page when their backends land:
  - the §6.1 pending backfill confirmations ("appear on the dashboard card and in Home's count") <!-- tracked: CMT-1536 -->;
  - the §9.3 breaker re-arm, "a PIN-gated tap on console Settings → Context (a `needs-model.js` row)", which has no route to call until the breaker exists <!-- tracked: CMT-1536 -->.

---

## 3. Level-of-abstraction fit

Right layer. The page is a view over existing read-only routes; every judgment (stale, diverged, quarantined, torn) is made server-side by the sentinel and canary and only translated into words here. The Home count reuses the console's one registry (`NEED_SOURCES` → `surfacedNeeds`) rather than a parallel counter, and the first-screen floor test covers the new source like every other.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [x] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context (LLM-backed with recent history or equivalent).
- [ ] ⚠️ Yes, with brittle logic — STOP.

Read-only display. It sends nothing, writes nothing, and its only action is a link that opens a session with a question pre-filled (nothing is sent until the operator sends it).

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The three counted states are enumerable outputs of existing deterministic machinery (the fold record's `quarantined` state past the spec's named bound, an unreadable record, the canary's `diverged` state, all in the spec's §12 table as invariants or floors).

---

## 5. Interactions

- **Shadowing:** none; a new page and a new needs source alongside the others.
- **Double-fire:** the sentinel raises an Attention-queue item for a torn record and for a slow or exhausted quarantine ladder, and Home's queue card reads `/attention`. Resolved: each stuck/torn row passes its fold id as `refs`; the quarantine notice titles already carried `(fold <id>)`, and this change adds it to the torn title. `combineNeeds` drops a surfaced row whose ref appears as a whole token in a queue row, so one incident counts once. A fold id is unique per incident, so it cannot swallow an unrelated item about the same topic (tested both ways). A diverged canary raises no Attention item, so it has no ref and is counted once. Residual: a torn notice raised before this build keeps its old title until it is raised again.
- **Races:** none; reads only. The metrics route memoizes 30 s, so the page's 30-second refresh cannot stack the computation.
- **Feedback loops:** none.
- **Load:** the page adds four local reads plus one pool topic-name read per 30-second refresh while open; Home adds one `/context-budget/sentinel` read per tick (an in-memory status, plus a small file read of the adapter-suite attempts).

---

## 6. External surfaces

- Other agents / install base: the tile appears on every agent's Settings page. On a fleet agent (feature off) the page says in one sentence that it is switched off; Home adds nothing (503 is "off", never "failed").
- `/context-budget/delta-shadow` does not exist in this branch (it ships with S15, `cb-delta-hook`); the page reads it and treats a 404 as "This version does not run the trial yet." Its shape was taken from the S15 commit (`summarizeShadow` + `reduction`).
- No persistent state, no external systems.
- **Operator surface (Mobile-Complete):** no operator-facing action is added. The §9.3 breaker re-arm tap that belongs on this page has no backend yet (section 2).

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

1. **Leads with the primary action?** Yes. When something needs the operator, the headline names it and the need card is the first block after the page head, with its "Ask the agent what to do" link in place; verified by `console-needs-first-screen.test.ts` (fixture `context`) and by screenshots at 1280×728 and 390×844 (the first need and its link are on the first screen at both sizes). With nothing waiting, the first section is the compression-recovery check, then the conversations.
2. **Zero raw internals as primary content?** Yes. Conversations are shown by name (from the topic registry), never by id; an unnamed one reads "Conversation name unavailable". No route paths, config keys, fold ids, machine ids or reason codes are rendered; the unit test asserts the rendered text contains none of them. Engine ids are mapped to names ("Claude Code 2.1.321").
3. **Destructive actions de-emphasized?** No destructive actions on the page.
4. **Plain language + phone width?** Internal nouns are defined at first use on the screen that uses them: "compression" in the recovery section's opening line, "memory refresh" inside each need's own detail and in the watcher section's opening line, "briefing" inline, "token" in the foot note. Verified at 390×844: no horizontal scroll, facts wrap, rows truncate only their secondary line (the full facts are in the tap-through sheet).

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**machine-local, with a named gap.** The page and its Home source read this machine's four routes, and the page says so ("This page reads this machine only."). Most of that is right by design: the compression-recovery canary is keyed per machine, engine and version, and the layer store, archive and ledger are per-machine stores. The incidents that matter most are not machine-local in practice: a torn record and a slow or exhausted quarantine raise Attention items on the owning machine, and Home's queue card already carries those pool-wide. What a Home served by another machine genuinely misses is narrower: (a) a diverged canary, which raises no Attention item, and (b) a quarantine past 15 minutes whose ladder has not yet raised a notice. Because topic sessions usually run on a different machine from the one serving the console, (a) can leave Home's count at zero while recovery is broken where the conversations live. Follow-up, owned by Echo and reviewed at the Phase 1 rung review: pool scope on the sentinel read for `quarantined`, `torn` and `canary.groups`, naming machines that did not answer <!-- tracked: CMT-1536 -->. Not blocking while the feature is dev-gated.
- Notices: none emitted. Durable state: none. URLs: only console hash links, which survive machine boundaries.
- **Status surfaces:** none new or changed.

---

## 8. Rollback cost

Pure client-side change: revert the commit and ship a patch. No persistent state, no migration. During a rollback window an operator who bookmarked `#/settings/context` lands on Home.

---

## Conclusion

A read-only Settings → Context page and a Home-count source over the routes S1/S4/S12/S13 already ship, plus S15's trial route when present. Design changes made during the build: the conversation row was cut to three facts after the 1280-px screenshot truncated it; internal nouns got first-use definitions on the screen that uses them; a wrong-shape watcher answer was made to read "can't tell" across every section (a unit test caught the page throwing on it). Open items, none blocking this slice: the pool read (section 7), the possible double count with Attention items (section 5), and the four §11 Home-count items with no backend yet (section 2).

---

## Second-pass review (if required)

**Reviewer:** Fable 5.2
**Independent read of the artifact: Concur** (no blocking finding; five should-fix items, two of them cheap enough to land in this slice)

Read independently: spec §6.1, §9.3, §11, §13.2, §17; the two new console modules; the edits to `needs-model.js`, `nav-model.js`, `console.js`; the tests; the route handlers in `src/server/routes.ts:8888-8935`; `SentinelStatus` (`src/monitoring/ContextBudgetSentinel.ts:211-245, 891-921`); `CanaryGroup`/`CanaryReport` (`compactionCanary.ts:100-102, 243-266`); `computeContextBudgetMetrics` (`contextBudgetMetrics.ts:55-310`); `ContextLayersStatus` (`contextLayersBoot.ts:45-55`); the delta-shadow route and `summarizeShadow`/`reductionVerdict` at 96ef3f667; the console reader (`console.js:108-131`); `combineNeeds` (`home-model.js:501-514`). Ran `tests/unit/console-context.test.ts` only: 38 passed. Nothing else was run.

**What I checked and found correct**

- Response shapes: every field the model reads exists with that name and nesting in the real handlers (sentinel `quarantined[].ageMs/topicKey/foldId`, `torn[]`, `canary.groups[].state/engine/version/detected/complete/pending`, `layerFreshness.topics[].topicKey/h1.stale/h1.userTurnsBehind`, `holdHealth.counts.clearedTotal`, `eligibleWithoutFold.counts.unknown`; metrics `topics[].topicId/cost.perRequest.allInWeighted/rework.status|rate/u.messages|estimatedTokens/operatorVerbatimShare.share|compactions/layerBytes/archiveBytes`, `overall`, `layerUpdate.componentShare`, `extractorByDay[].turn|tick.calls|tokensIn`, `topicsTruncated`, `window.sinceHours`; layers `topics/layerBytes/archiveBytes`; delta `prompts/fullChars.median/deltaChars.median/omittedItems/reduction.switchOn|allowed`). Topic keys are numeric strings on both sides, so the freshness join and the name lookup line up.
- 503/404: the console reader turns a 503 into `reason: 'switched off on this agent'` with no status, and a 404 into `'the server answered 404'`; `readState` matches both. On Home, `sourceState` treats the 503 as off and a wrong-shape 200 as failed.
- XSS: every server string reaches the DOM through `textContent` or `setAttribute` (`ui.js:7-20`); the only `insertAdjacentHTML` is the fixed nav icon name. No route path, config key, fold id, machine id or reason code is rendered; reader failure reasons are the reader's own fixed sentences.
- Wrong-shape, failed and off reads never produce "healthy" or "nothing waiting" text.

**Blocking**

None.

**Should-fix**

1. **Double count with the Attention queue is real, and has a safe fix now** — `dashboard/console/needs-model.js:115-117`, `context-model.js:84,93`. The author rejected a topic-id ref (rightly) but the fold id is a better ref: it is unique per incident (`f<base36 time><8 hex>`), so it cannot swallow an unrelated item. The sentinel's quarantine notices already carry it in the title ("… (fold fXXXX) needs you" / "is slow to recover", `ContextBudgetSentinel.ts:573-578`), and `combineNeeds` matches refs as whole tokens in the queue row's title. Fix: return `foldId` on each stuck/torn need from `contextNeeds` and pass `row(..., '#/settings/context', [n.foldId])`. That dedupes the stuck case today. The torn notice's title has no fold id (`ContextBudgetSentinel.ts:603`, the id is only in the summary, which the queue row does not expose), so torn stays double-counted until a one-line follow-up adds `(fold ${x.foldId})` to that title. Add a test on each side: a queue row naming the fold drops the surfaced row; a queue row about the same topic without the fold id does not.
2. **A dead or not-yet-run watcher reads as "nothing"** — `context-model.js:80` and `:281`. `torn` is the list from the last clean tick (`ContextBudgetSentinel.ts:897`; `[]` before the first tick, frozen once ticks stop, and a tick with any failed step never advances the heartbeat). With `heartbeatFresh: false` the Home source still returns `[]` and the page tone stays `ok`; the only sign is one line in the last section. Fix: in `contextNeeds`, when `lastTickAt !== null && heartbeatFresh === false`, return `null` (Home then says partial, the page headline says it can't tell); and make the page tone `unknown` whenever the layers read is ok but the watcher read is off/absent, or the heartbeat is stale or has never ticked. Tests: fresh vs stale heartbeat on both the Home source and the page tone.
3. **Compression-recovery divergence: one Home row per engine version, with no way for the operator to clear it** — `context-model.js:100-108`. Each diverged (engine, version) group adds a row, so two versions in one epoch add 2 to Home for one condition. The spec's row for this (§17 "Compaction recovery ran") is "diverged ⇒ heal ladder, then notify", and §11's Home list does not name it; the status has no "ladder exhausted" field, so the card cannot tell "healing" from "needs you". Minimum fix in this slice: collapse to one row per machine (name the engines in the detail). Decision for the orchestrator: whether it counts at all before the ladder is exhausted. I would keep one row, because a known-broken recovery hook (this machine's own recorded case) is exactly what the operator should see, and nothing else raises it.
4. **Pool read: acceptable for this slice, with the gap stated more narrowly than the artifact does** — artifact §7. The spec does not require a pool read for the card (§11 says "canary state per machine"; no route takes `?scope=pool`). The operator-need paths that matter most are not machine-local in practice: a torn record and an exhausted or slow quarantine raise Attention items on the owning machine, and Home's queue card already carries those. What is genuinely missed on a Home served by another machine is (a) a diverged canary, which raises no Attention item, and (b) a quarantine past 15 minutes whose ladder has not yet raised a notice. Since topic sessions here usually run on a different machine from the one serving the console, (a) means the Home count can sit at zero while recovery is broken where the conversations live. Not blocking while the feature is dev-gated, but it needs a dated, owned follow-up (pool scope on the sentinel read for `quarantined`, `torn`, `canary.groups`, naming machines that did not answer), not just a line in this artifact. Until then Home shows nothing to say its context row is one machine's view.
5. **Trial section has one of three verdict branches tested** — `context-model.js:173-175`, `tests/unit/console-context.test.ts:109-110`. Only "Measuring only" is asserted. Add: `switchOn && allowed` → "It is on"; `switchOn && !allowed` → "Held back"; `prompts: 0`; and the off / absent / failed states of the trial read alone.

**Nits**

- `context-model.js:86`: "I could not confirm the old session stopped" is asserted for every quarantine past 15 minutes; at that point the watcher may simply not have force-ended it yet. Say "it has not settled within its time limit" unless `lastOutcome` shows a failed stop.
- `context-model.js:251`: a quarantine with a missing age is counted as "settling … wait a few minutes"; it should read as unknown.
- `context-model.js:169`: a delta larger than the full output prints "about -12% smaller"; clamp or say "no smaller".
- `context-model.js:171`: "would have been left out" is wrong once the trial is on (they were left out).
- `context-model.js:183` and the trial/conversation notes: a 404 on the watcher or metrics read is worded "switched off"; `absent` has its own sentence for the trial only.
- `context-model.js:222`: "not wired" is an internal word; "is not running on this machine".
- `context-model.js:144`: `perRequest.allInWeighted` can be null and prints "0 a turn"; guard as the row does.
- `STUCK_AFTER_MS` duplicates a bound the sentinel accepts as an option (`reconcileBoundMs`); production does not override it today, so this is drift risk only. Exposing the bound in the status would remove the copy.
- Artifact §2 is right that the four §11 Home items and §6.1's pending backfill confirmations have no backend here; the re-arm tap (§9.3) should be listed as owed by this page when the breaker lands.

---

### Resolution (Echo, 2026-11-10)

All five should-fix items and every nit applied:

1. **Double count:** stuck/torn needs carry the fold id as `refs` (`context-model.js` `listNeeds`, `needs-model.js` `context` source); the torn notice title in `ContextBudgetSentinel.ts` now reads `… (fold <id>) is unreadable`. Tests: a queue row naming the fold drops the surfaced row (count 1); a same-topic row without it does not (count 2); the sentinel test asserts the fold id in the torn title.
2. **Stale or dead watcher:** `contextNeeds` returns `null` when `lastTickAt !== null && heartbeatFresh === false` (Home reads partial). The page tone is `unknown` when the layers are on and the watcher is off, absent, stale or has never ticked; a stale watcher's last-known needs are still shown, marked "As of the watcher's last check, …". Tests on both the Home source and the page tone.
3. **Diverged canary:** one Home row per machine, naming every affected app version in its detail; still counted. Test with two diverged versions on one machine.
4. **Pool read:** kept machine-only; §7 narrowed to (a) and (b) with a tracked follow-up.
5. **Trial:** tests for "It is on", "Held back", "Measuring only", `prompts: 0`, and the trial read off / absent / failed.

Nits: stuck detail says "It has not settled within its time limit" unless `lastOutcome` starts `exhausted`; an ageless quarantine reads "no readable start time", not "settling"; a delta no smaller than the full output reads "no smaller"; omitted items "were" left out once the trial is on; a 404 on the metrics or watcher read says "This version of the agent does not report it yet"; "not wired" became "not running on this machine"; a null per-turn cost prints nothing (row detail and overall line); `STUCK_AFTER_MS` names its source constant (the status does not expose `reconcileBoundMs`); §2 lists the §6.1 backfill confirmations and the §9.3 re-arm tap as owed.

---

## Evidence pointers

- Unit: `tests/unit/console-context.test.ts` (56), `tests/unit/ContextBudgetSentinel.test.ts`, `ContextBudgetSentinel-rows`, `tests/unit/console-needs-first-screen.test.ts`, `console-nav-model`, `console-phone-mode`, `console-warning-paths`, `console-dom`, `console-files`, `mobile-native-console-pages`.
- Integration: `tests/integration/console-static-serving.test.ts`.
- E2E: `tests/e2e/console-context-page-alive.test.ts` (the model reads the real routes' HTTP answers, dev agent 200 / fleet agent 503).
- Screenshots (mocked fetch, the real console shell): need, healthy and off states at 1280×728 and 390×844.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. No self-triggered controller added.
