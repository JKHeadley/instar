# Working implementation interfaces (reviewable planning, no runtime implementation)

Use src/messaging/telegram-origin/ for tightly related origin modules/types to avoid unrelated large-file ownership conflicts. Expose a small public TelegramOriginService entry point to integrations.

- OriginEvidence: value string|null, status observed/configured/unknown/not-applicable, sourceEventRef/observedAt/reason.
- RuntimeOrigin: agent/machine identity + session incarnation/current turn/harness/model evidence or registered automation producer. SessionRegistry verifies opaque caller credential; route body cannot supply this authority.
- OriginContext: AsyncLocalStorage scope around an admitted logical operation, carrying immutable resolved producer and display snapshot across adapter calls; never destination pin lookup. Explicit context for remote sealed operation and deterministic automation.
- OriginStore: asynchronous worker-backed immutable insert/get/list/append receipt APIs. Credential-owner PendingRelayStore transaction owns executable child claim/reclaim fencing; evidence sinks cannot dispatch.
- PreparedOperation: stable originId/operationId, canonical digest/destination, bounded list of sealed exact request variants, child IDs, absolute deadline and attempts. Wire boundary dispatches stored bytes. Authorized signature renewal creates new immutable materialization under existing child budget.
- TelegramOriginService: prepare logical operation, validate/dispatch sealed child via transport callback, record suppression and receipts, execute stored recovery, hold state/notification, query audit and coverage.
- telegramFetch: retains original visibility/serialization validation before any footer, then requires origin enforcement for reader-visible effects; non-message metadata ops remain footer-free. Bot token supplied only to wire callback, never record body/header URL secret.
- Broker: owns dedicated profile/private CDP pipe, accepts prepared references, narrow upstream version-tested API bridge only. Same-message ASP; real server message ID correlation. Activation checks replace generic writable profile consumers.
- SessionManager mint callback injects INSTAR_ORIGIN_TOKEN into all four launch paths. Resolve actual model through bounded transcript/event observer cache; old observations invalidated by current-turn boundary.
- Production factory assembles real stores, observer, queue owner, transport authority, scope resolver, peer envelope verifier, broker, lifecycle stop and config. E2E builds this factory as production does and defeats missing/no-op deps.

Integration ownership will be assigned before implementation: runtime module+SessionManager; store/outbox/notification; browser broker/profile restrictions; parent common service/egress/server routes/migration/awareness. File overlaps must be coordinated, not silently overwritten.

## Integration facts discovered on current main

- DashboardOperatorSessionStore already issues a separate 15-minute proof on PIN unlock. AgentServer wires verifyDashboardOperatorSession into route context; X-Instar-Operator-Session is the correct operator-read/settings scope source, not the generic bearer token.
- TelegramAdapter apiCall and TelegramLifeline apiCall each retry/reformat internally. Prepared delivery must distinguish definite refusal from uncertain network results; the preclaimed notifier must call one-shot egress directly.
- Web K apiManager.invokeApi has internal retries; private browser process lifetime must bound them, while one durable random_id remains fixed. No outer timeout may create a new operation.
- The worker should share the existing PendingRelayStore SQLite path and entries claim authority, with new retained evidence/plan/materialization tables. Legacy listReady/stampede/purge excludes prepared children; the recovery authority uses the async origin port for them.
- Policy checks for outage notices use separate live config/ownership projections with <=30-second independently refreshed validity, never the failed origin worker. This is directly fault-tested alongside no-authority suppression.
- Runtime observation planning has concrete positive controls for all five harnesses; see runtime-observation-plan.md. Grok actual assistant.model_id differs from requested turn_started.model_id, so choosing the configured start event would be false attribution.
