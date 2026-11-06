## What Changed

Replies on a busy machine no longer wait behind four separate faults in the Telegram outbox.

- The scan for late or out-of-order replies took 39 s on a real 652 MB store and blocked every send. It now reads a page in index order and looks only at replies written around the same time: under 100 ms a page on the same data (the first, cold page 419 ms), with identical answers on all 1117 rows.
- Node's 250 ms per-address connect window produced false `ETIMEDOUT` failures when the event loop paused. Bot API requests now get 5 s, through their own dispatcher.
- A config read that only ran out of time no longer refuses every send. Its budget is 10 s, and the last snapshot keeps its normal 30 s bound. A real refusal, or a change on disk, still revokes at once.
- Recovery runs every 30 s when the origin outbox owns it, and the wait between recovery starts for one message goes 30 s, 1 m, 2 m, 5 m, then 15 m. The legacy lane stays at 5 minutes.

No send path was added, and a message whose outcome is unknown still never retries by itself.

## What to Tell Your User

Your replies should stop getting stuck when this machine is busy. If a send does hit a brief problem, it's tried again within about a minute instead of up to 25 minutes later. You may see a few notices about older replies that arrived late, as those checks can now finish.

## Summary of New Capabilities

No new capability. Faster recovery of replies that hit a brief local fault, and a store scan that stays fast as history grows.

## Evidence

On a read-only backup of the Studio's live store: old query 39.4 s per page and 237 s for all rows, new scan 12 pages with a 419 ms maximum at load 25-50, 0 differences across 1117 rows. A separate process reproduced the exact `ETIMEDOUT` error with a 260 ms event-loop pause at 15 of 15, and got 0 failures with a 1500 ms pause at the new window. Spec: `docs/specs/telegram-origin-store-stall.md`.
