# Side-Effects Review — Conversations suggestion step + Chief of Staff root

**Version / slug:** `conversation-graph-suggestions`
**Date:** `2026-11-11`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Tier 1, about 20 files (6 new source/dashboard files, 6 test files), roughly 900 lines with tests. Effort: one design pass, no spec review rounds (Tier 1, approved by Justin in topic 137342 at 18:56 PST), one commit attempt so far.

Two things, both inside Conversations (docs/specs/conversation-graph-suggestions.md):
1. **Suggestions.** `src/core/ConversationGraphSuggestions.ts` (pure prompt, parser and filter), `src/server/ConversationGraphSuggestionService.ts` (one model call per build, a small state file, rejections, acceptances, rate bounds), `src/server/conversationGraphSuggestionRoutes.ts` (owner-only GET/refresh/reject/accepted), wired in `ConversationGraphSurface.ts` only when owner corrections are mounted, with evidence (topic summary, live topic-intent goals, project binding) supplied from `AgentServer.ts`. The dashboard (`conversation-suggestions.js`) runs Accept through the existing owner change routes in order.
2. **Chief of Staff root.** `ConversationGraphReadModel` takes `rootConversation`, returns it as `root` on the unsearched Overview, gives it no destinations and `moveEligible:false`, and leaves it out of the suggestion inventory. `ConversationGraphOwnerChanges` refuses placing it under any parent at preview and at the write ingress. The dashboard draws it as the top row with the root efforts indented under it.

## Decision-point inventory

- `ConversationGraphOwnerChanges.submit / preview` — **add** — refuse `set-primary-placement` of the configured Chief of Staff conversation under a non-null parent (`chief-of-staff-is-root`).
- `ConversationGraphReadModel.node / destinations` — **modify** — report the root as not movable, with no destinations.
- `parseSuggestionReply` — **add** — deterministic validation of model output before anything is shown. It decides what is *offered*, never what is *written*.
- Owner change ingress for Accept — **pass-through** — Accept uses the existing owner changes; every existing check (heads, cycle, scope, subject-pending, receipts, commit) still applies.

---

## 1. Over-block

The only new refusal is placing the Chief of Staff conversation under something. That is the owner's explicit rule ("should always be the root conversation"). An owner who later wants it under an effort cannot do it while the Chief of Staff feature is on. The write path still accepts a move to the top level (`parent:null`), but the dashboard offers no move for it at all (`moveEligible:false`, no destinations), so a root left under an effort by an older placement cannot be moved back from the UI. None exists on any agent today (Conversations has no placements of the Chief of Staff topic), and the Overview draws it as the root regardless of any parent. Agents without the Chief of Staff feature have no root and nothing is refused.

The suggestion parser drops good groups in a few cases: a group with one wrong alias is dropped whole, a group overlapping an earlier one is dropped, a group mixing two bound projects is dropped. Each case only means one fewer suggestion. The owner can still create the effort by hand.

## 2. Under-block

- The root rule is checked at the dashboard write ingress and at preview. A change recorded locally while the shared graph is not open (`recorded-local`, the provisional spool in `ConversationGraphDefaultSurface`) is not checked there. The dashboard hides Move for the root (`moveEligible:false`), so the owner UI cannot produce one. A hand-crafted local intent could still place it, and the Overview would still draw it as the root.
- Delegation capture could place the Chief of Staff conversation as a worker under another conversation if that conversation spawned it. That has not happened (the Chief of Staff topic is created by the feature, not by a spawn), and the Overview still shows it as the root.
- The model-written effort name becomes a real effort title through `set-effort-title` when the owner accepts. It is clipped to 60 characters, shown to the owner on the card before Accept, rendered as text (never HTML), and renamable afterwards.
- Quality of suggestions depends on the model. Bad groupings are possible. They are advice, shown with their reason, and the owner rejects them.

## 3. Level-of-abstraction fit

- The suggestion is computed server-side and shown read-only. Writes reuse the one owner-change pipeline, so no parallel write path exists.
- The root rule lives in the read model (presentation) and the owner write ingress (the one place owner placements are accepted). It is not a graph event and needs no migration.
- The model groups. Code checks every safety property afterward. The model never decides anything that writes.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

The model output is a signal: it is shown to the owner, who holds the authority (Accept/Reject). The parser is a structural filter on that signal (shape, membership, overlap, project mix, prior rejection), not a judgment gate on user content. The one blocking rule (root placement) is not brittle content logic: it compares a node key with the configured Chief of Staff conversation key, a rule the owner set.

## 4b. Judgment-point check (Judgment Within Floors standard)

There is no static heuristic at a competing-signals decision point. The grouping judgment is the model's, inside fixed floors (only offered conversations, 2 to 12, no overlap, no project mix, no repeat of a rejection). The owner's tap decides.

## 5. Interactions

