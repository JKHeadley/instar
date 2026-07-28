# Side-effects review — token-burn alert terminal delivery

**Class:** Tier 2 retry-controller correction
**Second-pass review:** required
**Driving issue:** `e0666e4e`

## Change and authority

`BurnAlertDelivery` is a delivery-state controller, not a burn-policy authority.
It does not decide whether to throttle or whether an alert deserves emission. It
only classifies the narrow Telegram responses that prove a destination is gone,
persists that terminal fact, and moves delivery into the existing Attention
funnel. The throttle decision remains entirely in `BurnThrottleRunbook`.

## Over-block

Only explicit deleted/closed/missing-topic responses become terminal. Timeouts,
rate limits, and ambiguous transport failures remain retryable. A changed topic
ID is treated as a new destination, so repairing configuration is never blocked
by stale state.

## Under-block

The state is keyed to the configured topic ID and loaded at construction, so a
process restart cannot reopen the dead-topic loop. Both initial burn alerts and
delayed verifier follow-ups share the controller. The verifier is also given the
operator-configured topic ID instead of its previous hard-coded default.

If Attention cannot reach Telegram, `createAttentionItem` still persists the
item in its durable store. The controller also logs the failure loudly. Thus the
terminal event has durable evidence even during a broader Telegram outage.

## Interactions and blast radius

- Successful alert delivery is unchanged apart from awaiting the same promise
  inside the controller.
- Throttle installation remains non-blocking; the runbook observes delivery
  rejection without letting it alter the throttle outcome.
- Identical rerouted alerts use a content-derived stable ID, so Attention's
  existing deduplication prevents duplicates.
- While Attention custody is pending, the state file temporarily retains the
  original alert body so a restart cannot lose it. It is removed immediately
  after Attention accepts the stable notice ID. The file contains no credentials.
- State writes are atomic and mode `0600`. There is no schema migration; an
  absent or unreadable file safely means no destination has been quarantined.

## Cross-machine posture

Machine-local by design. Telegram topic configuration and the adapter's
Attention store are agent-local delivery surfaces. A machine quarantines only
the topic it actually attempted; changing its configured ID restores normal
delivery independently of other machines.

## Rollback

Reverting the change restores the old sender. The small state file is inert when
the controller is absent and can be ignored; no migration or cleanup is needed.

## Verification

- Real terminal-response fixture and restart simulation.
- Attention-handoff failure and controller-state-write failure restart fixtures.
- Corrupt-state fail-closed fixture.
- The shared self-action convergence ratchet models 60 hourly ticks against a
  permanently deleted topic and proves primary sends settle at one.
- Transient-error contrast test.
- Changed-topic recovery test.
- Existing Phase 4 and Phase 6 burn suites.
- TypeScript build and full lint.
- The terminal-response classifier uses an error-specific variable rather than a
  conversational-message signature, preserving the keyword-intent ratchet's
  distinction between transport errors and operator intent.
- State-write and temporary-file cleanup degradation are explicitly observable:
  the former is logged and returned to the independent Attention-custody guard;
  the latter is a documented best-effort cleanup after the primary failure.

## Independent second pass

**CONCUR.** The reviewer required three durability corrections before
concurrence: retain the original alert until Attention custody; use Attention as
a second restart witness when controller-state persistence fails; and ensure a
configuration change can recover even while the old handoff is pending. A final
edge case now merges the retained and current alerts if the replacement topic is
also terminal, so neither payload is overwritten. The reviewer confirmed the
terminal classification, promise handling, stable-ID deduplication, corruption
failure direction, and atomic mode-0600 writes are consistent with the invariant.

## Class-Closure Declaration

**Defect class:** `unbounded-self-action`  
**Closure:** guard  
**Enforcement:** ratchet  
**Citation:** `tests/unit/self-action-convergence.test.ts`

The registered `burn-alert-terminal-delivery` pressure model drives 60 hourly
ticks against a permanently deleted topic and proves that primary delivery
settles at one attempt. The shared ratchet also repeats the model at twice the
horizon and enforces the same bound, so the brake is horizon-independent rather
than a temporary cooldown.
