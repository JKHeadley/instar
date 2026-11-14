# Side-Effects Review — recommended services yes path

**Tier 2.** Spec: `docs/specs/recommended-services.md`, Yes and More machines. It adds a route with no bearer token that can create authority, though no real service can reach that authority yet.

## Summary

- `GET /recommended-services/:id/confirm` mints a single-use token bound to owner, service, machine, offer text and the nos known at that moment. `POST` takes the token and the PIN and saves the yes.
- A yes row is also the grant. It names one machine and the nos its writer knew about, so a crash can't leave one without the other.
- `activeGrant` is what a recipe will read. It uses those lists instead of timestamps, so clock skew can't revive a voided grant.
- A page at `/dashboard/service-yes` under the pairing page's strict policy, and a "Set this up" link in the dashboard row when a service is available.
- A yes records an approval and opens a commitment. A failure there is reported and doesn't undo the yes.

## 1. Over-block

- A no that hasn't replicated can void a later yes elsewhere. The person is asked again, which is the safe direction.
- A person with a stale page has to reopen it after a no, a text change or an owner change.
- A connection unlock would refuse gets no PIN box. The page says so.

## 2. Under-block

- **The PIN doesn't prove a person.** The agent can read it. The operator accepted this on 2026-11-03, and the spec says it stops mistakes rather than a hostile agent. `principal` records the owner the yes was confirmed for, not who typed.
- **`activeGrant` doesn't compare the current owner or text.** A grant stands after an owner change until someone says no. No recipe reads it yet.
- **No global PIN cap if the durable attempt store failed to load.** Unlock keeps an in-memory one there. The per-address limit still applies.

## 3. Level-of-abstraction fit

The grant is on the yes row because the spec wants both written atomically. Tokens are a small local store, as the spec requires. The PIN limits reuse the unlock route's rule and durable global key, with the shared constants moved to `PinAttemptStore`, instead of inventing a second limiter.

## 4. Signal vs authority compliance

This is authority, held by a deterministic check: token plus PIN. The spec classifies "Is a yes valid?" as an invariant. Nothing brittle decides meaning here. Reference: `docs/signal-vs-authority.md`.

## 5. Interactions

- The shared PIN budget is the point: a wrong PIN here counts toward unlock's cap. A wrong PIN repeated from one address stops at the per-address limit first. An empty PIN isn't charged, so it can't lock anyone out of unlock.
- The auth exemption is an exact path shape and two methods. Encoded and case variants fall through to 401, per the review. A memory-boundary session can reach it like anyone else, because the route is public. It gains nothing without the PIN.
- Older peers can't verify a yes row with the new fields and drop it, so they keep their no or unset. That is safe. It should heal at upgrade through the boot re-ingest, which was read and simulated, not run across two versions. No such rows exist yet.

## 6. External surfaces

Two public paths answer every agent, with 409 for every real service today. No message is sent.

## 6b. Operator-surface quality

1. **Primary action:** the page's button names the service: "Yes, set up Jev (TypeSafe)". It is reached after the facts, on purpose.
2. **Raw internals:** none. Refusals have plain words and say nothing changed.
3. **Destructive actions:** none. Declining is closing the page, which the page states. A real No button is required before any service is available.
4. **Plain language at phone width:** viewed at 390x844 and 1280x728, including the success screen.

## 7. Multi-machine posture

Choices and grants are replicated through the existing store. Tokens stay on the machine serving the page, declared `machine-local` in the state coherence registry, matching the spec's `physical-credential-locality` note. A yes authorizes one named machine, and another machine needs its own confirmation.

## 8. Rollback cost

A revert removes the routes and page. Nothing can have written a yes row, because no service is available, so no state needs repair. If a later version had written yes rows, older code would refuse them as unverifiable.

## Must ship before any service is available

These were left deliberately, and a catalog test fails on any real recipe with a comment naming them. A way to say no from the list and the page, a yes for a further machine or a voided grant, and a limit on opening the page. The beacon's daily message to the Lifeline topic also needs checking against "routine recovery stays quiet".

## Second-pass review

**Required: this adds a yes/no authority check.** An independent reviewer read the change twice.

First read: "Concern raised", with three blocking findings, all fixed:

1. The route could test PIN guesses, without unlock's limits.
2. Clock skew could revive a voided grant, which the reviewer proved with a probe.
3. A no replicated from another machine didn't void an open page.

Second read: "Concur with the review", with three smaller gaps found in the fixes, all then fixed: a PIN box on a refused connection, an empty PIN charging the shared cap, and a repeat-yes check that hid a fresh consent. Those last three fixes, and the removal of a cosmetic memory-session exemption the reviewer judged not a boundary, were not re-read by the reviewer.

## Class-Closure Declaration (display-only mirror)

- defectClass: unbounded-self-action
- closure: n/a
- reason: Records a person's confirmation. The agent takes no action from these routes, and setup is not built.
