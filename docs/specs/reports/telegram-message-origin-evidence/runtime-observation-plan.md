# Runtime identity and model observation implementation plan

Planning only; no runtime source changes. Follows `implementation-interfaces.md`, using `src/messaging/telegram-origin/`. Grounded in fresh worktree main `77df8be42` and read-only local runtime evidence. The evidence below is sufficient to implement parser paths for all five harnesses without pretending every fixture/native canary has already been built or run.

## Minimal module interfaces

`SessionRegistry.ts`: `issue(binding) -> token`, `verify(token) -> bound session | typed refusal`, `revoke(sessionId)`. Binding contains agentId, machineId, Instar sessionId, startedAt/incarnation and registered framework. Store verifier hash, not token. Re-check live Session status/incarnation on preparation. Tokens authorize origin preparation only. Spawn integration follows the existing bind-token callback pattern, but neither existing ledger tokens nor conversation-bind tokens are silently promoted into this new scope.

`RuntimeOriginObserver.ts`: `track(binding, nativeSource)`, `refresh(sessionId)` (bounded asynchronous work), `get(sessionId) -> RuntimeOrigin observation`, `invalidate(sessionId, reason)`, `stop()`. `get` does no filesystem/network scanning. Source adapters return `{nativeSessionId, turnId, modelEvidence, configuredModel, sourceEventRef, observedAt}`. Preserve a separate configured value; never overwrite observed evidence with requested launch flags. Invalidate on incarnation/native-session replacement and on a new turn before its model evidence arrives.

`runtimeSources.ts`: pure per-harness record parsers plus exact-path adapters. Keep the first implementation together to avoid a framework-wide event-bus redesign. The worker tracks byte offsets/partial lines for JSONL, changed snapshot versions for Gemini, and bounded current-turn evidence. Only sanitized model/identity metadata crosses to the serving thread. Exact native session path discovery happens on track/rebind, not every send.

SessionManager changes are limited to all four token-injection launch paths, source binding after native session registration, and invalidation/revocation after successful termination or supersession. Existing hook association via request `instar_sid` alone cannot authenticate origin; require the scoped token on the new association route or authenticated hook envelope. Route bodies cannot choose another session's observation.

## Concrete five-harness sources

### Codex

- Existing `CodexDeliveryObserver.ts` reads native `event_msg` task_started/task_complete with `turn_id`, and tracks bounded JSONL offsets. `CodexRolloutParser.ts` confirms persisted `turn_context.payload.model`; it currently loses turn association and requires usage, so do not invoke it directly for origin.
- Resolve `Session.claudeSessionId` as the actual Codex UUID through the existing path machinery, honoring CODEX_HOME/subscription home. Verify the file's session_meta UUID, then associate turn_context model with its native turn_id/current task_started boundary. A newer turn lacking model evidence invalidates an older turn's model.
- Positive fixture: two native task/turn-context sequences with different models and UUID-bound tool-call/assistant records. Negative: missing second model, mismatched turn ID, partial line, wrong session_meta, no token_count yet. No-usage first-turn observation must still work.

### Claude Code

- Existing `TokenLedger.ts:685` already reads actual assistant `message.model`. Use the submitting session's main transcript; tool-only user results and subagent files are not new human turns or the author's model.
- Resolve exact native UUID and config-home-aware Claude transcript. Anchor model evidence to the most recent genuine user turn/root message and subsequent main-session assistant record. Native assistant UUID/request reference is suitable evidence identity; distinguish an internal source-derived turn key from a provider-issued turn ID.
- Positive fixture: main assistant model differs from requested `Session.model`; tool result continues the same turn. Negative: helper assistant has another model, a newer genuine user turn has no assistant observation, or the native UUID changed. Existing TokenLedger parser fixtures provide the model-field precedent, but the new association tests remain required.

### Gemini CLI

