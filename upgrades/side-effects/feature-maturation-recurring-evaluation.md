# Side-effects review — feature maturation recurring evaluation

## Scope

Adds measure-only per-feature observation/evaluation rows to the existing blocker-lifecycle SQLite owner, extends existing rollout metadata, and adds bounded maturation fields to existing summary/trend responses.

## 1. State and persistence

Two additive tables share the existing SQLite handle, WAL policy, close path, registry, 90-day retention, and bounded prune pass. No authoritative rollout or feature state moves into telemetry. Rollout records gain one optional validated contract; old records remain valid.

## 2. Runtime and performance

One boot-delayed and six-hour unref'd evaluation timer runs only when the existing blocker-lifecycle development gate resolves on and an InitiativeTracker is injected. A pass is capped at 512 features and 16 metrics per feature. Reads and writes are indexed and fail-soft; measurement cannot block server boot or feature behavior.

## 3. External and user-visible effects

No outbound message, attention item, external API, model call, flag mutation, or rollout promotion is added. Existing summary/trend JSON gains additive `maturation` fields. Pool peers that predate the field are reported as unsupported rather than as healthy zeros.

## 4. Signal versus authority

Compliant. Metric comparisons are deterministic signals. They cannot write InitiativeTracker, configuration, standards, approvals, or feature flags. Existing human/config promotion authority is unchanged.

## 5. Failure and rollback

Malformed contracts become missing-contract signals; invalid/future observations are rejected; unavailable SQLite degrades reads and guard health. Observation/evaluation write failures return false, and read failures return empty evidence that deterministically becomes insufficient evidence or missed cadence; these fail-soft boundaries are explicitly marked for the repository fallback audit. Disable the existing blocker-lifecycle gate or revert the change. Additive rows become inert and require no destructive rollback.

## 6. Security and privacy

Rows contain bounded feature/metric ids, numeric values, sample counts, source enums/refs, stages, hashes, and timestamps only. They contain no prose, prompt, log content, topic/user id, path, credential, or URL. Pool responses remain authenticated and machine-tagged.

## 7. Multi-machine behavior

Measurements remain per-origin because feature traffic and model routing can differ by runtime. The existing authenticated pool read projects tagged origins without a fleet aggregate, so one machine cannot hide another's missing evidence.

## Review conclusion

Concur. The change extends the intended owners, is bounded and reversible, and introduces no new actuation authority.
