# Side effects: switching a guard off through the settings API needs the owner's approval (SEC-162)

In plain words: until now, anyone holding the agent's API token could switch off a safety guard through the settings API. That covers any monitoring guard, the input guard and the response review. The check for loosening changes only looked at external operations and evolution autonomy. Now switching a guard off is a loosening like those: it is refused with the existing `operator-approval-required` answer, and the owner approves it through the existing trust request and approval card. Switching a guard on stays free.

Tier 1. Size:
- 3 source files: `src/core/TrustRaiseGuard.ts`, `src/server/routes.ts`, `src/core/trustJourney/TrustJourneyRuntime.ts`
- 1 awareness entry
- 1 new unit test file
- integration cases in two files

## What changes for running agents
- `configPatchRaises` gains `guardOffRaises`. A guard is what the `/guards` inventory calls one: `buildCompleteGuardPosture`, covering every `monitoring.<name>.enabled` or `monitoring.<name>` boolean plus the guard manifest. It adds the two protections outside that inventory:
  - the input guard, which is on unless set false
  - the response review, which is on only when set true

  A raise is any guard on before the change and off after it, compared with the same one-level merge the route writes. This includes:
  - a guard on by default that is written off
  - a guard whose own block is replaced without its on switch, so it falls back to an off default
  - the permission-prompt floor's emergency switch
  - a guard weakened while left on:
    - a manifest guard under `monitoring` put into dry run
    - one of the input guard's three checks turned off, or its action lowered (block, then warn, then log)
    - the response review put into observe-only
- Every caller of `configPatchRaises` gets the rule:
  - `PATCH /config`, which answers 403 before anything is written
  - the bearer single-path writer used by commitment auto-correction, which refuses, so the drift is still reported and nothing is written
  - the trust journey, so the owner's approval card lists the guard by name. `monitoring`, `inputGuard` and `responseReview` join `APPROVABLE_CONFIG_PATCH_KEYS`, one shared list read by the request parser (`parseTrustChange`) and the apply step. Before this change, a guard-off request could not be opened or applied at all. The independent reviewer caught this.
- **Every switch path gets the same card.** That covers a feature switched with the key, from the dashboard after the PIN, or from the owner's paired phone. When one would switch a guard off, the route's refusal opens the owner's approval card automatically, as it already did for the external-operation gate. On a paired phone set up to approve, that card is one tap with Face ID.

  A phone switch cannot simply go straight through. `docs/specs/trust-journey.md` (decision 4, Phones; threat model G9) rules that a phone presence signature is evidence, never authority for a raise, until the custody work supplies a custodian, because the phone list is a file the agent can write. A draft of this change added such a pass-through. The second-pass reviewer refused it, and it was removed. The dashboard after the PIN gets the card too, by the same rule, as confirmed by the Chief of Staff on 2026-11-21.
- **Feature switches that now ask for approval:**
  - turning off the input guard
  - turning off the response review

  Their disable actions replay through `PATCH /config` with the server's own token, so they now come back refused until the owner approves. No feature switch's enable action is affected, and no other disable action is. Turning off the external-operation gate was already a raise. The test `which everyday feature toggles are affected` lists exactly these.
- Unchanged:
  - switching any guard on
  - tuning a guard that stays on
  - every setting that is not a guard
  - the self-action governor's emergency switch, which keeps its own PIN check

## Known limits
- The definition of a guard is the `/guards` inventory, so it includes a few switches that act rather than protect, such as `greenPrAutoMerge`, the session reaper and telemetry. Turning one of those off through the API now also asks the owner. This is deliberate: one definition, the same one the guard tripwire uses. Telemetry has its own route, `POST /config/telemetry`, which is unaffected.
- A commitment whose correction would switch a guard off is refused each time it runs. Its drift is reported again on each check until the owner approves or the commitment is closed.
- On a Telegram-only owner, the approval card is a reply with a code, not one tap. On an owner whose paired phone is set up to approve, it is one tap with Face ID. If the owner never answers, nothing is written, and the guard stays on.
- Other guard tuning that weakens a guard, such as thresholds, is not judged.

## Second-pass review
An independent reviewer worked over three rounds, reading the real code paths.
- **Round one** found that the owner's approval card could not carry guard settings, so a guard-off change was refused with no way to approve it. Fixed with `APPROVABLE_CONFIG_PATCH_KEYS`. It also found the dry-run, observe-only and input-guard weakenings, which are now judged.
- **Round two** refused a draft pass-through for the owner's phone, against `docs/specs/trust-journey.md` decision 4. It was removed.
- **Round three:** concur. Nothing from the grant remains, and the docs match the code.

The Chief of Staff agreed that every guard-off path gets the card, including the extra tap on the owner's phone (2026-11-21).

## Signal vs authority
It adds no new authority. It moves guard-off changes to the existing owner-approval path.

## Rollback
Revert the commit. No state is written.

## Agent instructions
The new awareness entry `guard-off-needs-approval` says what happens and how the owner approves. No instruction text claimed that turning a monitoring guard off already needed the PIN. The PIN line in the instructions is about the self-action governor's emergency switch, and it is accurate. So nothing was removed; the entry adds the true rule.

## Tests
- `tests/integration/trust-account-path-routes.test.ts` (+1): a guard-off request lands as a card, and approving it from the owner's chat switches the guard off.
- `tests/unit/sec162-guard-off-raise.test.ts` (new). It first failed on the old code: 7 of 10 failed.
  - Guard off, a guard on by default written off, a guard block replaced without its switch, and the whole block replaced are each a raise.
  - The input guard and response review switched off are raises.
  - The permission-prompt floor disarmed is a raise.
  - The single-path writer refuses the same.
  - Switching on, tuning, an already-off guard, and settings that are not guards are free.
  - The exact list of feature toggles affected.
- `tests/integration/trust-raise-refusal-routes.test.ts` (+2):
  - guard off gets a 403 naming the guard and writes nothing
  - switching on and tuning still apply

  Integration runs are left to Local Verify.
- Also pass on the M5: `TrustRaiseGuard`, `bearer-config-write`, `feature-enableaction-validity`, `feature-action-applier`, `CommitmentTracker`, `CommitmentSentinel`, `lint-guard-manifest`, `awareness-entry-registry`.
