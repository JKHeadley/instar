# Side-Effects Review — Attribution paper trail

**Version / slug:** `attribution-paper-trail`
**Date:** `2026-11-05`
**Author:** `echo`
**Second-pass reviewer:** `fresh-context reviewer subagent; its answer is appended at the end`

## Summary of the change

Anything credited to a person, in an agent's notes, rules or messages, now either resolves to the logged message it came from or says plainly that it has no source. Tier 2: about 40 files, 5 spec review rounds. One service (`src/core/attribution/`) sits behind a PreToolUse write gate (`attribution-gate.js`, on Claude Code and Codex), a new advisory tone-gate rule `B23_UNSOURCED_ATTRIBUTION`, a background send record, a Threadline advisory, background checks on three memory routes, and a daily report that writes nothing to any note. `attribution.enabled` is omitted so the dev-agent gate decides: live on a development agent in `record`, 503 on the fleet. `record` refuses nothing; `enforce` is opt-in. Routes: `/attribution/{check,resolve,find,trace,status,audit}`.

Proportion: Tier 2 work, large because the spec names ten consumers and every channel's reader. Spec review reached the round cap set for it; recorded in its convergence report.

## Decision-point inventory

- Marker does not parse — add — structural validation of a format; refused with the labels as the way through. Applies on `enforce` only, so nothing is refused on the fleet or in `record`.
- Date matches, quote in record, record exists — add — evidence requirements, reached only with the judge running. With no model they do not refuse.
- Record eligibility per channel and strength — add — fields only; a display name alone never maps. Necessary, never sufficient.
- Own words, faithful, is this a credit, new-citation refusal, lineage match — add — judge. Floor: the label path is always open, and `unchecked` with no model or over budget.
- Refuse a note write — add — judge, `enforce` only. The hook passes on error, timeout or no model, counted.
- B23 hold — add — tone gate, the existing single authority; advisory, and a reasoned ack always delivers.
- Which suggestions are shown — add — suggestion only; nothing is written from one.
- Send-record prefilter — add — no authority. A miss loses a history row, disclosed by count and measured by the audit's sample.
- Which path is in scope — add — config list, realpath-confined.
- Outbound review prompt — modify — B23's rule travels with its signal, so every other message's prompt is byte-identical.

---

## 1. Over-block

Only `enforce` can refuse, and it is opt-in. Within `enforce`:

- A note quoting a person with a short fragment and a stronger rule hanging from it is refused as `overstated`; that is the intent, though the judge can be wrong on a borderline line. Floor: the label path always gets through.
- A correct citation to a row older than every machine's log is refused as `cannot-be-shown` if it is new and nothing holds it. The honest way through is `[source unknown]`, even when the person did say it. Declared by the spec.
- A claim written with a role rather than a name ("the operator said") does not match the owner's name and reads `record-not-theirs`. The agent names the person, or labels it. Noted for the shadow step.
- B23 is a nudge, so a wrong citation costs one round trip, never a held message for good.

The graduation numbers (at most 5% false refusals) exist to measure this before any fleet step.

## 2. Under-block

- Shell writes to notes are not gated at write time; the audit reports them. Declared in the spec.
- Sessions on Gemini CLI, Grok Build or instar-native have no PreToolUse equivalent; the audit is their floor. Declared.
- A write whose body exceeds the server's JSON limit is answered 413 and the hook passes, without a counted outcome. The audit reports the note the next day.
- The send record's filter can miss a credit with no known name and no credit word. Measured by the sample.
- Codex `apply_patch` firing PreToolUse is unproven until the live rung; if it does not fire, the audit is Codex's floor.
- A rule with the credit removed and no reason is caught when used to refuse (B23), not when written. Declared.

## 3. Level-of-abstraction fit

Decision logic lives in TypeScript behind one service, and the hook is a thin client on the stop-gate-router pattern. The send gate feeds the existing tone-gate authority instead of adding a parallel one. Eligibility reads existing logs and existing owner resolvers; no new store of messages and no new provenance writers. The hook repeats the default scope list as a fast exit, with the server re-checking, so a drift there can only cost an extra HTTP call or a missed fast path, not a wrong verdict; a drift the other way (hook narrower than server) would under-check and the audit is its floor. Noted as the one duplication.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

No brittle logic holds blocking authority. Marker parsing is a format check with the labels as the way through. The exact facts and `strength` are inputs to the judge, and they only refuse while the judge runs: with no model the text passes as `unchecked`, reported and counted. `attributionSources` is a signal to the tone gate, which remains the single authority. The prefilter spends nothing and blocks nothing.

The no-model pass is a stated exception to fail-closed for a gating call, entered in `tests/unit/no-silent-llm-fallback.test.ts` with its reason: failing closed would block every memory write during an outage.

## 4b. Judgment-point check (Judgment Within Floors standard)

The one static heuristic is the send-record prefilter, at a point where a wrong answer loses a history row. Exempt with the argument in the spec: it spends nothing, blocks nothing, and is disclosed by count. Everything that can refuse is the judge or the tone gate.

## 5. Interactions

