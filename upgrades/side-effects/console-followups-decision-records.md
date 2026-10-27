# Side-Effects Review — Console follow-ups: the instar-dev gate run for PR #2377's source changes

**Version / slug:** `console-followups-decision-records`
**Date:** `2026-10-26`
**Author:** `echo`
**Second-pass reviewer:** `independent reviewer subagent (see "Second-pass review" below)`

## Summary of the change

PR #2377 (`feat/console-followups`) was built in worktrees made with a raw `git worktree add`, which have no husky shim, so the instar-dev pre-commit gate never ran on its three source-carrying commits (`25fd1d166`, `e8d9ada20`, `a7698e49a`) and no decision-audit record was written. This commit re-runs the real gate over the PR's full source change so the record is genuine. It changes no behaviour itself: the twelve source files below carry exactly the bytes already on the PR head.

What those twelve files do (net diff against `main`):

- **(a) Structured preferences read.** `src/core/PreferencesListView.ts` (new) builds `GET /preferences` entries (`dedupeKey, learning, recordedAt, confidence, dedupeCount, origin?`, plus `total`, `truncated`, `scope`) from the same sources, in the same precedence, as `/preferences/session-context`; every `learning` is passed through the live-tail credential scrubber; `violationPattern` and replication bookkeeping are never served. The route lives in `src/server/routes.ts`, is read-only, and answers 503 when correction learning is off. `src/server/CapabilityIndex.ts` lists it.
- **(b) Find a file by name.** `src/server/fileRoutes.ts` adds `GET /api/files/search` (bounded breadth-first name match across the allowed folders; every entry goes through the same never-served, blocked-name, realpath and allowed-path checks as the list route; caps on results 200, scanned 20 000, depth 12, wall time 2 s; `truncated: true` when it stopped early) and a top-level `truncated`/`totalEntries` on the project-root listing past 500 entries, matching what nested folders already returned. `src/server/middleware.ts` adds `img-src 'self' blob:` to the dashboard CSP for `/dashboard/console/…` only, so the console Files page can preview an image fetched with the bearer token; the legacy dashboard keeps the exact old policy.
- **(c) Redaction catches hyphenated provider keys.** `src/core/liveTailRedaction.ts`: the generic api-key rule now lets the key body carry `-` and `_`, so `sk-ant-api03-…` and `sk-proj-…` keys are redacted instead of passing through.
- **(d) Agent awareness + migration parity.** `src/core/PostUpdateMigrator.ts` exports two shared CLAUDE.md lines (`GET /preferences`, `GET /api/files/search`) used by `src/scaffold/templates.ts` for new agents and by `migrateClaudeMd()` for existing ones (content-sniffed, idempotent), plus the "Every ask carries one tap" Attention bullet migration (sniff `attention-unactionable`).
- **(e) Every ask is actionable.** `src/messaging/attentionAction.ts` (new) decides an attention item's one tap (validated producer `action`, else a category/id → console page table). `src/server/routes.ts` stamps it on `GET /attention` (local and pool-merged items) and validates an optional `action` on `POST /attention` (400 for anything but a console hash path). `src/messaging/TelegramAdapter.ts` attaches it to Attention hub posts as an inline URL button through the tunnel URL (relayed sends append the URL to the text), and logs a post with no possible button to `logs/attention-unactionable.jsonl`. A post is never held back for lacking a button; one narrow case can still lose it (see Under-block). `src/commands/server.ts` wires the tunnel URL resolver. `src/monitoring/GreenPrAutoMerger.ts` `configurationView()` additionally returns the validated `owner/name` repo so a PR waiting on the operator can link to its GitHub review.

The detailed review for (e) is `upgrades/side-effects/every-ask-is-actionable.md`; this artifact covers all twelve files and adds (a)–(d).

**Tier and proportion.** Declared Tier 1: 12 source files, about 535 added lines, every part reverted by a revert. The routes are read-only or additive, the CSP change is console-only, the migration only appends documentation lines. One gate attempt for this commit; no spec review rounds (the console work is driven by the plan files under `docs/specs/console-features/`, which are not a converged spec).

