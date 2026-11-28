# Side-Effects Review — onMessageLogged dispatch containment

**Version / slug:** `message-logged-dispatch-containment`
**Date:** `2026-11-15`
**Author:** `dawn (workstation)`
**Second-pass reviewer:** `not required (Tier 1)`

## Summary of the change

Tier 1 — a revert fully undoes it. Three source files, every added line a `catch` body, a
comment, or the one shared method the Slack call sites now share. No behaviour changes when
the subscriber succeeds.

`onMessageLogged` is a settable subscriber seam on the messaging adapters. In production the
subscriber is server.ts's closure (`src/commands/server.ts:19796` for Slack), and it performs
the TopicMemory dual-write: `writeSlackLogRow` → `TopicRowWriter.writeRow` →
`TopicMemory.insertKeyedMessage` → `insertMessage` → `stmt.run()`. Read on upstream
`d76d018c0`: there is **no `try`/`catch` anywhere on that chain** — not in the closure, not
in `writeSlackLogRow` (it returns `writer.writeRow(...)` directly), not in `writeRow`, not in
`insertMessage`. So a SQLite write failure reaches the dispatch site.

Enumerated the whole population by AST rather than by the sites a previous note happened to
name. On the shipped tree the scan finds **9** calls of a property named `onMessageLogged`
across `src/`: 3 are calls to classes that OWN a method of that name (`PresenceProxy` ×2,
`PromisedUpdateCapture`), and the remaining 6 are subscriber dispatches, all caught. The table
below lists the SITES at their **upstream `d76d018c0`** line numbers, including the two Slack
call sites that now reach the dispatch through one shared method:

| site | state on `d76d018c0` | after |
|---|---|---|
| `messaging/TelegramAdapter.ts:4815`, `:4864` | guarded (try/catch + DegradationReporter) | unchanged |
| `messaging/shared/MessageLogger.ts:116` | guarded (try/catch + console.error) | unchanged |
| `messaging/slack/SlackAdapter.ts:2310` (`logMessage`) | guarded (try/catch + console.error) | routed through the shared method; keeps console.error, **gains** the degradation report |
| `messaging/slack/SlackAdapter.ts:1992` (`_handleMessage`) | **BARE** | contained |
| `messaging/slack/SlackAdapter.ts:2198` (`_handleFileShared`) | **BARE** | contained |
| `messaging/imessage/IMessageAdapter.ts:833` (`_logMessage`) | **BARE** | contained |
| `server/routes.ts:23524` (Slack agent-reply route) | caught, at the WRONG ALTITUDE | contained locally |
| `monitoring/PresenceProxy.ts` / `PromisedUpdateCapture.ts` receivers | not dispatches — those classes OWN a method of that name | untouched |

**The two Slack bare sites are the live production exposure.** At `:1992` the throw escapes
before `addReaction` and before the inbound message is converted and routed to the handler;
at `:2198` before "Convert to Instar Message format and route to handler". That is a person's
message dropped with no reply and no hand-off — a failed *memory* write destroying the
*delivery*.

**`routes.ts:23524` is a different, smaller defect and is described as such.** It was already
inside the route's own `try`, whose `catch` answers `res.status(500)` (`routes.ts:23566`). The
dispatch happens *after* `sendWithAdapterTimeout` returned and after `deliveryLruRecord`, so a
failed subscriber reported a reply that HAD been delivered as a server error — the same
ambiguity the handler deliberately avoids 10 lines earlier, where it answers 408 on a send
timeout "so a redrive NEVER re-posts a message the API may have taken". It also skipped the
`trackPromise` block below it. Now contained locally, tagged `@silent-fallback-ok` with the
reason, in the same shape as the `logMessage` fallback four lines above it.

