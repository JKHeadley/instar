# Token-Burn Detection — Phase 4 ELI16

## What this ships

This is the phase that turns the watcher's eyes into hands. When the detector from phase three notices a component using too many tokens, the new piece in this phase decides what to do — alert you, slow that component down, or both — and actually does it.

The two new pieces:

1. **The rate gate now actually gates.** Phase one shipped it as a placeholder switch that was always "on" — every call let through. Phase four makes it stateful: it can be flipped to "off" for a specific component, automatically flips back after sixty minutes (or whatever duration we set), and refuses to be flipped for the runbook's own work. It also has cryptographic forgery protection so an external attacker who somehow had write access to the agent's process could not install fake throttles.

2. **The runbook that decides.** A new piece called the burn-throttle runbook. When the phase-three detector raises a flag, this runbook looks at three things — is the offender a known instar component, is auto-throttling enabled in your config, and is the runbook accidentally being asked to throttle itself — and chooses one of five outcomes:

   - **Throttle and alert** (the main case): for a known component over the threshold, install a slowdown and tell you about it.
   - **Alert only — unknown source**: for a component the agent does not recognise (a user extension, say), don't throttle automatically — that could break work the user wanted. Just alert.
   - **Alert only — config disabled**: if the operator turned off auto-throttling, alert without throttling.
   - **Throttle failed**: if the slowdown could not be installed (an internal bug, say), say so out loud rather than silently failing.
   - **Alert only — self-attribution**: if the runbook somehow attributes burning to itself (which would be a bug), refuse to throttle itself AND send you an URGENT message — this is the one case where staying quiet is the wrong response. The second-pass reviewer caught this.

## What's safe here

A few things from the reviewer's audit that we made sure of:

- **Three layers of self-protection.** The detector exempts the runbook's own prefix. The runbook refuses to throttle itself. The gate refuses to install a throttle on the runbook's own prefix. Triple defence so one mistake cannot create a loop where the runbook throttles itself out of being able to alert.
- **Throttles auto-expire.** Default sixty minutes. After that, the slowdown lifts on its own.
- **Anti-replay nonce.** Each throttle install carries a unique signal-ID. If a capability token were ever leaked, it could not be reused to install the same throttle twice — the gate remembers consumed signal-IDs.
- **HMAC integrity for any cross-process trust.** The gate carries an HMAC key (when configured). The token a caller presents must be valid against that key. The reviewer noted this only defends the cross-process boundary, not in-process callers — that is documented in the source.

## What you'd notice

When a burn happens (the 2026-05-15 InputDetector pattern, for instance): the dashboard's degradation log fires, then a Telegram message lands explaining what was caught and that you've been slowed down for sixty minutes. The slowdown applies only to the offending component; everything else runs normally. If you decide the slowdown was a mistake, phase five (the next one) adds a one-tap button to release it; for now release is via the runbook's revoke method.

If you see an URGENT message that says the burn-throttle runbook itself is being flagged — that's the self-attribution case. It's the one alert you should not ignore, because it means either the runbook has a bug producing too many LLM calls of its own, or attribution is being mis-applied to legitimate runbook work. Either way you need to look.

## How we know it works

Twenty-two new tests cover: every runbook outcome, the gate's stateful behavior (install, expire, revoke, capability-token verification, anti-replay), the three-layer self-attribution guard, the URGENT escalation alert (the second-pass reviewer fix), and the alert text shape for known components, scheduled jobs, and hooks.

The previous phase-one tests (twenty-one of them) still pass — one assertion updated to reflect the gate is no longer a no-op (it now reports "no-throttle-installed" instead of "phase-1-noop" when no throttle is active).

The phase-two and phase-three test suites are untouched and pass.

## What's next

Phase five upgrades the Telegram alert from plain text to interactive buttons — tap to release the throttle, tap to mark as "this is fine, snooze for a day." The buttons are signed and bound to your user ID so an unauthorised chat cannot trigger them, which was one of the critical findings in the audit.

Phase six adds the five-minute verification step — after a throttle goes in, the runbook re-samples the telemetry to confirm the rate actually dropped, then sends a follow-up with the before-and-after numbers.
