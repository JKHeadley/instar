# Side-Effects Review — gates never route to a signed-out framework; failed LLM calls record a fixed error class; PromptGate failure backoff

**Version / slug:** `gate-error-class`
**Date:** `2026-11-25`
**Author:** `Echo`
**Second-pass reviewer:** `independent cross-model review (codex-cli), appended below`

## Summary of the change

Tier 1 by my declaration (about 9 runtime/test files, ~600 LOC with tests; one design pass, first commit attempt). CMT-2289, approved by the Chief of Staff. Three parts:

1. **Routing (the cause).** `src/commands/server.ts` built the internal active-framework set from `buildProvider(fw) !== null` only. For `gemini-cli` that is "binary detected", so an installed but signed-out Gemini won the `gate` category under `LATENCY_SENSITIVE_FRAMEWORK_PREFERENCE` (pi → gemini → codex → claude) and every PromptGate / UnjustifiedStopGate / MessagingToneGate call failed (Bob: 51/51 on gemini-cli, no Gemini account). The filter is now the pure `selectActiveInternalFrameworks(preference, default, build, hasLogin)` in `src/core/internalFrameworkDefault.ts`, and `hasLogin` is `hasUsableInternalLogin()` from the new `src/core/frameworkLoginPresence.ts`: gemini-cli requires `~/.gemini/oauth_creds.json` with a non-empty access or refresh token (moved out of `crossModelReviewer.ts`, which now imports it); every other framework returns true. `GEMINI_CLI_FRAMEWORK` joins `frameworkFacts.ts` so the framework-name ratchet does not grow.
2. **Error class.** `src/core/llmErrorClass.ts` (pure, total) maps a thrown provider error to one of `rate-limit | capacity | auth | timeout | max-turns | spawn-error | no-route | parse | cli-exit | other`. `CircuitBreakingIntelligenceProvider` passes it on the error row; `FeatureMetricsLedger` stores it in a new nullable `error_class` column (added at open via the existing `ADDED_COLUMNS` path), clamps unknown values to `other`, ignores it on non-error rows, and exposes `errorClasses` per feature on `byFeature()` and on reliability components (`/metrics/features`, `/health`). Rows from before read `unrecorded`. No message text is stored.
3. **PromptGate.** A failure of the LLM call itself (only the awaited call, not parsing or emitting afterwards) now backs off that session's pane fingerprint (30 s doubling to 5 min; at most 60 s for the self-recovering classes rate-limit, capacity and timeout) and reports `PromptGate.llmDetect` to `DegradationReporter` with the class only, at most once per class per 30 min. Cleared on success, changed pane, `onInputSent`, `cleanup`.

Plus an awareness entry `src/data/awareness/llm-error-classes.md`.

## Decision-point inventory

- **Internal framework routing default (changed).** Which framework the computed default policy may pick. Narrowed: a framework with no usable sign-in is excluded. Operator-set `componentFrameworks` bypasses the computed default entirely and is unaffected (`src/commands/server.ts` `resolveConfig`: `if (operatorSetComponentFrameworks) return live;`, so the active set is never consulted for explicit routes or their failureSwap). The agent default is always active, so the selection can never be empty and no gate is stranded.
- **PromptGate LLM detection cadence (changed).** When the LLM is consulted. Narrowed after failures only; regex detection and the prompt/relay decisions themselves are unchanged.
- Metrics fields: no decision.

## 1. Over-block

- A Gemini login that lives somewhere other than `~/.gemini/oauth_creds.json` (for example env-key auth) is now treated as not signed in for automatic internal routing, so the gate goes to the next framework. That is a deliberate deny-safe choice: Instar does not use API keys by default, and the gemini CLI reads only that file for OAuth. The framework remains usable through explicit operator routing.
- PromptGate backoff: a pane whose LLM check failed is not re-asked until its backoff expires if it does not change at all: up to 5 minutes for a persistent failure (auth, no route, cli-exit, …) and at most 1 minute for a self-recovering one (rate-limit, capacity, timeout). So after a brief outage, a real blocking prompt on an unchanged screen can be recognised up to about a minute later than it otherwise would have been. Under a persistent failure the old code never recognised it at all (every tick failed). Mitigations: regex detection still runs every tick; any pane change, sent input, a success or cleanup clears the backoff at once; a failure whose call was overtaken by sent input or cleanup (cache generation advanced) records no backoff.

## 2. Under-block

- Codex sign-in is not probed here (it resolves per call through the subscription pool); a codex-routed gate on a machine with no codex account would still fail, but now its rows say `auth`/`no-route`, so it is visible.
- The gate category may now land on codex-cli on machines that had a signed-out Gemini; codex is the slowest off-Claude framework (comment in `internalFrameworkDefault.ts`). Gate callers with their own short races (UnjustifiedStopGate 2 s) may time out and fail open there. That is the pre-existing chain design for agents without Gemini, not introduced by this change, and the new error classes make it measurable.
- Classification is by error shape; an unfamiliar provider message lands in `other`, still counted.