**`IMessageAdapter.ts:833` is hardening, not a live fix, and is not claimed as one.** Nothing
in `src/` assigns that adapter's `onMessageLogged` today. Measured properly rather than with
the narrow grep I first reached for: the only two assignment forms anywhere in `src/` are
`MessageLogger.setOnMessageLogged` (the logger's own seam, already guarded) and
`chainPromisedUpdateCapture(adapter, …)` — whose single call site passes `telegram`
(`src/commands/server.ts:18495`), not the iMessage adapter. So that callback is null and
cannot throw. It is guarded anyway, so the next wiring inherits the property instead of
re-discovering its absence — the sibling-path lesson applied forward rather than after the
fact.

Effort: one build round. No commit attempt before this one.

## Decision-point inventory

- **No new decision point and no new authority.** Every added branch is reached only on the
  `catch` path, i.e. only when the subscriber has already thrown.
- `SlackAdapter.notifyMessageLogged` is a funnel, not a policy: it does not choose whether to
  dispatch. The one existing choice (`opts.notify !== false`) stays at its original call site
  and keeps its own test.

## 1. Over-block

No issue identified. Nothing new refuses, rejects, or blocks anything. The only new refusal
anywhere is in a test (the population ratchet), and it refuses a *commit*, not runtime input.

## 2. Under-block

- Containment is **not** repair. The searchable copy of a message whose write failed is still
  missing; this change makes the loss reported and survivable instead of destructive. The
  question of who owns a failed row write — the measurement says
  `insertKeyedMessage`'s return value, not a `try`/`catch` under it — is deliberately NOT in
  this change and remains open.
- The population ratchet can only see a `catch` that **answers the caller** with a 5xx. A
  dispatch caught at the wrong altitude by a handler that is *silent* about it would pass.
  Stated in the test's own docstring rather than left implied.
- The ratchet keys on a property named `onMessageLogged`. A seam renamed, or reached through
  an alias or a dynamic property access, is outside it.

## 3. Level-of-abstraction fit

Right layer, and this is the part worth the reader's eye. The failure is the subscriber's,
and the adapter is the boundary that must not let a subscriber's failure become the
*message's* failure. Four sibling sites in exactly this role already contain it there, so this
is the repo's own established altitude, not a new one. The deeper fix (a truthful outcome from
`insertKeyedMessage`) lives one layer down in the memory code and is a different change; it
would not remove the need for this one, because a bare dispatch would still be bare.

## 4. Signal vs authority compliance

Complies. No blocking authority is added at runtime and no heuristic decides anything. The
exact-match classification is "the subscriber threw" — the language's own answer, not a
keyword guess. A wrong containment would at worst swallow an error that is still printed and
still filed as a degradation.

## 4b. Judgment-point check

Not applicable: there are no competing signals and no static heuristic at a decision point.
The `catch` fires on a thrown error or does not fire at all.

## 5. Interactions

- **DegradationReporter**: two new report sites, reusing the existing
  `feature: 'TopicMemory.dualWrite'` that Telegram already files for this identical failure, so
  the dashboard groups them rather than splitting one failure across platform-specific names.
- **`no-silent-fallbacks` ratchet** (`tests/unit/no-silent-fallbacks.test.ts`, BASELINE 494):
  passes unchanged. Measured, not assumed: its scan is non-recursive over `RUNTIME_DIRS`, so
  `messaging/slack/` and `messaging/imessage/` are outside it entirely, and the `routes.ts`
  catch carries `@silent-fallback-ok` with a reason, which the detector exempts by name.
- **`logMessage`'s existing guard**: preserved. It still prints the same console line; the
  degradation report is additive. No test asserted that line's text (checked).
- **The `notify: false` contract** (the agent-reply route notifies once itself): unchanged, and
  now has a test that would catch its loss.

## 6. External surfaces

- No API, route, config key, schema, or CLI change. No new route registration.
- Two new log lines and two new degradation reports, all on failure paths only.
- The HTTP answer of `POST /slack/reply` changes in exactly one case: a subscriber failure
  after a successful send used to produce `500 {error}`; it now produces the success answer
  the delivered reply earned. That is the intended correction, and it removes a redrive's
  reason to re-post an already-delivered message.

## 6c. Observability — and what SILENCE means here (PROP-084 Level 2)

Asked because a guard that only speaks on failure is the shape that becomes a gate nobody can
tell is alive.

- **When it fires**: `console.error` plus a `DegradationReporter` event on the Slack paths,
  which reaches an existing consumer (`getEvents()`, the `/health` degradation read). That is
  Level-2 activation through an instrument that already had a reader — not a new counter with
  nobody at the other end.
- **When it does not fire**: nothing at all, and for this capability that is the correct
  silence — "no subscriber ever threw" IS the healthy state, so a heartbeat here would be
  noise. The usual objection to that answer is that silence then cannot be told apart from
  "the guard was never reached". **The population ratchet is what closes that gap**: it proves
  by AST, every run, that the guard is present at every dispatch site. So silence means
  "nothing threw", not "nothing was guarded" — and the thing that would otherwise make the
  silence unreadable is asserted in CI rather than trusted.
- **What has no signal and is said rather than implied**: how often the contained failure
  actually happens in production. Nothing here counts contained failures over time; the
  degradation event is per-occurrence. If that number ever matters, it belongs with the
  outcome-contract work, which is where a counted outcome exists.

