# Console sign-in gives the same short-lived pass as the PIN unlock (ships dark)

## What this is

There are two ways to sign in to your agent's dashboard: typing your PIN, and tapping a one-time sign-in from your paired phone (the "console ticket"). A recent feature (SEC-002b, still switched off) changed the PIN unlock so your browser gets a **short-lived, revocable pass** instead of the permanent master key. But the phone-tap sign-in was missed — it kept handing back the permanent master key even when the new feature was on. That's a second door that skips the safer model.

## What changes

When the dashboard scoped-session feature is enabled, the phone-tap console sign-in now hands back the **same short-lived pass** (a `dst_` session token) that the PIN unlock does — not the permanent key. So both sign-in paths behave the same way, and neither leaves a permanent key sitting in your browser.

Ships **dark**: with the feature off (the default today), the console sign-in returns the master token exactly as before — byte-for-byte identical. Only when the feature is later switched on (after its full live dashboard test) does this path start handing out the short-lived pass.

## Why it's safe

- It's a straight mirror of what the PIN unlock already does — same token store, same expiry, same revocation.
- It's gated behind the same single switch as the rest of the feature; off means no change at all.
- A revert fully undoes it.

## What you need to decide

Nothing. This is an internal completeness fix to a switched-off feature, closing a gap so that when the scoped-session feature is eventually turned on, *every* dashboard sign-in path — PIN and phone-tap alike — uses the short-lived, revocable pass instead of the permanent key.
