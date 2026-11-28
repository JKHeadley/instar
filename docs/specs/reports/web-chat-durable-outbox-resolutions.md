# Review Resolution Context

These are the author's explicit responses to prior outside findings, not a claim of independent approval. The full current design remains the reviewed spec.

## Outside Finding Resolutions

- Upload effect before reserve: reserve synchronously before allocation; full/write failure has zero allocation; failed finish leaves unknown and never reallocates the same admitted ID.
- Stop age gap: retained-result lookup first, age before any NEW effect on App/Slack including stops. Existing fresh-stop feature/rate exemptions remain.
- Final chunk lost acknowledgment: GET complete before interpreting absent chunk rows; read-only reconciliation has its own bounded budget after PUT exhaustion.
- Epoch/cross-tab logout: bind once per real sign-in; every entry read and network admission matches its admission epoch. Invalidate durably with cleanup-pending before separate matching-epoch erase; no new session can race old erasure.
- Legacy import/reappearance: receipt atomic with import; untagged unknown session rows hold initially. Logout durably retires the legacy source globally and each resumed sibling erases it before rendering/import.
- Memory/cross-tab ownership: automatic work requires origin-wide Web Locks. Server storage limits/idempotency are not falsely called plaintext-memory ownership. No-lock fallback is explicit bounded user work.
- Credential prompt: exact text choice precedes drainable admission; Secret Drop/cancel leaves zero drainable entry.
- Operation/header time: operation ID/time/path/body frozen, every physical attempt freshly signs corrected header time.
- Retry/401: one target physical result per durable ledger admission. No inner Chats401 loop; separate step budgets, persisted cooldowns; reconnect never resets exhaustion.
- Healthy progress/server cooldown: finite successful progress continues; honor finite Retry-After via one cancellable same-ID timer without resetting attempts.
- Different-message ordering: monotonic opaque per-conversation sequence committed atomically; final admission checks predecessors, explicit user override only.
- Stop deferral/set changes: one live immediate online path may bypass prior upload; no background stop grant. Matched or unknown at admission, or matched in the fresh current exact set, holds recovery. No first-request recall claim.
- Historical restoration/multiple profiles: flag off plus new recovery generation before boot; each profile requires local review of its older generation even after global re-enable.
- Opaque order lookup: independent non-extractable HMAC key and index; same-scope first-key races reuse the durable winner. Grouping equality/sequence is metadata, not destination plaintext.
- Outcome denominator: actual durable admission/acceptance/held/failure transitions and acceptance durations, not current-row-count inference. Storage failure is unknown.
- Definitive key cleanup: all original keyDecision deletion paths use expected-identity cleanup, including same-machine not-found/expired/declined; another-machine answer preserves content.
