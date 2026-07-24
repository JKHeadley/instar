# Side-effects review — throttle episode narration and subscription drift UI

## Scope

This follow-up changes two user-facing read/narration seams. Burn-throttle monitoring now reports state transitions instead of every detector tick, and the Subscriptions dashboard treats credential identity drift as stronger evidence than stale enrollment status.

## Behavioral change

For each attribution key, the burn runbook opens one in-memory episode when it installs a bounded throttle. Further signals during that episode are suppressed without reinstalling or extending the throttle. Automatic expiry emits one closing notice, followed by a 15-minute notification cooldown before the same key may open another episode.

Subscription account cards and account-by-machine cells now derive their displayed status from credential identity evidence first. An `identityDrifted` account, or one whose repair state requires an owner re-login, renders as “Needs sign-in” even if its enrollment record still says `active`; the matrix supplies the existing Sign in action.

## Over-block and under-block

The notification cooldown can hide a genuinely new burn signal arriving within 15 minutes of expiry. It cannot extend the throttle or block LLM work: it only suppresses narration and reinstallation during that settling window. Process restart clears episode memory, so a surviving burn may open one fresh episode after restart; the state is intentionally process-local, matching the throttle itself.

The dashboard may show Needs sign-in while an automatic repair is planned or running. That is conservative and reversible on the next healthy pool read; it avoids presenting an identity-incoherent credential as usable.

## Signal and authority

The detector remains signal-only. `BurnThrottleRunbook` remains the existing bounded authority and `LlmRateGate` remains the actuator. The new episode latch narrows repeated authority and messaging; it creates no new blocking surface. Dashboard logic is display-only and consumes post-#1465 API evidence without mutating account state.

## Interactions and settling

- Episode identity is the attribution key, matching the gate key and preventing cross-component suppression.
- A timer is tied to the installed throttle's actual expiry and is unref'd so it cannot keep the process alive.
- Duplicate detector ticks return an auditable `throttle-suppressed-episode` outcome while producing no Telegram message.
- The close notice states only that the bounded slowdown ended; it does not claim the underlying burn disappeared.
- Matrix precedence retains offline, held, pending, and broken states; identity drift only replaces a falsely healthy active cell with the existing re-login path.

## Multi-machine posture

Burn episodes and throttles are machine-local by design. Subscription pool-scope rows retain their machine identity, and the renderer evaluates drift independently for each reachable account-machine row. Offline machines remain unknown rather than inheriting a drift or healthy judgment from another machine.

## 6b. Operator-surface quality

The grid continues to lead with its primary action: a drifted cell says “Needs sign-in” and presents the existing Sign in button in place. Account cards use the same plain-language health phrase. No repair enum, drift flag, account identifier, credential location, or other raw internal becomes primary content. This change adds no destructive action; the reversible sign-in action remains visually primary. The wording is short and the existing responsive matrix/card layout remains readable at phone width.

## Verification and rollback

Regression tests cover same-second triple signals, exactly one open and one automatic close notice, cooldown suppression, later episode reopening, drift override on account cards, and an actionable needs-sign-in matrix cell. The broader burn Phase 4–6 and Subscriptions renderer/controller suites pass, along with the full lint lane.

Rollback is a code revert. No schema or persistent-state migration is introduced.