- Verified installed CLI **0.53.1** source, `/usr/local/lib/node_modules/@google/gemini-cli/bundle/chunk-2NH5AG3B.js:285544`: ChatRecordingService `recordMessage` assigns model on `type:'gemini'` messages and stores message id/timestamp. At line 331087, actual generation completion calls `recordMessage({model,type:'gemini',content:responseText})`. Tool-call records also retain model. Synthetic records can legitimately omit it.
- Existing `gemini-cli/observability/sessionPaths.ts` resolves exact UUID in `.gemini/tmp/<project-hash>/chats/session-*`; use it with the actual home. Read the native JSON/JSONL conversation snapshot asynchronously and retain only current user-message id plus subsequent Gemini message id/model/timestamp. Do not use the one-shot adapter's `providerSpecific.model`, which currently returns the original requested model even after fallback.
- Positive fixtures derived from this recording schema: user message followed by Gemini text/tool-call message with model; next user turn plus a different observed fallback model. Negative: synthetic Gemini entry without model, stale prior-turn message, wrong UUID, partial rewritten snapshot. Installed-source schema is verified; a sanitized native recording fixture should accompany implementation before its positive canary is claimed.

### Pi CLI

- Verified primary upstream source: [session-manager.ts](https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/src/core/session-manager.ts), lines 30–64 and 338–348. Session JSONL has `type:'session'` header and id/cwd; entries contain id/parentId/timestamp; `type:'message'` wraps an assistant message with `provider` and `model`. `model_change` records contain provider/modelId but are configuration transitions, not proof of a generated assistant response.
- Instar already pins interactive `--session-dir` to `.instar/state/pi-sessions` (`SessionManager.ts:5658`). Its existing RPC adapter exposes native message_start/update/end and turn boundaries. Prefer assistant message.model from the active RPC turn; for TUI use the exact native session file and entry parent chain, never a different branch's latest global model_change. No locally installed Pi binary was located in this planning pass.
- Reuse `tests/fixtures/pi-mock-provider` and `tests/integration/pi-rpc-adapter-real-binary.test.ts` to capture an actual native assistant event/session file without provider credentials or spend. Positive fixture must show provider/model from the returned assistant; add a second configured model and branch/restart controls. Until captured, this is source-grounded schema, not a claimed live canary. Neither `get_state.model` alone nor launch argv may produce observed author evidence.

### Grok Build

- Found real local CLI **1.0.5** session files: `$GROK_HOME/sessions/<percent-encoded-cwd>/<native-session-UUID>/events.jsonl`, `chat_history.jsonl`, and `updates.jsonl`. Inspected only structural keys/model fields; no conversation content or secrets copied.
- `events.jsonl` has `type:'turn_started'` with session_id, turn_number, model_id, schema_version, ts; turn_ended is separate. `chat_history.jsonl` actual assistant rows have `type:'assistant'`, model_id, model_fingerprint, reasoning_effort. Genuine user rows carry prompt_index; synthetic user rows can carry synthetic_reason.
- Crucial observed distinction: turn_started and update metadata report **grok-4.6**, while actual assistant rows report **grok-4.6-build**. Therefore strongest author evidence is assistant.model_id; use turn_started only for runtime turn binding/configured hint, not to override the actual assistant model. Native events are a concrete replacement for the current FrameworkSessionStore empty Grok path in this feature.
- Positive fixture: sanitized turn_started/user prompt_index/assistant sequence retaining that differing model pair. Negative: failed turn with no assistant, stale prior prompt_index, synthetic user injection, wrong session UUID. Link separate streams only through verified native identity/turn boundaries; do not assume turn_number equals prompt_index without a fixture proving it. A source-derived history-turn key is preferable to a guessed cross-file join.

## Bounded recovery and coverage

Use the existing observer's byte/row/time-budget pattern, with async worker I/O. Cache keys include Instar incarnation, native UUID and current turn/source generation. File replacement/truncation invalidates prior offsets/evidence. Gemini snapshot rewrites are atomic-or-incomplete observations, not append-only assumptions. An unreadable/oversized/unbound source returns explicit unknown or separately labeled configured evidence while background work retries within the existing observation budget.

Fixture evidence status is recorded honestly: Codex/Claude have existing parser precedents; Gemini has installed source; Grok has measured native metadata; Pi has verified upstream schema plus an existing hermetic native-binary fixture harness. Implement positive controls for each, then production initialization must wire those real adapters. An always-unknown default adapter is not an acceptable completed implementation.

All prepared sends freeze the selected observation. Later stream growth, model changes, session termination and topic movement cannot rewrite that origin. The helper/call-ledger automation pathways remain explicit producer contexts in the parent service, not destination-derived sessions.