## Decision-point inventory

- `POST /attention` `action` validation — add — refuses (400) a malformed optional field; requests without it unchanged.
- `attentionActionFor` — add — display routing (which console page a tap opens); no authority.
- `TelegramAdapter.routeToAttentionHub` — modify — adds a button; never decides to withhold a post (one narrow failure path can still drop it, see Under-block).
- `GET /api/files/search` — add — read path; admits entries through the existing file-viewer rules, adds no new allow rule.
- `dashboardCsp` — modify — widens `img-src` to `'self' blob:` on console paths only.
- `liveTailRedaction` api-key rule — modify — redacts more (a scrubber, not a gate).

---

## 1. Over-block

The only new refusal is `POST /attention` rejecting a malformed `action` (non-console URL, missing or over-long label). A producer that wants to link to GitHub directly is refused by design: the button must open the operator's own console. The widened redaction rule could redact a non-secret token shaped like `sk-xxxx-…` 16+ characters long in a live tail; that is the scrubber's existing trade-off, now applied to hyphenated bodies too. The file search refuses an empty or 200+ character query.

---

## 2. Under-block

The redaction rule still misses provider keys with prefixes outside its list (it is a generic net, not a key registry). The file search stops at its caps and says so (`truncated: true`); a match past the cap is not found. An attention item matching no rule and carrying no producer action gets no button; it is logged so the producer can be fixed.

**Second-pass finding (accepted, not fixed in this PR):** if Telegram itself refused the inline button (for example `BUTTON_URL_INVALID`), the HTML send's plain-text fallback in `sendToTopic` re-sends the same `reply_markup`, so both sends fail and the hub post is lost (the hub path then clears its cached topic id). The trigger is unlikely, because only an https tunnel URL with a URL-encoded item id is ever put on a button, but it is possible. The fix (one more retry with the buttons removed) is queued as feedback `fb-99bc2103-19b`. Peer items that arrive with an `action` already set are passed through by the pool merge without re-running `validAction`; the peer is one of this agent's own authenticated machines, so the risk is low, and re-validating is in the same feedback item.

---

## 3. Level-of-abstraction fit

Each piece sits where its siblings already live: the preferences list reuses the session-context source precedence and the existing serve-path scrubber; the file search reuses `resolveListEntry`/`validatePath`/`checkBlockedFilename` rather than a parallel path check; the CSP change is one function in the existing dashboard header middleware; the attention tap is decided once server-side and shared by the GET stamp and the hub post.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

Nothing here decides whether an action may happen. The one refusal is schema validation of a new optional input field. The file search admits exactly what the existing list/read rules admit. The scrubber removes text from a display; it blocks nothing.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The category/id table routes a tap to a page; the redaction regex is a floor (fewer leaks), not a judgment.

---

## 5. Interactions

- The hub filter still runs before any button is built; the repost throttle is unchanged.
- `GET /preferences` and `/preferences/session-context` read the same sources in the same order, so the page and the injected block cannot disagree.
- The file search and the list route share their admission functions, so a later tightening of one tightens both.
- The migration bullets are content-sniffed; re-running the migrator adds nothing twice.
- `configurationView().repo` is read only by the console; the merge path does not consume it.

---

## 6. External surfaces

- API: new `GET /preferences`, `GET /api/files/search`; `GET /attention` items gain `action`; `POST /attention` accepts `action`; `GET /green-pr-automerge` configuration gains `repo`; the project-root file listing gains `truncated`/`totalEntries` past 500 entries.
- Telegram: Attention hub posts gain an inline URL button to `<tunnel>/dashboard/console/#/…` (never localhost or plain http).
- Browser: the console's CSP allows `blob:` images.
- Agents: two CLAUDE.md lines and one Attention bullet are added on update.
- New append-only log: `logs/attention-unactionable.jsonl`.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

