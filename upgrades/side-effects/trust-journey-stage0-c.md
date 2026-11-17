# Side-Effects Review — Trust journey stage 0, PR C: governed effects

**Version / slug:** `trust-journey-stage0-c`
**Date:** `2026-11-16`
**Author:** `echo`
**Second-pass reviewer:** `independent security review subagent (see below)`

## Summary of the change

Spec: `docs/specs/trust-journey.md` (approved by Justin, telegram 142440, 2026-11-15 22:15 PST), stage 0, decisions 2, 9, 10, 13 and 15, sections 2 and 6a. Third of three stage-0 PRs, stacked on part B (#3230), which added the account-path approval. This part makes external tool calls follow the person's settings.

- **Effect kinds** (`src/data/effect-kinds.ts`): the server derives what an MCP tool call does from its real `tool_name` and `tool_input`: the kind (`service.operation`), reversibility, item count, audience, always-ask items and a stable action identity (tool name plus canonical input). The verb rules the hook used now live on the server. A sign-in rule turns typing or filling a password, passcode or one-time-code field in the browser into the always-governed `sign-in` kind (decision 15). No guessed tool names are listed: an entry is added only with a tool's real name and a test.
- **Admission** (`admission.ts`, the `/operations/evaluate` route): reads are not gated; Instar system services and kinds with an unchanged legacy grant keep today's gate decision; every other kind is governed. A governed kind proceeds only on the person's proven "Do it and show me" or "Just do it" grant, with known scope and no always-ask item; or once, when the person approved that exact call. Otherwise the server sends a one-action card through the account path and answers `ask`; the hook refuses the call (exit 2) and tells the session to continue other work and retry the identical call after approval. One approval admits one call; a changed payload or a second call asks again. Only the serving-lease holder admits a governed effect.
- **Hook migration**: the hook sends `tool_name` and `tool_input`; understands `ask`; its abort rises from 3 s to 8 s; the Codex entry's timeout rises from 5 s to 12 s (Codex kills a slow hook and proceeds). Once the legacy import has run on a machine, a governed call is refused when the server cannot answer; reads and unchanged legacy kinds keep today's fail-open, from a fallback file the server writes at boot and on every trust change.
- **Legacy import** (decision 9): once per machine, every concrete kind (gate config services, read-only services, operation-log services, configured MCP servers, times write/modify/delete) is recorded as a legacy grant keeping today's behaviour (blocked where the gate is off). A machine joining later imports only kinds already legacy somewhere. Sign-in, wildcards and system services are never imported. A person's later change makes the kind governed.
- **System services**: `parity-sentinel` is on a code-constant allowlist; the migrator's trust seed is retired; the parity sentinel remediates by default and turns flag-only only on a narrowing a person set.
- **Outcome store**: a second replicated store (`trustJourneyOutcomes`, bounded retention, forced on) gets one "not yet checked" row per admitted governed effect.
- **Corrupt-state startup**: an unreadable trust profile is flagged; the holder rebuilds every setting and restriction from the committed change log (an unproven raise falls back; a key with unreadable history becomes blocked, never merely ask), and the owner gets the existing one notice.

Size: 4 new modules, edits to 12 source files, 3 new test files plus updated hook, parity and journal tests. Tier 2.

## Decision-point inventory

- **What kind is this call?** `invariant`, from the real tool name and input; unknown verbs default to the stricter `modify`; the sign-in rule can only make a call stricter.
- **Admit, keep today's gate, or ask?** `invariant`: structured rules over the kind, the legacy record, the person's proven level, the audience and the always-ask items. No LLM is consulted (spec 6a: admission never waits on an LLM in stage 0).
- **Hook when the server cannot answer.** `invariant`: the fallback file's exact kinds and read names.

## 1. Over-block

- A new service an agent starts using after the update asks on its first write, modify or delete. That is decision 10 ("new installs and unused kinds grant nothing"); the person can approve the call, or grant the kind.
- With no explicit table entries yet, a governed kind's audience is unknown, so even a "Just do it" grant asks for a recipient-bearing call (spec section 9: unknown scope requires approval). Grants take effect without asking for self-scoped effects and for kinds whose entries name their recipient fields; entries are added with real tool names.
- After the import, reads on a service that is not fully legacy go to the server instead of the hook's name fast path (a small latency cost).
- A governed call on a machine that does not hold the serving lease is forwarded once to the holder (6 s, inside the hook's 8 s); if the holder does not answer, the call waits (fails closed).

## 2. Under-block

- The hook is agent-editable: the spec's threat model says hook-mediated enforcement is a checkpoint for an honest agent, not custody.
- Kinds already in use are legacy and keep today's behaviour until the person changes them (decision 9).
- If the holder cannot be reached, a governed call on another machine is refused; this fails closed and is reported in plain words.

## 3. Level-of-abstraction fit

Kind derivation and admission are server-side, at the one route the hook already calls; the existing gate keeps deciding legacy kinds; the account path from part B carries the ask. No new gate.

## 4. Signal vs authority compliance

Deterministic rules over structured inputs decide admission; the gate's risk classification still informs legacy kinds exactly as before. Nothing judges meaning (stage 3 adds that, and can only narrow).

## 4b. Judgment-point check

The kind classification is listed in the spec's decision-point table as a judgment candidate with a deterministic floor (no match asks, caller classification only narrows). This PR ships that floor; no arbiter beyond it.

## 5. Interactions

- `/operations/evaluate`: the revival-mode block still runs first; the gate-off 404 still applies (with the gate off everything non-read stays refused, as today).
- `show-plan` advice for legacy kinds is unchanged.
- `AdaptiveTrust`: a corrupt-load flag and a rebuild setter that does not re-log; the change observer now also refreshes the hook's fallback file.
- `FrameworkParitySentinel.shouldRemediate`: a default entry remediates (system service); a person-set narrowing still turns it flag-only.
- Coherence journal: one more kind (`trust-outcome-record`, rotateKeep 4).

## 6. External surfaces

- New `ask` action from `/operations/evaluate` (`reason`, `trust`, `requestId`). An older hook treats it as an unknown action and refuses (exit 2), which is the safe direction.
- New one-action cards in the owner's direct chat ("Do this once: … with exactly: …").
- New files: `state/trust-legacy-kinds.json`, `state/trust-journey-outcomes.jsonl` (where the journal is off); config `trustJourney.legacyImportedAt` per machine.
- Agent awareness: the entry now explains `WAITING FOR APPROVAL`.

## 6b. Operator-surface quality

No dashboard markup changes. The one-action card leads with what will be done, shows the exact call, says it covers this one action only, and carries the code, the expiry and the disclosure.

## 6c. Agent Proposes, Operator Approves

The person approves a server-prepared card for one exact call; the card text is written by the server from the tool name and input, and the approval is bound to the action identity of exactly that input.

## 7. Multi-machine posture (Cross-Machine Coherence)

Replicated: legacy grants, one-action approvals and dispatch records are `trust-grant-record` rows in the `trustJourney` store; outcome rows are in `trustJourneyOutcomes`. Legacy grants carry their machine and apply on that machine. Only the serving-lease holder admits a governed effect; another machine forwards the call to it once, and waits (fails closed) if it cannot be reached. The fallback file is per machine by design: it reproduces that machine's gate config for when its own server cannot answer.

## 8. Rollback cost

Reverting restores the old hook on the next update (hooks are always overwritten) and today's gate path for every call. Store records and the import marker are inert to older builds. One-action approvals not yet used are simply never consumed.

## Conclusion

Pending the second-pass security review below.

## Second-pass review (if required)

**Reviewer:** an independent Claude security reviewer (fresh context, given the diff, the spec and this write-up).
**Independent read of the artifact:** first pass CONCERN with 3 must-fix and 6 should-fix findings, all changed in code before the re-check:
- One approval admitted two racing calls (the store key was reserved only after the durable wait). The key is now reserved before the wait, and an approval whose dispatch is pending is no longer unused. A test races two identical calls on a slow, journal-like sink.
- An input the card cannot show exactly (the hook's too-large stand-in, a non-object, over 2,500 characters, or a tool name over 120) could be approved once and match every such call. It is now never approvable once and sends no card.
- An earlier one-time approval survived a later "Don't do this" or unreadable history. Both are now checked first; a blocked kind is refused naming the setting, with no card. One-time approvals expire with the card.
- Legacy status is compared by change id, recorded at import. A machine joining later imports only kinds still unchanged-legacy somewhere, and an import that stopped part-way resumes.
- With the server unreachable after the import, the hook never passes browser typing or form filling (possible sign-in), and the fallback file's existence counts as imported even if the config marker is lost. The route refuses tool calls when the trust runtime failed to start after the import.
- The sign-in pattern is wider (passkey, recovery, backup and security codes, PIN, MFA, TOTP, some non-English words). A code-driven fill (browser_evaluate, browser_run_code) is not caught by the pattern and stays a governed modify that asks.
- Card text escapes direction-override, zero-width and line-separator characters. The config-patch applier refuses to rewrite a settings file it cannot read.
- Re-check found one new must-fix in the legacy change: if every legacy kind had been changed, a machine joining later did a full fresh import. The import now knows another machine imported first, and then imports only kinds still unchanged. A test changes every kind, then joins a second machine. The route's missing-runtime refusal now also checks the fallback file, like the hook.
- Final re-check verdict: CONCUR (no must-fix remains).
- Left as is, with reasons: the corrupt-state rebuild. Confirmed in code: the legacy gate's only trust input (updateAutonomyDefaults) has no callers. The legacy gate never reads trust levels, and a governed kind with no recorded grant already asks.

## Evidence pointers

- Unit: `tests/unit/trust-journey-governed-effects.test.ts`, `trust-journey-corrupt-state.test.ts`, `hook-installation.test.ts` (the hook sends the tool, an ask exits 2, fail-closed after the import, reads go to the server unless the service is fully legacy), `PostUpdateMigrator-paritySentinelTrust.test.ts`, `monitoring/FrameworkParitySentinel.test.ts`.
- Integration: `tests/integration/trust-governed-effects-routes.test.ts` (legacy kind keeps the gate; a new kind asks; the owner's reply admits the identical call once; a second or changed call asks; browser sign-in asks).
- Live proof: with part B's, in the morning, on a throwaway with a fresh test bot.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable.

## Rebase and rule-test fixes (2026-11-16, adopted by topic 143810)

Rebased onto main. Part A was skipped because main already has its later version (#3222). Parts B and C were resolved, keeping both sides in `src/commands/server.ts` (part B's trust-journey setup; main's newer server constructor plus part B's `trustAccountPath` argument) and an import in `src/server/routes.ts`.

The silent-fallback rule test counted two new silent catches:
- the failed-apply catch in `AccountPathService`, which already tells the person the change didn't take effect, now carries the `@silent-fallback-ok` note;
- the hook script's config read in `PostUpdateMigrator` falls back to a file read just below, and now carries the note;
- the approval-receipt intake catch in `TelegramAdapter` was genuinely silent: it now logs the error before treating the message as not an approval. An unread receipt approves nothing.

Trust-journey tests pass (105/105), and the rule tests pass (16/16).