- Duplicate efforts: the create-effort request id comes from the server, one per suggestion (`POST …/:id/start`), so a reload, a second tab or another visit reuses the same owner request and the owner pipeline's idempotency returns the same effort. A started Accept stays offered (marked "Continue") while its members move in, and its members are left out of later builds, so they are not re-suggested as a new group.
- Owner placements win: Accept skips a member that is already under any other parent, and skips naming when the effort already has a name.
- `subject-change-pending`: Accept waits for each change to commit before the next, so it never trips this guard. A slow machine stops Accept with a Continue button, and Continue reuses the same request ids.
- Manual corrections and Accept can race on the same conversation. The existing head check (`placement-conflict`) decides. Accept skips that member and reports it.
- LLM funnel: registered in `componentCategories` (`reflector`), `llmBenchCoverage` (pending wave-3, pinned), untrusted input (true), parser contract (this PR's unit test), injection exposure (user + model content). All ratchets pass.
- The CLAUDE.md awareness block is added to the template and by `migrateClaudeMd` (idempotent, content-sniffed by heading).

## 6. External surfaces

- New owner-only dashboard routes under `/conversation-graph/suggestions`. They answer 403 without the operator-session proof and 404 when corrections are not mounted. The mobile allowlist is unchanged, so the phone app does not get them.
- `GET /conversation-graph/roots?view=overview` gains an optional `root` field. Older clients ignore it.
- One model call per build. A build starts by itself only when the owner opens the list and the last attempt is over 24 hours old. A refresh is allowed once per 10 minutes. No call is made with fewer than two conversations.
- New agent CLAUDE.md block (template + migration).

## 6b. Operator-surface quality (Operator-Surface Quality standard)

1. **Leads with the primary action?** Yes. The Overview shows Chief of Staff, the efforts under it, then "Review suggestions" and "Create effort". The suggestions page shows each card with Accept first.
2. **Zero raw internals as primary content?** Yes. Cards show the effort name, a plain reason and the conversation titles. No ids, hashes or refs. Refused steps show the server's reason code in brackets after plain words ("This step was refused (project-scope-conflict)"). That is support metadata at the end of a sentence, not headline content.
3. **Destructive actions de-emphasized?** Reject is the quiet button after the primary Accept. Rejecting asks nothing further because it is reversible only by a rebuild, and only removes a suggestion: nothing is moved or deleted.
4. **Plain language + phone width?** Verified on the live Studio dashboard with this branch's console files served through Playwright, at 1280x728 and 390x844. No horizontal scroll. Real tap targets. Screenshots: `.playwright-mcp/sugg-overview-desktop.png`, `sugg-list-desktop.png`, `sugg-list-phone.png`.

## 7. Multi-machine posture (Cross-Machine Coherence)

- **Graph writes from Accept:** replicated. They are the ordinary owner events, certified on every member.
- **Chief of Staff root:** derived per read from the replicated Chief of Staff topic state. Every machine that runs the Chief of Staff feature shows the same root.
- **Suggestion state (built list, rejections, acceptances):** machine-local by design for this change. It is advice regenerated from shared inputs. The gap: a rejection made on one machine's dashboard is not known to another machine's dashboard, which could offer the same grouping again. Tracked to move onto a replicated store <!-- tracked: CMT-1650 -->.
- **Status surfaces:** no `/status`, `/health` or `/capabilities` field changes.

## 8. Rollback cost

Revert the PR. No graph events are introduced; efforts created through Accept are ordinary owner efforts and stay valid. The state file `conversation-graph-suggestions.json` is inert without the code. The CLAUDE.md block would remain on migrated agents until removed by a follow-up migration; it describes a missing feature only.

## Conclusion

Ship. Suggestions are advice, written changes go through the existing owner pipeline, and the root rule is the owner's own and narrowly scoped.

## Second-pass review (if required)

**Reviewer:** independent general-purpose subagent (Claude), 2026-11-11 19:36 PST, given the diff and this artifact only.

**Independent read of the artifact: concern, then resolved.** It raised five points: (1) a half-finished Accept vanished after a reload because a moved member made the suggestion unofferable, and a rebuild could re-suggest the rest as a new group; (2) a second tab minted a new create id and so a second effort; (3) Accept moved a conversation out of an effort the owner had chosen since; (4) this artifact overstated that the root can be moved to the top level from the UI; (5) `accepted` was posted without checking its result, and the model-written title was not mentioned. All five are fixed in this change: server-held create id and in-progress state (`beginAccept`, `accepting`), members of an in-progress Accept excluded from builds, members under any other parent skipped, naming skipped when already named, `accepted` result checked, and §1/§2 corrected. Tests added for each (unit: 31 + 6; integration start route). It confirmed owner-only routes and `root`, the placement of the root refusal in submit and preview, the fenced prompt with alias-only parsing, and bounded waits.

## Evidence pointers

- `tests/unit/conversation-graph-suggestions.test.ts` (23), `tests/unit/console-conversation-suggestions.test.ts` (5), `tests/unit/PostUpdateMigrator-conversationsSuggestionsAwareness.test.ts` (1)
- `tests/integration/conversation-graph-suggestions.test.ts` (3)
- `tests/e2e/conversation-graph-suggestions-alive.test.ts` (1)
- Regression: conversation-graph-read (23), console-conversations v2/dom (42), owner-changes + surface integration + surface-alive e2e (18), LLM ratchets (all green).

## Class-Closure Declaration (display-only mirror)

```json
{ "defectClass": "unbounded-self-action", "closure": "n/a",
  "reason": "user-driven: a suggestion build starts only when the owner opens the suggestions list (at most once per 24 h) or taps Refresh (at most once per 10 min, single-flight); nothing re-triggers it" }
```

## Follow-up: Local Verify findings (2026-11-13)

Local Verify failed on three repo ratchets, all fixed in a follow-up commit:
- `provenance-coverage-ratchet`: `ConversationGraphSuggestions` is declared `pending:backlog:decision-quality-enrolment` in `src/data/provenanceCoverage.ts` (pinned in the test). It is graded meanwhile by the owner's Accept/Reject.
- `no-silent-fallbacks`: the evidence lookup and a damaged state file now report through `DegradationReporter` (a damaged file would forget rejections, so it is never silently replaced). The unparseable-model-output, failed-build and unreadable-root catches carry in-block `@silent-fallback-ok` with the reason: each is either surfaced to the owner or equivalent to "no root / no suggestions".
- Docs Coverage passes after merging current main.
