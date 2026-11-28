# Side effects of optional relay reconnect

A caller-started supervisor opens one verified relay session at a time and rereads the local holder's lease before opening and after connecting. A stale, missing or differently scoped lease stops the run.

- Interrupted sessions retry after 250 milliseconds up to four seconds of backoff. Six unsuccessful or short-lived attempts end the run. A session lasting 30 seconds resets the short-lived attempt count.
- Stop cancels backoff and stops any active session. Each completed attempt waits for socket closure before another begins. The verified connection factory must honor the supplied cancellation and enforce relay identity.
- This component and its timing policy remain dormant. It installs no startup hook, listener, production configuration or default. Direct access is independent.
- The fixture uses loopback HTTP/2 to verify renewed epochs and stop. Reverting requires no migration.

## Class-Closure Declaration

- `unbounded-self-action`: closure guard. The caller starts and stops the supervisor. A retry budget and increasing delay bound short-lived failures, and every attempt rechecks current lease authority.

Independent rereview concurred with actual-close fencing, the retry budget, cancellation, and stale-epoch refusal.