This commit's staged source files are not operator surfaces, but they feed the console pages that are (Settings · Preferences and Files, Home and every needs-you row):

1. **Leads with the primary action?** Yes — needs-you rows carry their button directly; the Files page offers search at the top.
2. **Zero raw internals as primary content?** Yes — preferences show the learning in plain words with when and how sure; ids and dedupe keys are not headline content; button words are plain ("Open sign-in").
3. **Destructive actions de-emphasized?** No destructive action is added by these routes (all read-only, plus a link).
4. **Plain language + phone width?** The console pages were checked at 390 px against the Mac Studio's data (no horizontal scroll).

Found while running the gate (not introduced here, already on `main`): the console Permission-slips page asks the operator to paste a fingerprint when no known agent exists to pick. Queued as feedback, not changed in this PR.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

- `GET /preferences` — **proxied-on-read**: it reads the same merged/foundation-union view as session-context when preference replication is on, own store otherwise.
- `GET /api/files/search` — **machine-local by design**: it searches this machine's project folder, like every other file route.
- Attention actions — **proxied-on-read**: the pool merge stamps peer items lacking one.
- The unactionable log and the CSP are machine-local by design. No new user notices; nothing strands on topic transfer.

---

## 8. Rollback cost

Pure code change — revert and ship a patch. Agents that already received the CLAUDE.md lines keep two lines describing routes that would then 404; harmless, and a later migration can remove them. The append-only log is safe to leave.

---

## Conclusion

Clear to ship. This commit records the gate evaluation the PR's source commits skipped; it does not change the PR's behaviour.

---

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent (fresh context, given the diff and this artifact, not the author's conclusion)

First pass: **Concern raised** — the artifact said a button never withholds a post, but `sendToTopic`'s plain-text fallback re-sends the same `reply_markup`, so a Telegram button refusal fails both sends and the hub post is lost; also, pool-merged peer items with an existing `action` are not re-validated. Everything else checked out (file search admission and caps, `/preferences` scrubbing, console-only CSP, the redaction rule only redacts more, migrations idempotent, the `GreenPrAutoMerger` change only adds a checked `repo` field and does not change merging, no new blocking authority).

Resolution: the claims were narrowed and both findings recorded in Under-block, queued as feedback `fb-99bc2103-19b`; the PR's code is unchanged.

Second pass after revision: **Concur with the review.** The artifact now matches the code, and neither finding blocks the PR.

Third check, after the commit gate required an `unbounded-self-action` declaration and the Class-Closure section was rewritten as `closure: n/a`: **Concur with the review.** The two hub `sendToTopic` calls gain only a `urlButtons` argument and the button is built once per post after the hub filter and repost throttle; `POST /attention` gains only a validated optional field; no new send, retry, loop or schedule.

---

## Evidence pointers

Unit: `tests/unit/console-followup-reads.test.ts`, `tests/unit/LiveTailBuffer.test.ts`, `tests/unit/console-followup-claudemd-migration.test.ts`, `tests/unit/attention-action.test.ts`, `tests/unit/PostUpdateMigrator-attentionActionable.test.ts`; integration: `tests/integration/console-followup-reads-routes.test.ts`, `tests/integration/attention-actionable.test.ts`, `tests/integration/green-pr-automerge-routes.test.ts`, `tests/integration/console-static-serving.test.ts`; e2e: `tests/e2e/console-home-lifecycle.test.ts`. Local Verify passed the PR head `aaa18c9c4`.

---

## Class-Closure Declaration (display-only mirror)

- **`defectClass`:** `unbounded-self-action`
- **`closure`:** `n/a` (negative declaration)
- **Reason:** the gate's detector fired on two existing `sendToTopic` calls in `routeToAttentionHub` and the existing `createAttentionItem` call in `POST /attention`, whose arguments now carry a button / an optional `action`. No new self-triggered send, loop, retry or cadence is added: each admitted attention item still produces the same one hub post under the unchanged hub filter and repost throttle, and the only new effect per post is one append to `logs/attention-unactionable.jsonl` when it has no button.
