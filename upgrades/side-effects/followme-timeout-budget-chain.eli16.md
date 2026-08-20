# Plain-English overview — why "Set up" said "Request timeout"

## What you were trying to do

On the dashboard's Subscriptions page there's a grid: your accounts down the side, your machines across the top. An empty cell means "this account isn't signed in on that machine yet," and tapping **Set up** is supposed to run the whole sign-in for you without leaving the page.

You tapped Set up on a cell for your Laptop and got **"Couldn't start: Request timeout."** Nothing else. No hint about whether anything had started over there, and no way to tell whether trying again was safe.

## What was actually happening

A single tap on that button sets off a chain of four nested waits. Think of them as nested stopwatches — each one has to outlast everything happening inside it:

1. The **browser's request** to the machine serving your dashboard.
2. That machine **delivering permission** to the target machine, then **calling it**.
3. The **target machine's own request handler**.
4. The target machine **actually launching the sign-in** and reading the code off the screen.

For this to work, the outermost stopwatch has to be the longest. It was the **shortest**.

The two outer waits had never been given their own limits, so they quietly used the system-wide default of **30 seconds**. The call between machines was hard-coded to **40**. And the innermost step — the one doing the real work — was set to **180 seconds**, deliberately, because a remote machine talking to a login provider is genuinely slow.

So the outermost stopwatch stopped at 30 seconds while the real work was still legitimately running, with 150 seconds of its allowance left. The error you saw wasn't the sign-in failing. It was the wrapper giving up on a sign-in that was still going.

Worse: the code underneath already knew how to explain itself. It has real answers ready — "the login didn't start, try again," "I couldn't work out which account this is," "one's already running, here it is." The 30-second wrapper fired first and threw all of that away, replacing it with two useless words.

## Why your Laptop hit it and the others didn't

Your machines talk to each other over several possible routes. The Laptop is currently the only one without a direct one, so its traffic takes a slower path. That's enough to push a normal sign-in past 30 seconds. Your other machines usually squeak under the limit — which is exactly why this looked like "the Laptop is broken" rather than "this button is broken."

## What already existed, and what's new

**Already existed:** the ability to give a specific request a longer allowance. Three other parts of the system had already hit this exact problem and been fixed one at a time — sending messages, a big data-comparison job, and moving a conversation between machines. Each fix was its own hardcoded number.

**That's why it happened again.** Three separate patches meant a newly-added nested request had nothing to inherit. It defaulted to 30 seconds like everything else, and nobody noticed the thing it was wrapping had been given 180.

**What's new:** instead of adding a fourth hardcoded number, all four waits in this chain are now calculated from the single setting you already control — the one that says how long a remote machine gets to start a login. Turn that up and every wait above it grows to match. There is no longer a number anyone can change in isolation to break the ordering.

Plus a test that fails the build if the ordering is ever inverted again, checked across four different settings including yours.

## What I found beyond what you reported

Rather than patch the button you pressed, I checked every cross-machine call in this area for the same mistake. **Three had it**, not one:

- starting the sign-in (what you hit)
- **pasting your code back**
- cancelling

The middle one matters more than the one you reported. Your verification code is single-use. A timeout there would leave you genuinely unable to tell whether the code had been spent — retry and it might be rejected as already-used, or might work, with no way to know which. Had I fixed only what you reported, you'd have walked straight into that one step later, holding a code of unknown status.

## Something I checked and did NOT change

I initially believed retrying a timed-out sign-in could start a second one on the far machine, and told you I'd fix it. I was wrong, and I checked before writing code. The target machine already refuses to start a second sign-in when one is live — it hands back the existing one instead. That protection lives on the receiving end rather than the sending end, which is why it wasn't obvious, but it works for every machine.

So retrying was always safe. I dropped that change rather than adding a redundant cross-machine lookup into the very path being fixed.

## The safeguards, in plain terms

- **Nothing gets less time than before.** Every limit moved up. No request that used to succeed can now be cut short.
- **The system still can't hang forever.** The inner limits are unchanged and still fire first, so a genuinely stuck machine still gets cut off — just after the real work has had its fair chance, not before.
- **A stuck machine is noticed later than it used to be.** At your 180-second setting, a wedged peer now takes up to ~4 minutes to surface instead of 30 seconds. That's the deliberate trade: the old behaviour "noticed" it fast by declaring every slow-but-healthy sign-in dead.
- **If your machines disagree about the setting, it fails safe.** If the machine serving your dashboard has a shorter allowance than the one doing the login, you get the honest "couldn't reach that machine — try again," never a false success. And retrying is safe, per above.
- **Nothing is stored, so nothing needs cleaning up.** Undoing this is deleting the change and restarting.

## What you actually need to decide

**Nothing about this fix** — it has no options and no rollout choice.

Two things do want a decision from you, both separate from this change:

1. **The duplicate Codex row.** Your Laptop registered `justin@sagemindai.io` under its own internal name back in August, while your other two machines share one. Same subscription, two records, so the grid honestly draws two rows. The repair is re-registering the Laptop's copy under the shared name. Until then, **don't tap Set up on the Laptop cell of the second Codex row** — that cell looks empty but isn't, and tapping it would create a *third* registration.
2. **If you ever change the remote sign-in allowance, set it on every machine.** Mismatched settings still fail safely, just less gracefully than they need to.