## 6b. Operator-surface quality

Not applicable: no operator surface is touched (nothing under `dashboard/`, no approval page,
no grant/revoke/secret-drop form).

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN, with a reason.** The containment is per-process error handling on
whichever machine received the message: a Slack event is delivered to one machine's adapter,
and the TopicMemory store it writes is that machine's own file. There is no state to replicate
and nothing another machine can or should read about it.

- **User-facing notices**: none added. The degradation report is a local observability event
  already subject to DegradationReporter's existing alert gating; no new notice path, so no
  one-voice question arises.
- **Durable state**: none added. Nothing strands on topic transfer.
- **URLs**: none generated.
- **Status surfaces**: none new or changed. The degradation events surface through the
  existing `/health` degradation read, whose scope this change does not alter.

## 8. Rollback cost

A revert of the commit. Three `catch` blocks, one private method and two test files; no
migration, no state, no config, nothing written anywhere that outlives the process. Reverting
restores the prior behaviour exactly, including the 500 on the reply route.

## Conclusion

Ship. The change applies an answer the codebase already contains to the sites that lacked it,
the live half is measured on today's tip rather than inherited, and the one site that differs
in kind is described as differing rather than folded into the same sentence.

## Second-pass review

Not required for Tier 1. The PR is the review surface.

## Evidence pointers

- `tests/unit/slack-message-logged-dispatch-contained.test.ts` — 4 behavioural tests driving
  the real `_handleMessage`, `_handleFileShared` and `logMessage` paths with a subscriber that
  throws. Each assertion carries its **positive control in the same `it`**: the identical path
  with a subscriber that returns normally must show the subscriber was really invoked,
  otherwise a test passing because the dispatch never happened is indistinguishable from one
  passing because the failure was contained.
- `tests/unit/message-logged-dispatch-population.test.ts` — 5 tests. Walks every `.ts` file
  under `src/` with the TypeScript AST, finds every call of an `onMessageLogged` property, and
  asserts (a) none is uncaught, (b) none is caught by a 5xx handler. Three positive controls:
  the scan must find at least 8 call sites (a blind matcher cannot pass vacuously), the guard
  detector must return BARE for a synthetic bare snippet and for a `try`/`finally` with no
  `catch`, and the altitude detector must flag a synthetic 5xx-handler snippet.
- **Founding-case controls, run in both directions.** With the source reverted to upstream,
  the population test FAILS and names exactly
  `messaging/imessage/IMessageAdapter.ts:833`, `messaging/slack/SlackAdapter.ts:1992`,
  `messaging/slack/SlackAdapter.ts:2198`; with only `routes.ts` reverted, the altitude test
  FAILS and names `server/routes.ts:23524 (slack) caught by a 5xx handler`. With the change
  applied, all 5 pass. A ratchet that cannot fail on the defect it was written for is not a
  ratchet.
- **Mutation sweep: 7 mutants, 7 killed**, each killing exactly the tests it should — catch
  removed (3 fail), contained but not reported (3), site `:1992` reverted to bare (1), site
  `:2198` reverted (1), `logMessage` bypassing the funnel (1), the funnel never dispatching
  (3 — the positive controls), `notify: false` no longer suppressing (1). Source restored
  byte-identically after every mutant (shasum verified).
  **What a mutant could not tell me here, stated rather than left implicit:** that the real
  subscriber can throw. That rests on reading the chain (no `catch` on any of its five hops)
  and on this row's earlier reproduction with real better-sqlite3.
- `tsc --noEmit`: exit 0, zero output.
- `npm run lint:parallel`: **all 54 lint steps passed**, 58.5s. This is also how the
  self-action detector question was settled — by running the gate, not by reasoning about
  whether `notifyMessageLogged(` matches its `notify(` verb pattern.
- Unit lane: `tests/unit/topic-row-writer.test.ts` 27/27, `MessageLogger.test.ts` 18/18,
  `slack-message-dedup` 3/3, `slack-file-shared` 6/6, `no-silent-fallbacks` 5/5, plus the two
  new files 9/9. (An earlier run showed 19 red in `topic-row-writer`; the cause was the
  cloned `better_sqlite3.node` built for `NODE_MODULE_VERSION 127` against this node's 147.
  `npm rebuild better-sqlite3` turned all 19 green with the source untouched — the failures
  were environmental, verified by control, not inherited as a claim.)

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. The change touches TypeScript runtime
source (`isAgentAuthoredArtifact` in `scripts/class-closure-lint.mjs` matches none of these
paths), adds no self-triggered controller, and emits no self-action verb.