- The tone gate's prompt gains one signal line and one rule, only when the signal is present. `renderSignals` needed `attributionSources` added to its presence check, or the rule would silently never reach the model; covered by `tests/unit/attribution-b23.test.ts`.
- `checkOutboundMessage` adds a `finish` listener, which only reads the status. The route's own response path is untouched.
- `/threadline/relay-send` wraps `res.json` beside the existing commitment nudge. The attribution wrapper is installed first, so the nudge writes and attribution joins it rather than hiding it; the nudge's own condition is unchanged.
- The write gate shares a PreToolUse slot with existing hooks. Codex hooks run in a single `.*` group, so the new entry joins it: it exits at once for any other tool. `codexHookArm` sees one more slot in group 0.
- `/semantic/remember`, `/evolution/learnings` and `/evolution/actions` call a void background check after the store write. It cannot change a response.
- The Bash convergence hook and other hooks are untouched.
- An unhandled rejection can exit the server (`uncaughtExceptionPolicy.ts`), and Express 4 does not catch a rejected async handler. Every async route answers 500 on failure, which the hook reads as a pass. The poller reports a throw. Background calls beside a send or store write cannot throw into the caller.
- The audit's model calls run on the feature's own `LlmQueue`, so interactive callers cannot abort them and they cannot consume the shared background share.

## 6. External surfaces

- **Other agents:** a peer's `/threadline/relay-send` response gains text in `advisory`, in `enforce` only. Nothing is ever held. A peer's `GET /attribution/resolve?scope=local` is a new read route.
- **Fleet agents:** the hook script and settings entry arrive through migration and each in-scope note write makes one local HTTP call that answers 503, then passes. `migrateConfig` adds `attribution.mode: "record"`. The `attribution-review` job is added with a zero-token gate that fails while the route answers 503, so it spawns nothing. A CLAUDE.md section is added. No restriction reaches any existing agent.
- **Users:** nothing is sent to a user by this feature. In `enforce`, the agent's own message may be revised or carry a recorded ack.
- **Persistent state:** `<state>/attribution/`: `ledger.jsonl`, gzip archives, `pins.jsonl`, `budget.json`, `report.json`, `audit-state.json`, `lineage-pending.json`, all 0600 with note and message text scrubbed before it is written. Backed up.
- **Spend:** the agent's own subscription, within 200 and 300 model calls a day and 40 a run. Live on Echo at next update, in `record`.

## 6b. Operator-surface quality

No dashboard or operator-facing page is added or changed. `GET /attribution/status` is read by the agent. Not applicable.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Proxied-on-read.** The ledger, pins and report are per machine, and `/attribution/trace` and `/attribution/resolve` merge them through peer fan-out (`poolPeerFetch`, one shared 6s deadline, at most 16 peers, 512KB, `redirect: 'manual'`), reporting `unreachable` for a down machine rather than absence. A `scope=local` answer never fans out. A registered active machine with no usable URL counts as not answering, so a machine that could not be asked can never produce a `not-found`. A peer's rows and candidates are checked for shape, and eligibility re-runs here. Evidence held only on a down machine stays unavailable until it returns. The audit runs on one machine at a time through the existing lease and writes no shared state, so `MEMORY.md` and `CLAUDE.md` gain no second writer. No notices, so one-voice is untouched. Moving the ledger and pins to a replicated kind is required before the fleet rung, stated in the maturation plan.

## 8. Rollback cost

`attribution.enabled: false` stops every consumer at once, read live, with no restart: routes 503, background checks return, the audit's tick returns. Nothing was rewritten in any note by the system, so nothing needs restoring. A PR revert removes the code; the migrated hook entry passes when its route is gone, since a 404 is not `ok`. The state folder can stay or be removed; nothing reads it.

---

## Class-Closure Declaration

`unbounded-self-action`, closure `guard`, enforcement `ratchet`, citing `tests/unit/self-action-convergence.test.ts`. The audit's retry is registered as `attribution-audit-retry`: a failing run backs off from an hour to a day, and its breaker settles to one try a day however long the model stays down.

## Second-pass review
**Reviewer:** fresh-context general-purpose subagent, reading the code; it ran nothing.

First reading raised four concerns, all fixed and re-read by the same reviewer:

1. A rejected async route or the audit's timer could exit the server. Routes now answer 500, which the hook reads as a pass; the poller catches and reports; background calls cannot throw into a send.
2. A registered machine with no usable URL was never counted as not answering, so it could produce a false `not-found` and refuse a real citation. It now counts as not answering.
3. The commitment nudge was hidden when attribution also spoke. Order changed so they join.
4. Report suggestions, Threadline `textRef` and an app message's signed body reached this feature's files unscrubbed. Report text is scrubbed, and pins are now an allow-list of the words plus the fields eligibility reads, with `origin` kept only as a presence flag.

Final ruling: "Concur with the review". Questions on refusal in `record` and on the fleet, brittle authority, note writes: no defect found at any reading.

## After the first Local Verify

Local Verify found census ratchets this change had not met. `AttributionJudge` is now classified on the untrusted-input, judges-claims and injection-exposure axes, its route file is listed for the capability check, two reasoned catches carry their marker, and the default job count moved to 29. No behaviour change.

## Rebase follow-up (2026-11-05 evening)

After a rebase onto main, two conflicts were in hook lists (main added `signin-profile-guard`). Resolving them dropped the explicit 25s Codex timeout on `attribution-gate.js`; it is restored, so the hook passes on its own terms instead of being killed at the 5s default. Three registries are updated for things this change adds: the CLAUDE.md section is listed as shared (both generator and migrator append the same constant), `AttributionJudge` is classified as a pending parser contract (closed verdicts), and one dark-gate row's line number moves by the 7 new attribution default lines. No behaviour beyond the restored timeout changes.
