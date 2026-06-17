# WS5.2 Account Follow-Me — PR4: R12 revocation data-plane

**Slug:** `ws52-account-follow-me-revocation`
**Spec:** `docs/specs/ws52-account-follow-me-security.md` (R12; context R9/S7/S8/R4b)

## What Changed

WS5.2 Account Follow-Me, R12 — the honest revocation data-plane. Revoking "stop following to machine X" is a PIN-gated mandate revoke (control plane — the agent cannot do it) PLUS a real data-plane effect. This PR builds that data-plane effect as a pure, injectable executor (`src/core/AccountFollowMeRevocation.ts`) covering the three R12 branches honestly:

- **Cooperative, online target → `removed`.** The target logs the account out of its config-home, deletes the per-account slot, and `SubscriptionPool.remove(accountId)` fires. Local and total.
- **De-paired / hostile holder → `provider-rotation-required`.** A re-minted (Mechanism B) login is an independently-refreshable real OAuth credential; instar CANNOT force a logout on a machine that left the pair. The honest path is a phone-first instruction to de-authorize / rotate at the provider — never a false "removed everywhere".
- **Offline target → bounded `revocation-pending` → `revocation-failed`.** The wipe becomes a durable pending action fired on reconnect (`onTargetReconnect`). The dashboard shows `revocation-pending`, not `removed`. After an operator-tunable reconnect-deadline, `sweepDeadlines()` escalates it to a LOUD `revocation-FAILED — rotate at provider NOW` aggregated HIGH attention item — never a silently-aging "pending".

Fail-closed throughout: a partial or throwing cooperative wipe falls to `revocation-pending` (never a false `removed`); Mechanism A (dark / refused for Anthropic) always flags `provider-rotation-required` because a delivered credential cannot be un-delivered; flag-off / single-machine is a strict no-op. The module is pure/injectable — it touches no shared production file (the destructive effects — framework logout, slot delete, `SubscriptionPool.remove`) are injected seams.

## Evidence

- 15 unit tests (`tests/unit/account-followme-revocation.test.ts`): both sides of every boundary — cooperative-online↔revoked↔offline, within-deadline↔past-deadline, clean↔partial↔throwing wipe, Mechanism B↔A, dark↔enabled, reconnect-with-record↔no-record, selective multi-record sweep; an explicit assertion that the message never contains "removed" on non-removed paths. `npx tsc --noEmit` clean.
- Side-effects review + mandatory independent second-pass security review (concurred): verified `removed` is reachable only after a fully-successful cooperative wipe, all three branches selected without fall-through, the offline give-up is bounded and loud, Mechanism A never claims success without provider-rotation, signal-vs-authority compliant (data-plane executor, not a new blocking authority), injected seams only. Artifact: `upgrades/side-effects/ws52-account-follow-me-revocation.md`.
- Spec: `docs/specs/ws52-account-follow-me-security.md` R12 (converged, approved).

## What to Tell Your User

Nothing to do — this is internal multi-machine account-sharing groundwork, shipped off by default. It guarantees that when you stop sharing an account with one of your machines, the system tells you the TRUTH about what was removed: it never claims a credential was destroyed everywhere when a departed or offline machine still holds its own login — in that case it surfaces a clear "rotate at the provider" instruction instead. No user-facing surface in this release.

## Summary of New Capabilities

Internal: an honest revocation data-plane for Account Follow-Me — cooperative-target total wipe, provider-rotation instruction for a de-paired/hostile holder, and a bounded offline `revocation-pending → revocation-FAILED` escalation. The system can never claim a credential was destroyed when it wasn't. Dark behind `multiMachine.accountFollowMe`; server-shell wiring (consuming the mesh revoke, scheduling the deadline sweep, dashboard render) is a tracked follow-on increment.