- Error class precision: a CLI error message can echo the command line, including part of the prompt, so a prompt word can occasionally select the wrong label. Structured signals (killed child, AbortError/TimeoutError, SyntaxError, the capacity flag) are checked first and cannot be faked that way. The label is a signal: it is stored and reported, and PromptGate uses it only to choose its 1-minute or 5-minute backoff cap, so a wrong label can shorten or lengthen one pane's LLM re-check delay within those bounds. It never blocks an action or a message, and regex detection keeps running.
- Sign-in is read once at boot (the active set was already memoized at boot by design, provider-fallback spec §4.6). Signing in to or out of Gemini takes effect at the next server restart. A revoked but non-empty refresh token still counts as signed in; its calls then fail with class `auth`, now visible.

## 3. Level-of-abstraction fit

Right layers: the active-set filter is the single place the computed default decides what is routable, so the sign-in condition belongs beside it (pure helper, injected probes). The error class is assigned at the one funnel every provider call passes through (`CircuitBreakingIntelligenceProvider`) and stored by the one ledger. PromptGate's backoff is local to the caller that re-polls.

## 4. Signal vs authority compliance

Compliant (`docs/signal-vs-authority.md`). The error class and degradation report are signals; the class's only behavioural use is selecting PromptGate's re-check backoff cap (60 s or 5 min), which narrows how often a failing LLM call repeats and never blocks anything. The routing change removes an unusable target from automatic selection; it adds no blocking authority, and the PromptGate backoff only reduces repeated failing calls; it never blocks an action or a message.

## 5. Interactions

- `crossModelReviewer` now imports the shared Gemini creds check; behaviour identical (same path, same shape test).
- `/health` hot path: `reliability()` stays one grouped query, now grouped by `(feature, errorClass)` and folded in JS; same index, row count bounded by features × classes.
- `byFeatureCore` adds one grouped query over error rows only, inside a try/catch.
- The spend rollup and decision-quality tables are untouched.
- Sentinel/reflector categories use the same active set, so a signed-out Gemini no longer appears in their `failureSwap` tail either (it would have failed there too).

## 6. External surfaces

New optional fields (`errorClasses`) on `/metrics/features` rows and reliability components (also on `/health`). Additive JSON; existing fields unchanged. No new routes, config keys or messages. The DegradationReporter feature `PromptGate.llmDetect` is new.

## 7. Multi-machine posture

Machine-local by design: each machine probes its own installed CLIs and sign-ins at boot (the active set was already machine-local per §5 of the provider-fallback spec), and each machine's metrics ledger records its own calls. Nothing replicates; reads stay per machine as before.

## 8. Rollback cost

Revert the commit. The `error_class` column stays in existing DBs, nullable and ignored by older code. No config or state repair.

## Second-pass review

Codex was tried first, read-only, but did not finish within 5 minutes under host load (stopped by the time limit, no verdict). Independent review then ran as a separate `claude -p --model sonnet` call that saw only this artifact and the source diff.

**Reviewer (first pass): Concern raised.** Points and disposition:
1. *Diff also removes Telegram send-policy code.* Not this change: the shared `origin/main` ref moved after this branch's base, so a two-dot diff showed newer upstream commits reversed. The merge-base diff touches only the 10 files listed in the summary. The branch is rebased onto current main before push.
2. *Backoff can delay a real prompt after a transient error by up to 15 minutes.* Accepted. The base is now 30 s and the cap 5 min, and self-recovering classes (rate-limit, capacity, timeout) cap at 60 s. Test added.
3. *No cache-generation check; the catch also covered parse/emit.* Accepted. A failure whose call was overtaken by `onInputSent`/`cleanup` records no backoff, and only the awaited LLM call is classified and backed off; parse/emit throws keep the old silent behaviour. Tests added for both.
4. *Echoed prompt words can mis-set the class.* Partly addressed: structured signals are checked first. The residual imprecision is documented above; the label only selects a bounded backoff cap and never blocks.
5. *componentFrameworks bypass not visible in the diff.* Cited above with the exact line.
6. *Sign-in snapshot at boot; a revoked refresh token counts.* Documented above.

**Reviewer (second pass, on the revised merge-base diff): Concur with the review.** It confirmed the fixes resolve the code concerns and that the merge-base diff holds only the 10 listed files. It asked for one wording fix: the class is not purely diagnostic, since it picks PromptGate's backoff cap (now stated in `llmErrorClass.ts`, §2 and §4), and judged that effect bounded and non-blocking. It saw only the artifact and the diff, so it did not check the tests, the bypass line or the rebase; those are covered by the test runs and the cited line above.
